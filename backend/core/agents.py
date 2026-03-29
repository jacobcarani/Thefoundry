import json
import os
import sqlite3
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any, TypedDict

import numpy as np

from .pipeline import _get_material_properties, _normalize_vector, run_fenicsx_simulation

try:
    from langgraph.graph import END, StateGraph
except Exception as exc:  # pragma: no cover
    StateGraph = None
    END = "END"
    _LANGGRAPH_IMPORT_ERROR = str(exc)
else:
    _LANGGRAPH_IMPORT_ERROR = ""


BASE_DIR = Path(__file__).resolve().parent.parent
UPLOAD_DIR = BASE_DIR / "uploads"
MODELS_DIR = BASE_DIR / "models"
MEMORY_DB_PATH = MODELS_DIR / "foundry_memory.db"

MATERIAL_YIELD_STRENGTH_MPA = {
    "6061-t6 aluminum": 276.0,
    "7075-t6 aluminum": 503.0,
    "304 stainless steel": 215.0,
    "mild steel": 250.0,
    "titanium grade 5": 880.0,
    "pla": 37.0,
    "petg": 50.0,
}

_MATERIAL_ALIASES = {
    "aluminum 6061": "6061-t6 aluminum",
    "6061 aluminum": "6061-t6 aluminum",
    "al 6061": "6061-t6 aluminum",
    "7075 aluminum": "7075-t6 aluminum",
    "aluminum 7075": "7075-t6 aluminum",
    "ss304": "304 stainless steel",
    "stainless 304": "304 stainless steel",
    "steel": "mild steel",
    "grade 5 titanium": "titanium grade 5",
    "ti-6al-4v": "titanium grade 5",
}


class PipelineState(TypedDict, total=False):
    session_id: str
    stl_filename: str
    forces: list[dict[str, Any]]
    painted_faces: list[dict[str, Any]]
    resolution: str
    part_context: dict[str, Any]

    geometry_analysis: dict[str, Any]
    boundary_conditions: dict[str, Any]
    simulation_result: dict[str, Any]
    failure_report: dict[str, Any]

    iteration_history: list[dict[str, Any]]
    iteration_number: int
    swarm_specialist_outputs: list[dict[str, Any]]
    redesign_recommendations: list[dict[str, Any]]


def _normalize_material_name(value: str) -> str:
    text = " ".join(str(value or "").strip().lower().replace("_", " ").split())
    return text


def _lookup_yield_strength_mpa(material_text: str, part_description: str = "") -> tuple[str, float | None]:
    normalized_material = _normalize_material_name(material_text)
    resolved_key = _MATERIAL_ALIASES.get(normalized_material, normalized_material)

    if resolved_key in MATERIAL_YIELD_STRENGTH_MPA:
        return resolved_key, float(MATERIAL_YIELD_STRENGTH_MPA[resolved_key])

    combined = _normalize_material_name(f"{material_text} {part_description}")
    for key in MATERIAL_YIELD_STRENGTH_MPA:
        if key in combined:
            return key, float(MATERIAL_YIELD_STRENGTH_MPA[key])

    for alias, canonical in _MATERIAL_ALIASES.items():
        if alias in combined and canonical in MATERIAL_YIELD_STRENGTH_MPA:
            return canonical, float(MATERIAL_YIELD_STRENGTH_MPA[canonical])

    return resolved_key or "unknown", None


@dataclass
class MemoryAgentStore:
    db_path: Path

    def __post_init__(self) -> None:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._ensure_schema()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _ensure_schema(self) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS iterations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    iteration_number INTEGER NOT NULL,
                    stl_filename TEXT NOT NULL,
                    forces_json TEXT NOT NULL,
                    simulation_result_json TEXT NOT NULL,
                    redesign_recommendations_json TEXT NOT NULL,
                    created_utc TEXT NOT NULL
                )
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_iterations_session ON iterations(session_id, iteration_number)"
            )

    def load_iterations(self, session_id: str) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT iteration_number, stl_filename, forces_json, simulation_result_json,
                       redesign_recommendations_json, created_utc
                FROM iterations
                WHERE session_id = ?
                ORDER BY iteration_number ASC
                """,
                (session_id,),
            ).fetchall()

        history: list[dict[str, Any]] = []
        for row in rows:
            history.append(
                {
                    "iteration_number": int(row["iteration_number"]),
                    "stl_filename": row["stl_filename"],
                    "forces": json.loads(row["forces_json"]),
                    "simulation_result": json.loads(row["simulation_result_json"]),
                    "redesign_recommendations": json.loads(row["redesign_recommendations_json"]),
                    "created_utc": row["created_utc"],
                }
            )
        return history

    def save_iteration(
        self,
        session_id: str,
        iteration_number: int,
        stl_filename: str,
        forces: list[dict[str, Any]],
        simulation_result: dict[str, Any],
        redesign_recommendations: list[dict[str, Any]],
    ) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO iterations (
                    session_id, iteration_number, stl_filename,
                    forces_json, simulation_result_json, redesign_recommendations_json, created_utc
                ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
                """,
                (
                    session_id,
                    int(iteration_number),
                    stl_filename,
                    json.dumps(forces),
                    json.dumps(simulation_result),
                    json.dumps(redesign_recommendations),
                ),
            )


