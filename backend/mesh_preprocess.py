import json
import shutil
import subprocess
import sys
from pathlib import Path


def _run_gmsh_worker(mode: str, input_path: Path, output_path: Path, cfg: dict | None = None) -> None:
    payload = {
        "mode": mode,
        "input": input_path.as_posix(),
        "output": output_path.as_posix(),
        "cfg": cfg or {},
    }
    worker_code = r'''
import json
import sys
import gmsh

data = json.loads(sys.argv[1])
mode = data["mode"]
input_path = data["input"]
output_path = data["output"]
cfg = data.get("cfg", {})

gmsh.initialize()
try:
    gmsh.clear()
    gmsh.option.setNumber("Mesh.MeshSizeFromCurvature", 1)
    gmsh.option.setNumber("Mesh.Optimize", 1)
    gmsh.option.setNumber("Mesh.OptimizeNetgen", 1)
    gmsh.option.setNumber("Mesh.Algorithm", 6)

    if mode == "step_to_stl":
        gmsh.option.setNumber("Mesh.CharacteristicLengthMin", 0.8)
        gmsh.option.setNumber("Mesh.CharacteristicLengthMax", 2.5)
        gmsh.open(input_path)
        gmsh.model.mesh.generate(2)
        gmsh.write(output_path)
    elif mode == "refine_stl":
        gmsh.option.setNumber("Mesh.MeshSizeFromCurvatureNumPoints", float(cfg.get("curvature", 10)))
        gmsh.option.setNumber("Mesh.CharacteristicLengthMin", float(cfg.get("min_size", 1.5)))
        gmsh.option.setNumber("Mesh.CharacteristicLengthMax", float(cfg.get("max_size", 3.0)))
        gmsh.open(input_path)
        gmsh.model.mesh.generate(2)
        gmsh.write(output_path)
    else:
        raise RuntimeError(f"Unsupported gmsh worker mode: {mode}")
finally:
    gmsh.finalize()
'''
    subprocess.run(
        [sys.executable, "-c", worker_code, json.dumps(payload)],
        check=True,
        capture_output=True,
        text=True,
    )


def convert_step_to_stl(step_path: Path, stl_path: Path) -> None:
    _run_gmsh_worker("step_to_stl", step_path, stl_path)

    if not stl_path.exists() or stl_path.stat().st_size == 0:
        raise RuntimeError("STEP conversion failed: no STL output generated")


def triangle_count(stl_path: Path) -> int:
    try:
        import trimesh

        mesh = trimesh.load_mesh(stl_path.as_posix(), force="mesh")
        if mesh is None or not hasattr(mesh, "faces"):
            return 0
        return int(len(mesh.faces))
    except Exception:
        # Fallback for environments without trimesh or binary parser support.
        try:
            text = stl_path.read_text(encoding="utf-8", errors="ignore").lower()
            return text.count("facet normal")
        except Exception:
            return 0


def repair_mesh_with_pymeshfix(input_stl: Path, repaired_stl: Path) -> bool:
    try:
        from pymeshfix import clean_from_file

        clean_from_file(input_stl.as_posix(), repaired_stl.as_posix())
        return True
    except Exception:
        shutil.copyfile(input_stl, repaired_stl)
        return False


def refine_surface_with_gmsh(input_stl: Path, refined_stl: Path, resolution: str) -> bool:
    settings = {
        "low": {"min_size": 1.5, "max_size": 3.0, "curvature": 10},
        "high": {"min_size": 0.3, "max_size": 1.0, "curvature": 35},
    }
    cfg = settings.get(resolution, settings["low"])

    try:
        _run_gmsh_worker("refine_stl", input_stl, refined_stl, cfg)
        return refined_stl.exists() and refined_stl.stat().st_size > 0
    except Exception:
        shutil.copyfile(input_stl, refined_stl)
        return False


def preprocess_stl(uploaded_path: Path, resolution: str) -> dict:
    before_triangles = triangle_count(uploaded_path)

    repaired_path = uploaded_path.with_name(f"{uploaded_path.stem}_repaired{uploaded_path.suffix}")
    refined_path = uploaded_path.with_name(f"{uploaded_path.stem}_refined{uploaded_path.suffix}")

    repaired_ok = repair_mesh_with_pymeshfix(uploaded_path, repaired_path)
    refined_ok = refine_surface_with_gmsh(repaired_path, refined_path, resolution)

    if refined_path.exists():
        shutil.copyfile(refined_path, uploaded_path)
    elif repaired_path.exists():
        shutil.copyfile(repaired_path, uploaded_path)

    after_triangles = triangle_count(uploaded_path)

    for p in (repaired_path, refined_path):
        if p.exists():
            p.unlink(missing_ok=True)

    return {
        "mesh_repaired": bool(repaired_ok),
        "mesh_refined": bool(refined_ok),
        "triangle_count_before": before_triangles,
        "triangle_count_after": after_triangles,
        "resolution_used": resolution,
    }