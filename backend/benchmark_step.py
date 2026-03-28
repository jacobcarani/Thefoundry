import math
from pathlib import Path


def generate_cantilever_step(
    output_path: Path,
    length_mm: float = 120.0,
    width_mm: float = 20.0,
    height_mm: float = 10.0,
) -> dict:
    import gmsh

    output_path.parent.mkdir(parents=True, exist_ok=True)

    if gmsh.isInitialized():
        gmsh.finalize()

    gmsh.initialize()
    gmsh.option.setNumber("General.Verbosity", 0)
    try:
        gmsh.model.add("cantilever_benchmark")
        gmsh.model.occ.addBox(0.0, -width_mm / 2.0, -height_mm / 2.0, length_mm, width_mm, height_mm)
        gmsh.model.occ.synchronize()
        gmsh.write(output_path.as_posix())
    finally:
        gmsh.finalize()

    return {
        "length_mm": float(length_mm),
        "width_mm": float(width_mm),
        "height_mm": float(height_mm),
        "fixed_face_center": [0.0, 0.0, 0.0],
        "load_face_center": [float(length_mm), 0.0, 0.0],
        "load_face_area_mm2": float(width_mm * height_mm),
    }


def cantilever_analytical_max_stress_pa(
    force_n: float,
    length_mm: float,
    width_mm: float,
    height_mm: float,
) -> float:
    # Classic Euler-Bernoulli cantilever result: sigma_max = M*c / I
    # M = F*L, c = h/2, I = b*h^3/12
    length_m = float(length_mm) / 1000.0
    width_m = float(width_mm) / 1000.0
    height_m = float(height_mm) / 1000.0

    moment = float(force_n) * length_m
    c = height_m / 2.0
    inertia = width_m * (height_m ** 3) / 12.0

    if inertia <= 1e-16:
        return 0.0

    return abs(moment * c / inertia)


def cantilever_force_payload(metadata: dict, force_n: float) -> list:
    return [
        {
            "magnitude": float(force_n),
            "direction": [0.0, 0.0, -1.0],
            "region_id": 0,
            "paintedArea": float(metadata["load_face_area_mm2"]),
            "centroid": list(metadata["load_face_center"]),
        }
    ]