def _convex_hull_2d(points_2d: np.ndarray) -> np.ndarray:
    if len(points_2d) <= 1:
        return points_2d

    pts = np.unique(points_2d, axis=0)
    if len(pts) <= 2:
        return pts

    pts = pts[np.lexsort((pts[:, 1], pts[:, 0]))]

    def cross(o: np.ndarray, a: np.ndarray, b: np.ndarray) -> float:
        return float((a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]))

    lower: list[np.ndarray] = []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)

    upper: list[np.ndarray] = []
    for p in pts[::-1]:
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)

    return np.array(lower[:-1] + upper[:-1], dtype=float)


def _polygon_area_2d(poly: np.ndarray) -> float:
    if len(poly) < 3:
        return 0.0
    x = poly[:, 0]
    y = poly[:, 1]
    return float(0.5 * abs(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))))


def _estimate_min_cross_section_area(verts: np.ndarray, bins: int = 16) -> float:
    if verts.size == 0:
        return 0.0

    min_area = float("inf")
    for axis in range(3):
        coords = verts[:, axis]
        cmin = float(np.min(coords))
        cmax = float(np.max(coords))
        if cmax - cmin <= 1e-9:
            continue

        edges = np.linspace(cmin, cmax, bins + 1)
        uv_axes = [a for a in (0, 1, 2) if a != axis]

        for i in range(bins):
            left = edges[i]
            right = edges[i + 1]
            mask = (coords >= left) & (coords <= right)
            slice_pts = verts[mask][:, uv_axes]
            if len(slice_pts) < 12:
                continue
            hull = _convex_hull_2d(slice_pts)
            area = _polygon_area_2d(hull)
            if area > 1e-9:
                min_area = min(min_area, area)

    if not np.isfinite(min_area):
        return 0.0
    return float(min_area)


def _detect_thin_wall_regions(dims: np.ndarray) -> list[dict[str, Any]]:
    labels = ["x", "y", "z"]
    dmax = float(np.max(dims)) if dims.size else 0.0
    regions: list[dict[str, Any]] = []

    for i, thickness in enumerate(dims.tolist()):
        t = float(thickness)
        if dmax <= 1e-9:
            continue
        ratio = t / dmax
        if ratio <= 0.2:
            severity = "high" if ratio <= 0.1 else "medium"
            regions.append(
                {
                    "region": f"global_{labels[i]}_oriented_wall",
                    "minimum_thickness_mm": round(t, 4),
                    "relative_thickness_ratio": round(ratio, 4),
                    "severity": severity,
                }
            )

    return regions


def _detect_sharp_interior_corners(mesh: Any, max_items: int = 8) -> list[dict[str, Any]]:
    try:
        face_normals = np.asarray(mesh.face_normals, dtype=float)
        adjacency = np.asarray(mesh.face_adjacency, dtype=int)
        adjacency_edges = np.asarray(mesh.face_adjacency_edges, dtype=int)
        verts = np.asarray(mesh.vertices, dtype=float)
    except Exception:
        return []

    if len(adjacency) == 0 or len(face_normals) == 0:
        return []

    corners: list[dict[str, Any]] = []
    for i, pair in enumerate(adjacency):
        n1 = face_normals[pair[0]]
        n2 = face_normals[pair[1]]
        dot = float(np.clip(np.dot(n1, n2), -1.0, 1.0))
        angle_deg = float(np.degrees(np.arccos(dot)))
        if angle_deg < 135.0:
            continue

        e = adjacency_edges[i]
        p0 = verts[e[0]]
        p1 = verts[e[1]]
        edge_len = float(np.linalg.norm(p1 - p0))
        center = ((p0 + p1) * 0.5).tolist()
        estimated_radius = max(edge_len * 0.5, 0.05)
        corners.append(
            {
                "location": [float(v) for v in center],
                "angle_deg": round(angle_deg, 2),
                "estimated_fillet_radius_mm": round(float(estimated_radius), 4),
            }
        )

    corners.sort(key=lambda c: c["angle_deg"], reverse=True)
    return corners[:max_items]


def _projection_void_diameter_mm(verts: np.ndarray, axis: int, dims: np.ndarray) -> float | None:
    uv_axes = [a for a in (0, 1, 2) if a != axis]
    uv = verts[:, uv_axes]
    if len(uv) < 60:
        return None

    uv_min = np.min(uv, axis=0)
    uv_max = np.max(uv, axis=0)
    span = uv_max - uv_min
    if np.any(span <= 1e-9):
        return None

    grid = 72
    normalized = (uv - uv_min) / span
    idx = np.clip((normalized * (grid - 1)).astype(int), 0, grid - 1)
    occ = np.zeros((grid, grid), dtype=np.uint8)
    occ[idx[:, 0], idx[:, 1]] = 1

    empty = occ == 0
    empty[:3, :] = False
    empty[-3:, :] = False
    empty[:, :3] = False
    empty[:, -3:] = False

    # Keep only enclosed empty cells by removing ones touching borders.
    visited = np.zeros_like(empty, dtype=bool)
    components: list[int] = []
    for i in range(3, grid - 3):
        for j in range(3, grid - 3):
            if not empty[i, j] or visited[i, j]:
                continue

            stack = [(i, j)]
            visited[i, j] = True
            comp = []
            touches = False
            while stack:
                x, y = stack.pop()
                comp.append((x, y))
                if x <= 3 or x >= grid - 4 or y <= 3 or y >= grid - 4:
                    touches = True
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx = x + dx
                    ny = y + dy
                    if not (0 <= nx < grid and 0 <= ny < grid):
                        continue
                    if visited[nx, ny] or not empty[nx, ny]:
                        continue
                    visited[nx, ny] = True
                    stack.append((nx, ny))

            if not touches and len(comp) >= 12:
                components.append(len(comp))

    if not components:
        return None

    largest = float(max(components))
    cell_area = float((span[0] / grid) * (span[1] / grid))
    void_area = largest * cell_area
    diameter = 2.0 * np.sqrt(max(void_area, 0.0) / np.pi)
    if diameter <= 0.25 or diameter >= max(float(dims[uv_axes[0]]), float(dims[uv_axes[1]])):
        return None
    return float(diameter)


def _detect_through_holes(verts: np.ndarray, dims: np.ndarray) -> list[dict[str, Any]]:
    axes = ["x", "y", "z"]
    holes: list[dict[str, Any]] = []
    for axis in range(3):
        diameter = _projection_void_diameter_mm(verts, axis=axis, dims=dims)
        if diameter is None:
            continue
        holes.append(
            {
                "axis": axes[axis],
                "diameter_mm": round(diameter, 4),
            }
        )
    return holes


def _stl_mesh_stats(stl_path: Path) -> dict[str, Any]:
    triangle_count = 0
    bbox_min = [0.0, 0.0, 0.0]
    bbox_max = [0.0, 0.0, 0.0]
    dims = [0.0, 0.0, 0.0]
    estimated_volume = 0.0
    thin_wall_regions: list[dict[str, Any]] = []
    sharp_interior_corners: list[dict[str, Any]] = []
    through_holes: list[dict[str, Any]] = []
    estimated_min_cross_sectional_area = 0.0

    try:
        import trimesh

        mesh = trimesh.load_mesh(stl_path.as_posix(), force="mesh")
        if mesh is not None and hasattr(mesh, "vertices"):
            verts = np.asarray(mesh.vertices, dtype=float)
            if len(verts):
                bbox_min = np.min(verts, axis=0).tolist()
                bbox_max = np.max(verts, axis=0).tolist()
                dims = (np.array(bbox_max) - np.array(bbox_min)).tolist()
                dims_np = np.asarray(dims, dtype=float)
                thin_wall_regions = _detect_thin_wall_regions(dims_np)
                through_holes = _detect_through_holes(verts, dims_np)
                estimated_min_cross_sectional_area = _estimate_min_cross_section_area(verts)
            triangle_count = int(len(getattr(mesh, "faces", [])))
            sharp_interior_corners = _detect_sharp_interior_corners(mesh)

            vol = float(abs(getattr(mesh, "volume", 0.0)))
            if vol > 1e-9:
                estimated_volume = vol
            else:
                estimated_volume = float(max(dims[0] * dims[1] * dims[2] * 0.35, 0.0))
    except Exception:
        # Lightweight fallback for environments without trimesh.
        text = stl_path.read_text(encoding="utf-8", errors="ignore").lower()
        triangle_count = text.count("facet normal")

    return {
        "triangle_count": int(triangle_count),
        "bbox_min": [float(v) for v in bbox_min],
        "bbox_max": [float(v) for v in bbox_max],
        "bbox_dimensions": [float(v) for v in dims],
        "thin_wall_regions": thin_wall_regions,
        "sharp_interior_corners": sharp_interior_corners,
        "through_holes": through_holes,
        "estimated_min_cross_sectional_area": float(estimated_min_cross_sectional_area),
        "estimated_volume": float(estimated_volume),
    }


def _risk_features_from_dims(dims: list[float]) -> list[dict[str, Any]]:
    dims_arr = np.array([max(float(v), 1e-9) for v in dims], dtype=float)
    dmin = float(np.min(dims_arr))
    dmax = float(np.max(dims_arr))
    slenderness = dmax / dmin if dmin > 1e-9 else 0.0

    risks: list[dict[str, Any]] = []
    if slenderness >= 8.0:
        risks.append(
            {
                "feature": "slender_member",
                "severity": "high",
                "detail": f"High aspect ratio detected ({slenderness:.2f}).",
            }
        )

    if dmin < 2.0:
        risks.append(
            {
                "feature": "thin_section",
                "severity": "high",
                "detail": f"Minimum thickness is very small ({dmin:.3f}).",
            }
        )
    elif dmin < 5.0:
        risks.append(
            {
                "feature": "thin_section",
                "severity": "medium",
                "detail": f"Potentially thin region detected ({dmin:.3f}).",
            }
        )

    if not risks:
        risks.append(
            {
                "feature": "geometry_general",
                "severity": "low",
                "detail": "No obvious high-risk geometric feature detected by heuristic checks.",
            }
        )

    return risks


def geometry_agent(state: PipelineState) -> PipelineState:
    stl_filename = str(state.get("stl_filename", "")).strip()
    stl_path = UPLOAD_DIR / stl_filename
    if not stl_filename or not stl_path.exists():
        raise RuntimeError("GeometryAgent: STL file not found")

    stats = _stl_mesh_stats(stl_path)
    risks = _risk_features_from_dims(stats.get("bbox_dimensions", [0.0, 0.0, 0.0]))

    state["geometry_analysis"] = {
        **stats,
        "risk_features": risks,
        "detected_features": {
            "thin_wall_regions": list(stats.get("thin_wall_regions", [])),
            "sharp_interior_corners": list(stats.get("sharp_interior_corners", [])),
            "through_holes": list(stats.get("through_holes", [])),
            "bounding_box_dimensions_mm": list(stats.get("bbox_dimensions", [0.0, 0.0, 0.0])),
            "estimated_min_cross_sectional_area_mm2": float(stats.get("estimated_min_cross_sectional_area", 0.0)),
        },
    }
    return state


def boundary_condition_agent(state: PipelineState) -> PipelineState:
    forces = list(state.get("forces", []))
    painted_faces = list(state.get("painted_faces", []))

    if not painted_faces:
        painted_faces = [
            {
                "region_id": int(f.get("region_id", idx)),
                "normal": f.get("normal", [0.0, 0.0, 1.0]),
                "centroid": f.get("centroid", [0.0, 0.0, 0.0]),
                "paintedArea": float(f.get("paintedArea", f.get("area", 0.0))),
            }
            for idx, f in enumerate(forces)
        ]

    face_by_region = {int(face.get("region_id", idx)): face for idx, face in enumerate(painted_faces)}

    normalized_forces: list[dict[str, Any]] = []
    missing_regions: list[int] = []

    for idx, force in enumerate(forces):
        region_id = int(force.get("region_id", idx))
        face = face_by_region.get(region_id)
        if face is None:
            missing_regions.append(region_id)
            continue

        normalized_forces.append(
            {
                **force,
                "region_id": region_id,
                "direction": _normalize_vector(force.get("direction", [0.0, 0.0, -1.0])),
                "paintedArea": float(face.get("paintedArea", face.get("area", force.get("paintedArea", 0.0)))),
                "area": float(face.get("paintedArea", face.get("area", force.get("paintedArea", 0.0)))),
                "centroid": face.get("centroid", force.get("centroid", [0.0, 0.0, 0.0])),
                "normal": face.get("normal", force.get("normal", [0.0, 0.0, 1.0])),
            }
        )

    if missing_regions:
        raise RuntimeError(f"BoundaryConditionAgent: missing painted faces for regions {missing_regions}")

    state["boundary_conditions"] = {
        "forces": normalized_forces,
        "painted_faces": painted_faces,
        "validated": True,
    }
    return state


def simulation_agent(state: PipelineState) -> PipelineState:
    stl_filename = str(state.get("stl_filename", "")).strip()
    stl_path = UPLOAD_DIR / stl_filename
    if not stl_path.exists():
        model_path = MODELS_DIR / stl_filename
        if model_path.exists():
            stl_path = model_path
    if not stl_path.exists():
        raise RuntimeError("SimulationAgent: STL file not found")

    bc = state.get("boundary_conditions", {})
    result = run_fenicsx_simulation(
        stl_path=stl_path,
        forces=list(bc.get("forces", [])),
        resolution=str(state.get("resolution", "high")),
        part_context=dict(state.get("part_context", {})),
    )
    state["simulation_result"] = result
    return state


def _cluster_top_stress_zones(
    stress_points: list[dict[str, Any]],
    top_k: int = 3,
) -> list[dict[str, Any]]:
    if not stress_points:
        return []

    points = np.array([[float(p.get("x", 0.0)), float(p.get("y", 0.0)), float(p.get("z", 0.0))] for p in stress_points])
    stresses = np.array([float(p.get("stress", 0.0)) for p in stress_points])

    bbox_min = np.min(points, axis=0)
    bbox_max = np.max(points, axis=0)
    diag = float(np.linalg.norm(bbox_max - bbox_min))
    radius = max(diag * 0.08, 1e-6)

    sorted_idx = np.argsort(stresses)[::-1]
    used = np.zeros(len(points), dtype=bool)
    zones: list[dict[str, Any]] = []

    for idx in sorted_idx:
        if used[idx]:
            continue

        center = points[idx]
        dists = np.linalg.norm(points - center, axis=1)
        cluster_mask = dists <= radius
        if np.sum(cluster_mask) == 0:
            continue

        used = used | cluster_mask
        cluster_stresses = stresses[cluster_mask]
        cluster_points = points[cluster_mask]

        zones.append(
            {
                "center": [float(v) for v in np.mean(cluster_points, axis=0)],
                "max_stress": float(np.max(cluster_stresses)),
                "avg_stress": float(np.mean(cluster_stresses)),
                "point_count": int(np.sum(cluster_mask)),
            }
        )

        if len(zones) >= top_k:
            break

    return zones


def analysis_agent(state: PipelineState) -> PipelineState:
    result = dict(state.get("simulation_result", {}))
    stress_points = list(result.get("stress_points", []))

    part_context = dict(state.get("part_context", {}))
    material = str(part_context.get("material", "aluminum"))
    part_description = str(part_context.get("part_purpose", ""))
    resolved_material, yield_strength_mpa = _lookup_yield_strength_mpa(material, part_description)

    if yield_strength_mpa is None:
        mat = _get_material_properties(material)
        yield_strength = float(mat.get("yield", 2.75e8))
        yield_strength_mpa = yield_strength / 1_000_000.0
    else:
        yield_strength = float(yield_strength_mpa * 1_000_000.0)

    zones = _cluster_top_stress_zones(stress_points, top_k=3)
    failure_zones: list[dict[str, Any]] = []

    for i, zone in enumerate(zones, start=1):
        local_max = float(zone["max_stress"])
        local_sf = float("inf") if local_max <= 1e-9 else float(yield_strength / local_max)
        passed = local_sf >= 2.0
        failure_margin = max(0.0, 2.0 - local_sf)

        zone_report = {
            "zone_id": i,
            "center": zone["center"],
            "max_stress": local_max,
            "avg_stress": float(zone["avg_stress"]),
            "local_safety_factor": local_sf,
            "failed": (not passed),
            "failure_margin_to_sf2": failure_margin,
        }
        if zone_report["failed"]:
            failure_zones.append(zone_report)
        zones[i - 1] = zone_report

    state["failure_report"] = {
        "material": material,
        "resolved_material": resolved_material,
        "yield_strength": yield_strength,
        "yield_strength_mpa": float(yield_strength_mpa),
        "zones": zones,
        "failed_zones": failure_zones,
        "failed_zone_count": len(failure_zones),
    }
    return state


def memory_agent(state: PipelineState) -> PipelineState:
    session_id = str(state.get("session_id", "")).strip() or str(uuid.uuid4())
    state["session_id"] = session_id

    store = MemoryAgentStore(MEMORY_DB_PATH)
    history = store.load_iterations(session_id)

    state["iteration_history"] = history
    state["iteration_number"] = len(history) + 1
    return state


def _extract_json_payload(text: str, opener: str, closer: str, default: str) -> str:
    raw = str(text or "").strip()
    start = raw.find(opener)
    end = raw.rfind(closer)
    if start != -1 and end != -1 and end >= start:
        return raw[start:end + 1]
    return default


def _parse_percent(value: Any, default: float = 0.0) -> float:
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value or "").strip().replace("%", "")
    try:
        return float(text)
    except Exception:
        return float(default)


def _normalize_specialist_name(value: str) -> str:
    text = " ".join(str(value or "").strip().lower().replace("_", " ").split())
    if text in {"geometry", "geometry specialist", "geometryspecialistagent"}:
        return "GEOMETRY"
    if text in {"material", "materials", "material specialist", "materialspecialistagent"}:
        return "MATERIAL"
    if text in {"load path", "loadpath", "load path specialist", "loadpathspecialistagent", "topology"}:
        return "LOAD PATH"
    return text.upper() if text else "UNKNOWN"


def _normalize_recommendation(
    item: dict[str, Any],
    default_specialist: str,
    rank: int | None = None,
    conflicts: str | None = None,
) -> dict[str, Any]:
    specialist = _normalize_specialist_name(str(item.get("specialist", default_specialist)))
    zone = str(item.get("zone", item.get("zone_description", ""))).strip() or "UNSPECIFIED ZONE"
    change = str(item.get("change", item.get("specific_change", ""))).strip() or "NO CHANGE SPECIFIED"
    pct = _parse_percent(item.get("predicted_improvement_percent", item.get("predicted_improvement", 0.0)), default=0.0)

    rec: dict[str, Any] = {
        "specialist": specialist,
        "zone": zone,
        "change": change,
        "predicted_improvement_percent": pct,
        "zone_description": zone,
        "specific_change": change,
        "expected_improvement": f"ESTIMATED {pct:.1f}% IMPROVEMENT",
    }
    if rank is not None:
        rec["rank"] = int(rank)
        rec["priority"] = int(rank)
    if conflicts is not None:
        rec["conflicts"] = str(conflicts)
    return rec


def _is_placeholder_recommendation(rec: dict[str, Any]) -> bool:
    zone = str(rec.get("zone", "")).strip().upper()
    change = str(rec.get("change", "")).strip().upper()
    return zone in {"", "UNSPECIFIED ZONE"} or change in {"", "NO CHANGE SPECIFIED"}


def _gemini_generate(prompt: str, api_key: str) -> str:
    if not api_key:
        return ""
    try:
        import google.generativeai as genai

        genai.configure(api_key=api_key)
        model = genai.GenerativeModel("gemini-2.5-flash")
        response = model.generate_content(prompt)
        return str(response.text or "")
    except Exception:
        return ""


def _specialist_fallback(specialist: str, failure_report: dict[str, Any]) -> dict[str, Any]:
    zones = list(failure_report.get("failed_zones", [])) or list(failure_report.get("zones", []))
    zone = zones[0] if zones else {}
    center = zone.get("center", [0.0, 0.0, 0.0])
    zone_text = f"ZONE NEAR ({float(center[0]):.2f}, {float(center[1]):.2f}, {float(center[2]):.2f})"

    if specialist == "GEOMETRY":
        return _normalize_recommendation(
            {
                "specialist": specialist,
                "zone": zone_text,
                "change": "INCREASE LOCAL FILLET FROM 1.5MM TO 4.0MM AND THICKEN ADJACENT WALL BY 0.8MM.",
                "predicted_improvement_percent": 18.0,
            },
            default_specialist=specialist,
        )
    if specialist == "MATERIAL":
        return _normalize_recommendation(
            {
                "specialist": specialist,
                "zone": "BASE MATERIAL SELECTION",
                "change": "SWITCH FROM 6061-T6 ALUMINUM TO 7075-T6 ALUMINUM FOR HIGHER YIELD STRENGTH.",
                "predicted_improvement_percent": 22.0,
            },
            default_specialist=specialist,
        )
    return _normalize_recommendation(
        {
            "specialist": "LOAD PATH",
            "zone": zone_text,
            "change": "ADD A 3.0MM RIB TO CONNECT LOAD INPUT TO THE CLOSEST SUPPORT AND SHORTEN FORCE PATH.",
            "predicted_improvement_percent": 16.0,
        },
        default_specialist="LOAD PATH",
    )


def _geometry_specialist_agent(failure_report: dict[str, Any], geometry_analysis: dict[str, Any], api_key: str) -> dict[str, Any]:
    prompt = f"""
You are a geometric optimization specialist focused exclusively on shape modifications: fillets, wall thickness, ribs, bosses, and cross-sectional area.

FAILURE REPORT:
{json.dumps(failure_report, indent=2)}

GEOMETRY ANALYSIS:
{json.dumps(geometry_analysis, indent=2)}

Return exactly one recommendation as a JSON object with fields:
- specialist
- zone
- change
- predicted_improvement_percent

Do not include markdown or explanatory text.
"""
    text = _gemini_generate(prompt, api_key)
    try:
        payload = json.loads(_extract_json_payload(text, "{", "}", "{}"))
        if isinstance(payload, dict):
            rec = _normalize_recommendation(payload, default_specialist="GEOMETRY")
            if not _is_placeholder_recommendation(rec):
                return rec
    except Exception:
        pass
    return _specialist_fallback("GEOMETRY", failure_report)


def _material_specialist_agent(failure_report: dict[str, Any], part_context: dict[str, Any], api_key: str) -> dict[str, Any]:
    material = str(part_context.get("material", "unknown") or "unknown")
    part_description = str(part_context.get("part_purpose", "") or "")
    resolved_material, yield_strength_mpa = _lookup_yield_strength_mpa(material, part_description)
    if yield_strength_mpa is None:
        props = _get_material_properties(material)
        yield_strength_mpa = float(props.get("yield", 2.75e8)) / 1_000_000.0

    prompt = f"""
You are a materials engineer focused exclusively on whether the material selection is appropriate for this load case, and whether switching alloy grade or material family would solve the problem.

FAILURE REPORT:
{json.dumps(failure_report, indent=2)}

MATERIAL PROPERTIES:
{json.dumps({"material": material, "resolved_material": resolved_material, "yield_strength_mpa": yield_strength_mpa}, indent=2)}

Return exactly one recommendation as a JSON object with fields:
- specialist
- zone
- change
- predicted_improvement_percent

Do not include markdown or explanatory text.
"""
    text = _gemini_generate(prompt, api_key)
    try:
        payload = json.loads(_extract_json_payload(text, "{", "}", "{}"))
        if isinstance(payload, dict):
            rec = _normalize_recommendation(payload, default_specialist="MATERIAL")
            if not _is_placeholder_recommendation(rec):
                return rec
    except Exception:
        pass
    return _specialist_fallback("MATERIAL", failure_report)


def _load_path_specialist_agent(failure_report: dict[str, Any], stress_points: list[dict[str, Any]], api_key: str) -> dict[str, Any]:
    prompt = f"""
You are a structural topology specialist focused on how load is traveling through the part and whether the geometry is routing force efficiently.

FAILURE REPORT:
{json.dumps(failure_report, indent=2)}

FULL STRESS POINT DISTRIBUTION:
{json.dumps(stress_points, indent=2)}

Return exactly one recommendation as a JSON object with fields:
- specialist
- zone
- change
- predicted_improvement_percent

Do not include markdown or explanatory text.
"""
    text = _gemini_generate(prompt, api_key)
    try:
        payload = json.loads(_extract_json_payload(text, "{", "}", "{}"))
        if isinstance(payload, dict):
            rec = _normalize_recommendation(payload, default_specialist="LOAD PATH")
            if not _is_placeholder_recommendation(rec):
                return rec
    except Exception:
        pass
    return _specialist_fallback("LOAD PATH", failure_report)


def _run_parallel_specialists(
    geometry_analysis: dict[str, Any],
    failure_report: dict[str, Any],
    simulation_result: dict[str, Any],
    part_context: dict[str, Any],
    api_key: str,
) -> list[dict[str, Any]]:
    stress_points = list(simulation_result.get("stress_points", []))
    outputs: dict[str, dict[str, Any]] = {}

    with ThreadPoolExecutor(max_workers=3) as executor:
        futures = {
            "GEOMETRY": executor.submit(_geometry_specialist_agent, failure_report, geometry_analysis, api_key),
            "MATERIAL": executor.submit(_material_specialist_agent, failure_report, part_context, api_key),
            "LOAD PATH": executor.submit(_load_path_specialist_agent, failure_report, stress_points, api_key),
        }
        for key, future in futures.items():
            try:
                outputs[key] = future.result(timeout=120)
            except Exception:
                outputs[key] = _specialist_fallback(key, failure_report)

    ordered = [outputs.get("GEOMETRY"), outputs.get("MATERIAL"), outputs.get("LOAD PATH")]
    return [item for item in ordered if isinstance(item, dict)]


def _synthesis_agent(
    specialist_outputs: list[dict[str, Any]],
    history: list[dict[str, Any]],
    api_key: str,
) -> list[dict[str, Any]]:
    if len(specialist_outputs) < 3:
        return []

    prompt = f"""
You are a senior structural engineer reviewing three specialist recommendations.
Rank them by expected impact, identify if any contradict each other and explain why, and produce a final ordered list of three recommendations.

SPECIALIST RECOMMENDATIONS:
{json.dumps(specialist_outputs, indent=2)}

ITERATION HISTORY:
{json.dumps(history, indent=2)}

Return only a JSON array with exactly 3 objects.
Each object must include fields:
- specialist
- zone
- change
- predicted_improvement_percent
- rank
- conflicts

Do not include markdown or explanatory text.
"""

    text = _gemini_generate(prompt, api_key)
    try:
        payload = json.loads(_extract_json_payload(text, "[", "]", "[]"))
    except Exception:
        payload = []

    if not isinstance(payload, list):
        payload = []

    cleaned: list[dict[str, Any]] = []
    for idx, item in enumerate(payload[:3], start=1):
        if not isinstance(item, dict):
            continue
        rec = _normalize_recommendation(
            item,
            default_specialist=str(item.get("specialist", "GEOMETRY")),
            rank=int(item.get("rank", idx) or idx),
            conflicts=str(item.get("conflicts", "NONE")),
        )
        cleaned.append(rec)

    if len(cleaned) == 3:
        cleaned.sort(key=lambda r: int(r.get("rank", 99)))
        return cleaned

    fallback = sorted(
        [_normalize_recommendation(item, default_specialist=str(item.get("specialist", "UNKNOWN"))) for item in specialist_outputs],
        key=lambda rec: float(rec.get("predicted_improvement_percent", 0.0)),
        reverse=True,
    )[:3]
    for idx, rec in enumerate(fallback, start=1):
        rec["rank"] = idx
        rec["priority"] = idx
        rec["conflicts"] = "NONE"
    return fallback


def _fallback_recommendations(failure_report: dict[str, Any]) -> list[dict[str, Any]]:
    zones = list(failure_report.get("zones", []))[:3]
    if not zones:
        return [
            {
                "specialist": "GEOMETRY",
                "zone": "Global structure",
                "change": "Increase primary wall thickness from 3.0mm to 4.0mm.",
                "predicted_improvement_percent": 22.0,
                "priority": 1,
                "rank": 1,
                "conflicts": "NONE",
                "zone_description": "Global structure",
                "specific_change": "Increase primary wall thickness from 3.0mm to 4.0mm.",
                "expected_improvement": "Estimated 18-25% peak stress reduction by increasing section modulus in the main load path.",
            },
            {
                "specialist": "MATERIAL",
                "zone": "Force application interfaces",
                "change": "Increase local fillet radius from 1.5mm to 4.0mm at loaded corners.",
                "predicted_improvement_percent": 16.0,
                "priority": 2,
                "rank": 2,
                "conflicts": "NONE",
                "zone_description": "Force application interfaces",
                "specific_change": "Increase local fillet radius from 1.5mm to 4.0mm at loaded corners.",
                "expected_improvement": "Estimated 12-20% stress concentration reduction by reducing notch sensitivity.",
            },
            {
                "specialist": "LOAD PATH",
                "zone": "Load-bearing spans",
                "change": "Add one 3.0mm-thick rib across the dominant bending span.",
                "predicted_improvement_percent": 14.0,
                "priority": 3,
                "rank": 3,
                "conflicts": "NONE",
                "zone_description": "Load-bearing spans",
                "specific_change": "Add one 3.0mm-thick rib across the dominant bending span.",
                "expected_improvement": "Estimated 10-18% stress reduction from increased bending stiffness.",
            },
        ]

    recs: list[dict[str, Any]] = []
    for z in zones:
        center = z.get("center", [0.0, 0.0, 0.0])
        recs.append(
            {
                "specialist": "GEOMETRY" if len(recs) == 0 else ("MATERIAL" if len(recs) == 1 else "LOAD PATH"),
                "zone": f"Corner near ({center[0]:.2f}, {center[1]:.2f}, {center[2]:.2f})",
                "change": "Increase corner fillet radius from 1.0mm to 3.0mm and thicken adjacent wall from 2.5mm to 3.2mm.",
                "predicted_improvement_percent": 19.0,
                "priority": min(len(recs) + 1, 3),
                "rank": min(len(recs) + 1, 3),
                "conflicts": "NONE",
                "zone_description": f"Zone around ({center[0]:.2f}, {center[1]:.2f}, {center[2]:.2f})",
                "specific_change": "Increase corner fillet radius from 1.0mm to 3.0mm and thicken adjacent wall from 2.5mm to 3.2mm.",
                "expected_improvement": "Estimated 15-24% local stress reduction from reduced notch effect and increased local section.",
            }
        )

    while len(recs) < 3:
        recs.append(
            {
                "specialist": "LOAD PATH",
                "zone": "Secondary support region",
                "change": "Add a 2.5mm-thick rib tied into the nearest support and enlarge root fillet from 1.5mm to 3.5mm.",
                "predicted_improvement_percent": 13.0,
                "priority": min(len(recs) + 1, 3),
                "rank": min(len(recs) + 1, 3),
                "conflicts": "NONE",
                "zone_description": "Secondary support region",
                "specific_change": "Add a 2.5mm-thick rib tied into the nearest support and enlarge root fillet from 1.5mm to 3.5mm.",
                "expected_improvement": "Estimated 10-17% hotspot stress reduction by redistributing load path stiffness.",
            }
        )

    return recs[:3]


def redesign_agent(state: PipelineState) -> PipelineState:
    geometry_analysis = dict(state.get("geometry_analysis", {}))
    failure_report = dict(state.get("failure_report", {}))
    history = list(state.get("iteration_history", []))
    part_context = dict(state.get("part_context", {}))
    simulation_result = dict(state.get("simulation_result", {}))
    api_key = os.getenv("GEMINI_API_KEY", "")

    specialist_outputs = _run_parallel_specialists(
        geometry_analysis=geometry_analysis,
        failure_report=failure_report,
        simulation_result=simulation_result,
        part_context=part_context,
        api_key=api_key,
    )
    state["swarm_specialist_outputs"] = specialist_outputs

    recs = _synthesis_agent(
        specialist_outputs=specialist_outputs,
        history=history,
        api_key=api_key,
    )

    if len(recs) != 3:
        recs = _fallback_recommendations(failure_report)

    state["redesign_recommendations"] = recs[:3]

    # Save current iteration after full pipeline completion, including recommendations.
    store = MemoryAgentStore(MEMORY_DB_PATH)
    store.save_iteration(
        session_id=str(state.get("session_id", "")),
        iteration_number=int(state.get("iteration_number", 1)),
        stl_filename=str(state.get("stl_filename", "")),
        forces=list(state.get("forces", [])),
        simulation_result=dict(state.get("simulation_result", {})),
        redesign_recommendations=list(state.get("redesign_recommendations", [])),
    )
    return state


def build_agent_graph():
    if StateGraph is None:
        raise RuntimeError(f"LangGraph import failed: {_LANGGRAPH_IMPORT_ERROR}")

    graph = StateGraph(PipelineState)
    graph.add_node("GeometryAgent", geometry_agent)
    graph.add_node("BoundaryConditionAgent", boundary_condition_agent)
    graph.add_node("SimulationAgent", simulation_agent)
    graph.add_node("AnalysisAgent", analysis_agent)
    graph.add_node("MemoryAgent", memory_agent)
    graph.add_node("RedesignAgent", redesign_agent)

    graph.set_entry_point("GeometryAgent")
    graph.add_edge("GeometryAgent", "BoundaryConditionAgent")
    graph.add_edge("BoundaryConditionAgent", "SimulationAgent")
    graph.add_edge("SimulationAgent", "AnalysisAgent")
    graph.add_edge("AnalysisAgent", "MemoryAgent")
    graph.add_edge("MemoryAgent", "RedesignAgent")
    graph.add_edge("RedesignAgent", END)
    return graph.compile()


def run_agent_pipeline(
    stl_filename: str,
    forces: list[dict[str, Any]],
    resolution: str,
    part_context: dict[str, Any] | None,
    session_id: str,
    painted_faces: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    app = build_agent_graph()
    state: PipelineState = {
        "session_id": session_id,
        "stl_filename": stl_filename,
        "forces": forces,
        "painted_faces": painted_faces or [],
        "resolution": resolution,
        "part_context": part_context or {},
    }
    out: PipelineState = app.invoke(state)

    simulation_result = dict(out.get("simulation_result", {}))
    simulation_result["redesign_recommendations"] = list(out.get("redesign_recommendations", []))
    simulation_result["swarm_specialist_outputs"] = list(out.get("swarm_specialist_outputs", []))
    simulation_result["iteration_number"] = int(out.get("iteration_number", 1))
    simulation_result["failure_report"] = dict(out.get("failure_report", {}))
    simulation_result["geometry_analysis"] = dict(out.get("geometry_analysis", {}))
    return simulation_result
