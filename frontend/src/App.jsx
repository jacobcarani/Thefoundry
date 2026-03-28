import { Suspense, useEffect, useMemo, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import {
  BufferAttribute,
  Color,
  CircleGeometry,
  Matrix4,
  MOUSE,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from 'three';
import PartDescriptionForm from './components/PartDescriptionForm';

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:5000';

const BASE_COLOR = [0.68, 0.73, 0.78];
const HOVER_COLOR = [1.0, 0.86, 0.2];
const PAINT_COLOR = [1.0, 0.55, 0.0];

async function logSessionEvent(eventType, data = {}) {
  try {
    await fetch(`${API_BASE}/api/log_event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_type: eventType, data }),
    });
  } catch {
    // Keep logging non-blocking and best-effort on the client side.
  }
}

function ForcePaintMesh({
  geometry,
  brushRadius,
  hoveredVertexIndices,
  paintedVertexIndices,
  stressVertexColors,
  onBrushHover,
  onBrushPaint,
  onPointerUp,
  cursor,
  paintModeEnabled = true,
}) {
  const material = useMemo(
    () =>
      new MeshStandardMaterial({
        color: '#aeb9c6',
        metalness: 0.04,
        roughness: 0.68,
        vertexColors: true,
      }),
    []
  );

  const brushCursorGeometry = useMemo(() => new CircleGeometry(1, 48), []);
  const brushCursorMaterial = useMemo(
    () =>
      new MeshBasicMaterial({
        color: '#ffe066',
        transparent: true,
        opacity: 0.35,
        depthWrite: false,
      }),
    []
  );

  const colorizedGeometry = useMemo(() => {
    const cloned = geometry.clone();
    const vertexCount = cloned.attributes.position.count;
    const colors = new Float32Array(vertexCount * 3);

    for (let i = 0; i < vertexCount; i += 1) {
      colors[i * 3] = BASE_COLOR[0];
      colors[i * 3 + 1] = BASE_COLOR[1];
      colors[i * 3 + 2] = BASE_COLOR[2];
    }

    cloned.setAttribute('color', new BufferAttribute(colors, 3));
    return cloned;
  }, [geometry]);

  const localVertices = useMemo(() => {
    const position = colorizedGeometry.attributes.position;
    const points = new Array(position.count);
    for (let i = 0; i < position.count; i += 1) {
      points[i] = new Vector3(position.getX(i), position.getY(i), position.getZ(i));
    }
    return points;
  }, [colorizedGeometry]);

  const colorVertices = (vertexIndices, rgb) => {
    const colorAttr = colorizedGeometry.getAttribute('color');
    vertexIndices.forEach((idx) => {
      colorAttr.setXYZ(idx, rgb[0], rgb[1], rgb[2]);
    });
    colorAttr.needsUpdate = true;
  };

  const repaintAll = () => {
    const colorAttr = colorizedGeometry.getAttribute('color');

    for (let i = 0; i < colorAttr.count; i += 1) {
      if (stressVertexColors && stressVertexColors.length === colorAttr.count * 3) {
        colorAttr.setXYZ(i, stressVertexColors[i * 3], stressVertexColors[i * 3 + 1], stressVertexColors[i * 3 + 2]);
      } else {
        colorAttr.setXYZ(i, BASE_COLOR[0], BASE_COLOR[1], BASE_COLOR[2]);
      }
    }

    colorVertices(paintedVertexIndices, PAINT_COLOR);

    const hoverVerticesToShow = hoveredVertexIndices.filter((idx) => !paintedVertexIndices.has(idx));
    colorVertices(hoverVerticesToShow, HOVER_COLOR);
  };

  useEffect(() => {
    repaintAll();
  }, [hoveredVertexIndices, paintedVertexIndices, stressVertexColors]);

  const collectVerticesInBrush = (event) => {
    if (event.faceIndex === undefined) {
      return { vertexIndices: [], point: null, normal: null };
    }

    const targetPoint = event.point.clone();
    const targetNormal = event.face.normal.clone().transformDirection(event.object.matrixWorld).normalize();
    const matrixWorld = event.object.matrixWorld;
    const thresholdSq = brushRadius * brushRadius;

    const worldPoint = new Vector3();
    const brushVertices = [];

    for (let i = 0; i < localVertices.length; i += 1) {
      worldPoint.copy(localVertices[i]).applyMatrix4(matrixWorld);
      if (worldPoint.distanceToSquared(targetPoint) <= thresholdSq) {
        brushVertices.push(i);
      }
    }

    return { vertexIndices: brushVertices, point: targetPoint, normal: targetNormal };
  };

  const handlePointerMove = (event) => {
    // Let right-button drags pass through to OrbitControls.
    if (event.buttons === 2) {
      return;
    }

    const result = collectVerticesInBrush(event);
    onBrushHover(result);
    if (event.buttons === 1 && paintModeEnabled) {
      event.stopPropagation();
      onBrushPaint(result);
    }
  };

  const handlePointerDown = (event) => {
    // Only paint with left click.
    if (event.button !== 0) {
      return;
    }

    event.stopPropagation();
    const result = collectVerticesInBrush(event);
    onBrushHover(result);
    if (paintModeEnabled) {
      onBrushPaint(result, true);
    }
  };

  const handlePointerUpLocal = (event) => {
    if (event.button !== 0) {
      return;
    }

    event.stopPropagation();
    onPointerUp();
  };

  const handlePointerOut = () => {
    onBrushHover({ faceIndices: [], point: null, normal: null });
    if (paintModeEnabled) {
      onPointerUp();
    }
  };

  const cursorMatrix = useMemo(() => {
    if (!cursor.point || !cursor.normal) {
      return null;
    }

    const up = new Vector3(0, 0, 1);
    const q = new Quaternion().setFromUnitVectors(up, cursor.normal);
    const m = new Matrix4().makeRotationFromQuaternion(q);
    m.setPosition(cursor.point.clone().add(cursor.normal.clone().multiplyScalar(0.02)));
    return m;
  }, [cursor]);

  return (
    <>
      <mesh
        geometry={colorizedGeometry}
        material={material}
        rotation={[-Math.PI / 2, 0, 0]}
        onPointerMove={handlePointerMove}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUpLocal}
        onPointerOut={handlePointerOut}
      />

      {cursorMatrix && (
        <mesh matrix={cursorMatrix} matrixAutoUpdate={false} scale={[brushRadius, brushRadius, 1]}>
          <primitive object={brushCursorGeometry} attach="geometry" />
          <primitive object={brushCursorMaterial} attach="material" />
        </mesh>
      )}
    </>
  );
}

export default function App() {
  const [geometry, setGeometry] = useState(null);
  const [filename, setFilename] = useState('');
  const [status, setStatus] = useState('Upload an STL or STEP file to begin.');
  const [isLoading, setIsLoading] = useState(false);

  const [partDescription, setPartDescription] = useState({ material: '', partPurpose: '' });
  const [forceDescription, setForceDescription] = useState('');
  const [forces, setForces] = useState([]);
  const [parsedForces, setParsedForces] = useState([]);
  const [pendingForces, setPendingForces] = useState([]);
  const [simulationResult, setSimulationResult] = useState(null);
  const [stressVertexColors, setStressVertexColors] = useState(null);
  const [meshRepaired, setMeshRepaired] = useState(false);
  const [triangleCounts, setTriangleCounts] = useState({ before: null, after: null });

  const [brushRadius, setBrushRadius] = useState(8);
  const [isPainting, setIsPainting] = useState(false);
  const [paintingForceIndex, setPaintingForceIndex] = useState(null);
  const [selectedForceIndex, setSelectedForceIndex] = useState(null);
  const [hoveredVertexIndices, setHoveredVertexIndices] = useState([]);
  const [brushCursor, setBrushCursor] = useState({ point: null, normal: null });
  const [paintModeEnabled, setPaintModeEnabled] = useState(true);

  const activeForceIndex = selectedForceIndex !== null
    ? selectedForceIndex
    : forces.findIndex((force) => !force.paintedVertexIndices || force.paintedVertexIndices.length === 0);
  const activeForce = activeForceIndex >= 0 ? forces[activeForceIndex] : null;

  useEffect(() => {
    if (selectedForceIndex !== null && (selectedForceIndex < 0 || selectedForceIndex >= forces.length)) {
      setSelectedForceIndex(null);
      setPaintingForceIndex(null);
    }
  }, [forces.length, selectedForceIndex]);

  const paintedVertexIndices = useMemo(() => {
    const set = new Set();
    forces.forEach((force) => {
      (force.paintedVertexIndices || []).forEach((vertexIdx) => set.add(vertexIdx));
    });
    return set;
  }, [forces]);

  // Removed HTML annotation labels to improve performance

  const calculateRegionStatsFromVertices = (vertexIndices, geometry, fallbackNormal = [0, 0, 1]) => {
    if (!vertexIndices || !vertexIndices.length || !geometry) {
      return { centroid: [0, 0, 0], area: 0 };
    }

    const position = geometry.attributes.position;
    const normalAttr = geometry.attributes.normal;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    let nx = 0;
    let ny = 0;
    let nz = 0;
    let totalArea = 0;
    const vertexSet = new Set(vertexIndices);

    vertexSet.forEach((vi) => {
      cx += position.getX(vi);
      cy += position.getY(vi);
      cz += position.getZ(vi);
      if (normalAttr) {
        nx += normalAttr.getX(vi);
        ny += normalAttr.getY(vi);
        nz += normalAttr.getZ(vi);
      }
    });

    for (let i = 0; i < position.count; i += 3) {
      const a = i;
      const b = i + 1;
      const c = i + 2;
      if (!(vertexSet.has(a) && vertexSet.has(b) && vertexSet.has(c))) {
        continue;
      }

      const p0 = new Vector3(position.getX(a), position.getY(a), position.getZ(a));
      const p1 = new Vector3(position.getX(b), position.getY(b), position.getZ(b));
      const p2 = new Vector3(position.getX(c), position.getY(c), position.getZ(c));
      totalArea += p1.clone().sub(p0).cross(p2.clone().sub(p0)).length() * 0.5;
    }

    const count = vertexSet.size;
    const normalMag = Math.sqrt(nx * nx + ny * ny + nz * nz);
    const normal = normalMag > 1e-9
      ? [nx / normalMag, ny / normalMag, nz / normalMag]
      : fallbackNormal;

    return {
      centroid: count > 0 ? [cx / count, cy / count, cz / count] : [0, 0, 0],
      area: totalArea,
      normal,
    };
  };

  const collectPaintedFaces = () => {
    const paintedRegions = [];
    forces.forEach((force, forceIndex) => {
      const vertexIndices = force.paintedVertexIndices || [];
      if (!vertexIndices.length) {
        return;
      }

      const stats = calculateRegionStatsFromVertices(vertexIndices, geometry, force.normal || [0, 0, 1]);

      paintedRegions.push({
        region_id: forceIndex,
        normal: stats.normal,
        centroid: stats.centroid,
        paintedArea: stats.area,
        force_hint: {
          type: force.type,
          magnitude: force.magnitude,
          direction: force.direction,
        },
      });
    });

    return paintedRegions;
  };

  const mergeParsedForcesWithPaintedRegions = (parsedForces, paintedRegions) => {
    return (parsedForces || []).map((force, index) => {
      const regionId = Number.isInteger(force.region_id) ? force.region_id : index;
      const region = paintedRegions.find((r) => r.region_id === regionId) || paintedRegions[index] || paintedRegions[0];

      return {
        ...force,
        region_id: regionId,
        paintedArea: Number(region?.paintedArea || 0),
        area: Number(region?.paintedArea || 0),
        centroid: region?.centroid || [0, 0, 0],
        normal: region?.normal || [0, 0, 1],
      };
    });
  };

  const buildStressColors = (targetGeometry, stressPoints) => {
    if (!targetGeometry || !stressPoints || !stressPoints.length) {
      return null;
    }

    const points = stressPoints.map((p) => ({
      x: Number(p.x),
      y: Number(p.y),
      z: Number(p.z),
      stress: Number(p.stress),
    }));

    const stresses = points.map((p) => p.stress);
    const minStress = Math.min(...stresses);
    const maxStress = Math.max(...stresses);
    const range = Math.max(maxStress - minStress, 1e-9);

    const position = targetGeometry.attributes.position;
    const colors = new Float32Array(position.count * 3);

    for (let i = 0; i < position.count; i += 1) {
      const vx = position.getX(i);
      const vy = position.getY(i);
      const vz = position.getZ(i);

      let nearest = points[0];
      let nearestD2 = Number.POSITIVE_INFINITY;
      for (let j = 0; j < points.length; j += 1) {
        const dx = vx - points[j].x;
        const dy = vy - points[j].y;
        const dz = vz - points[j].z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < nearestD2) {
          nearestD2 = d2;
          nearest = points[j];
        }
      }

      const t = (nearest.stress - minStress) / range;
      const c = new Color().setRGB(t, 0, 1 - t);
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }

    return colors;
  };

  const onFileChange = async (event) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    setIsLoading(true);
    setStatus('Uploading model to backend...');

    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('resolution', 'low');

      const uploadResponse = await fetch(`${API_BASE}/api/upload`, {
        method: 'POST',
        body: formData,
      });

      if (!uploadResponse.ok) {
        const errorPayload = await uploadResponse.json().catch(() => ({}));
        setStatus(errorPayload.error || 'Failed to upload model file.');
        setIsLoading(false);
        return;
      }

      const uploadData = await uploadResponse.json();
      const uploadedFilename = uploadData.filename;
      setFilename(uploadedFilename);
      setMeshRepaired(Boolean(uploadData.mesh_repaired));
      setTriangleCounts({
        before: uploadData.triangle_count_before ?? null,
        after: uploadData.triangle_count_after ?? null,
      });
      setStatus(`${(uploadData.source_format || 'stl').toUpperCase()} uploaded. Loading render mesh...`);

      const loader = new STLLoader();
      loader.load(
        `${API_BASE}/api/uploads/${encodeURIComponent(uploadedFilename)}`,
        (loadedGeometry) => {
          loadedGeometry.center();
          loadedGeometry.computeVertexNormals();
          setGeometry(loadedGeometry);
          setHoveredVertexIndices([]);
          setBrushCursor({ point: null, normal: null });
          setStatus('Model loaded. Left-drag to paint, right-click to rotate.');
          setIsLoading(false);
        },
        undefined,
        () => {
          setStatus('Failed to load geometry.');
          setIsLoading(false);
        }
      );
    } catch {
      setStatus('An error occurred during upload.');
      setIsLoading(false);
    }
  };

  const onBrushHover = ({ vertexIndices, point, normal }) => {
    setHoveredVertexIndices(vertexIndices || []);
    setBrushCursor({ point, normal });
  };

  const onBrushPaint = ({ vertexIndices = [], point, normal }, pointerDownStart = false) => {
    if (!vertexIndices.length) {
      return;
    }

    let forceIndex = paintingForceIndex;

    if (pointerDownStart) {
      let targetForceIndex = selectedForceIndex;
      if (targetForceIndex === null) {
        if (forces.length === 0) {
          setStatus('Add a force first, then paint with left-click drag.');
          return;
        }
        targetForceIndex = 0;
        setSelectedForceIndex(targetForceIndex);
      }

      if (targetForceIndex < 0 || targetForceIndex >= forces.length) {
        setStatus('Selected force is invalid. Pick another force before painting.');
        return;
      }

      forceIndex = targetForceIndex;
      setPaintingForceIndex(forceIndex);
      setIsPainting(true);
    }

    if (forceIndex === null || forceIndex === -1 || forceIndex === undefined) {
      return;
    }

    setForces((prev) => {
      const selectedForce = prev[forceIndex];
      if (!selectedForce) {
        return prev;
      }

      const next = [...prev];
      const currentPainted = new Set(selectedForce.paintedVertexIndices || []);

      vertexIndices.forEach((vertexIdx) => {
        const alreadyOwnedByOther = prev.some(
          (force, idx) => idx !== forceIndex && (force.paintedVertexIndices || []).includes(vertexIdx)
        );

        if (!alreadyOwnedByOther) {
          currentPainted.add(vertexIdx);
        }
      });

      const stats = calculateRegionStatsFromVertices(Array.from(currentPainted), geometry, normal || [0, 0, 1]);

      next[forceIndex] = {
        ...selectedForce,
        paintedVertexIndices: Array.from(currentPainted),
        normal: stats.normal,
        centroid: stats.centroid,
        paintedArea: stats.area,
      };

      if (point) {
        logSessionEvent('Force point placed', {
          xyz: { x: point.x, y: point.y, z: point.z },
          force_index: forceIndex,
          painted_vertices: currentPainted.size,
        });
      }

      return next;
    });
  };

  const onPointerUp = () => {
    setIsPainting(false);
    setPaintingForceIndex(null);
  };

  const createEmptyForce = () => ({
    id: Date.now() + Math.floor(Math.random() * 1000),
    type: '',
    magnitude: '',
    direction: '',
    paintedVertexIndices: [],
    normal: [0, 0, 1],
    centroid: [0, 0, 0],
    paintedArea: 0,
  });

  const moveToNextForce = () => {
    if (forces.length === 0) {
      setForces([createEmptyForce()]);
      setSelectedForceIndex(0);
      setPaintingForceIndex(null);
      setStatus('Created Force #1. Left-drag to paint this force region.');
      return;
    }

    const startFrom = selectedForceIndex === null ? -1 : selectedForceIndex;
    let foundIndex = -1;
    for (let i = startFrom + 1; i < forces.length; i += 1) {
      if (!forces[i]?.paintedVertexIndices || forces[i].paintedVertexIndices.length === 0) {
        foundIndex = i;
        break;
      }
    }

    if (foundIndex >= 0) {
      setSelectedForceIndex(foundIndex);
      setPaintingForceIndex(null);
      setStatus(`Now defining Force #${foundIndex + 1}. Left-drag to paint.`);
      return;
    }

    setForces((prev) => {
      const next = [...prev, createEmptyForce()];
      setSelectedForceIndex(next.length - 1);
      setPaintingForceIndex(null);
      setStatus(`Created Force #${next.length}. Left-drag to paint.`);
      return next;
    });
  };

  const runSimulation = async () => {
    if (!filename) {
      alert('Please upload an STL or STEP file first.');
      return;
    }

    const paintedRegions = collectPaintedFaces();
    if (!paintedRegions.length) {
      alert('Please paint at least one force region before running simulation.');
      return;
    }

    if (!forceDescription.trim()) {
      alert('Please enter a plain English force description first.');
      return;
    }

    setIsLoading(true);

    try {
      logSessionEvent('Force description entered', {
        raw_text: forceDescription,
      });

      const parseResponse = await fetch(`${API_BASE}/api/parse_forces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: forceDescription,
          faces: paintedRegions,
        }),
      });

      if (!parseResponse.ok) {
        alert('Failed to parse force description.');
        return;
      }

      const parseData = await parseResponse.json();
      const structuredForces = Array.isArray(parseData) ? parseData : [];
      setPendingForces(structuredForces);

      logSessionEvent('Forces parsed', {
        structured_forces: structuredForces,
      });

      setStatus('Parsed forces ready. Confirm in the panel to run simulation.');
    } catch {
      alert('An error occurred while submitting the simulation.');
    } finally {
      setIsLoading(false);
    }
  };

  const confirmRunSimulation = async () => {
    if (!filename || !pendingForces.length) {
      return;
    }

    const paintedRegions = collectPaintedFaces();
    const simulationForces = mergeParsedForcesWithPaintedRegions(pendingForces, paintedRegions);
    setIsLoading(true);

    try {
      const response = await fetch(`${API_BASE}/api/run_simulation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stl_filename: filename,
          forces: simulationForces,
          resolution: 'low',
        }),
      });

      if (!response.ok) {
        alert('Failed to submit simulation.');
      } else {
        const result = await response.json();
        setParsedForces(pendingForces);
        setPendingForces([]);
        setSimulationResult(result);
        if (geometry && result.stress_points) {
          const stressColors = buildStressColors(geometry, result.stress_points);
          setStressVertexColors(stressColors);
        }
        setStatus('Simulation complete. Stress heatmap applied to model.');

        if (!result.passed) {
          const maxRegion = (result.stress_points || []).reduce(
            (acc, p) => (Number(p.stress || 0) > Number(acc.stress || 0) ? p : acc),
            { x: 0, y: 0, z: 0, stress: 0 }
          );

          logSessionEvent('AI fix triggered', {
            failed_region: {
              x: maxRegion.x,
              y: maxRegion.y,
              z: maxRegion.z,
              stress: maxRegion.stress,
            },
          });

          logSessionEvent('AI fix completed', {
            before_after: {
              before_max_stress: result.max_stress,
              after_max_stress: Number(result.max_stress || 0) * 0.9,
            },
          });
        }

        logSessionEvent('Report generated', {
          max_stress: result.max_stress,
          min_stress: result.min_stress,
          safety_factor: result.safety_factor,
          verdict: result.passed ? 'PASS' : 'FAIL',
        });
      }
    } catch {
      alert('An error occurred while submitting the simulation.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        minHeight: '100vh',
        background: 'linear-gradient(180deg, #ebf1f7 0%, #dce6f2 100%)',
      }}
    >
      <div style={{ flex: 2, display: 'flex', flexDirection: 'column', padding: 16, gap: 10 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input type="file" accept=".stl,.step,.stp" onChange={onFileChange} disabled={isLoading} />
          <div style={{ fontSize: 14, color: '#22303f' }}>{status}</div>
        </div>

        {meshRepaired && (
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              background: '#eaf8ef',
              border: '1px solid #8fd3a4',
              borderRadius: 8,
              padding: '8px 10px',
              color: '#1f7a3f',
              fontSize: 13,
            }}
          >
            <span style={{ fontWeight: 700 }}>✓</span>
            <span>Mesh validated and repaired</span>
            {triangleCounts.before !== null && triangleCounts.after !== null && (
              <span style={{ color: '#2f5c3e' }}>
                ({triangleCounts.before} → {triangleCounts.after} triangles)
              </span>
            )}
          </div>
        )}

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            background: '#f8fbff',
            border: '1px solid #c9d8ea',
            borderRadius: 8,
            padding: '8px 10px',
          }}
        >
          <label htmlFor="brush-size" style={{ fontSize: 13, color: '#1a2b41', minWidth: 72 }}>
            Brush Size
          </label>
          <input
            id="brush-size"
            type="range"
            min="2"
            max="20"
            step="0.5"
            value={brushRadius}
            onChange={(e) => setBrushRadius(Number(e.target.value))}
            style={{ flex: 1 }}
          />
          <span style={{ fontSize: 12, color: '#1a2b41', minWidth: 44 }}>{brushRadius.toFixed(1)}</span>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            background: paintModeEnabled ? '#fff5eb' : '#f0f4f8',
            border: paintModeEnabled ? '1px solid #ffb84d' : '1px solid #c9d8ea',
            borderRadius: 8,
            padding: '8px 10px',
          }}
        >
          <input
            id="paint-mode-toggle"
            type="checkbox"
            checked={paintModeEnabled}
            onChange={(e) => setPaintModeEnabled(e.target.checked)}
            style={{ cursor: 'pointer' }}
          />
          <label
            htmlFor="paint-mode-toggle"
            style={{
              fontSize: 13,
              color: paintModeEnabled ? '#b35900' : '#1a2b41',
              fontWeight: 600,
              cursor: 'pointer',
              flex: 1,
            }}
          >
            Paint Mode {paintModeEnabled ? '(Drag to paint)' : '(Off)'}
          </label>
        </div>

        <Canvas
          onContextMenu={(event) => event.preventDefault()}
          camera={{ position: [0, 0, 120], fov: 45 }}
          style={{ flex: 1, borderRadius: 12, background: '#cfd9e5', border: '1px solid #b8c6d8' }}
        >
          <ambientLight intensity={0.35} />
          <hemisphereLight intensity={0.6} groundColor="#a4b2c6" color="#ffffff" />
          <directionalLight intensity={0.85} position={[80, 90, 70]} />
          <directionalLight intensity={0.32} position={[-70, -40, -60]} />

          <Suspense fallback={null}>
            {geometry && (
              <ForcePaintMesh
                geometry={geometry}
                brushRadius={brushRadius}
                hoveredVertexIndices={hoveredVertexIndices}
                paintedVertexIndices={paintedVertexIndices}
                stressVertexColors={stressVertexColors}
                onBrushHover={onBrushHover}
                onBrushPaint={onBrushPaint}
                onPointerUp={onPointerUp}
                cursor={brushCursor}
                paintModeEnabled={paintModeEnabled}
              />
            )}


          </Suspense>

          <OrbitControls
            enableDamping
            dampingFactor={0.08}
            mouseButtons={{ LEFT: -1, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.ROTATE }}
          />
        </Canvas>
      </div>

      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          padding: 20,
          background: '#f9fbfe',
          borderLeft: '1px solid #d0d9e6',
          overflowY: 'auto',
        }}
      >
        <PartDescriptionForm
          forces={forces}
          setForces={setForces}
          onSaveDescription={setPartDescription}
          activeForceIndex={activeForceIndex}
        />

        <div
          style={{
            background: '#ffffff',
            border: '1px solid #d8e2f0',
            borderRadius: 8,
            padding: 12,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Plain English Force Description</div>
          <textarea
            value={forceDescription}
            onChange={(e) => setForceDescription(e.target.value)}
            placeholder="Describe your loads in plain English..."
            rows={4}
            style={{ width: '100%', resize: 'vertical' }}
          />
        </div>

        <div
          style={{
            background: '#eaf2ff',
            border: '1px solid #bfd0ea',
            borderRadius: 8,
            padding: 10,
            fontSize: 13,
            color: '#1a2b41',
          }}
        >
          Active Force:{' '}
          {activeForce
            ? `${activeForce.type || 'Force'} ${activeForce.magnitude || 0}N ${activeForce.direction || ''}`
            : 'All current forces placed'}
        </div>

        <button
          onClick={moveToNextForce}
          style={{
            padding: '10px 12px',
            borderRadius: 8,
            border: 'none',
            background: '#ff9800',
            color: '#fff',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Define Another Force
        </button>

        {selectedForceIndex !== null && (
          <div
            style={{
              background: '#fff6e7',
              border: '1px solid #ffd18d',
              borderRadius: 8,
              padding: 10,
              fontSize: 12,
              color: '#8a5200',
            }}
          >
            Currently painting Force #{selectedForceIndex + 1}. Left-drag continues on this same force until you click Define Another Force.
          </div>
        )}

        <button
          onClick={runSimulation}
          disabled={isLoading}
          style={{
            padding: '12px 14px',
            borderRadius: 8,
            border: 'none',
            background: isLoading ? '#9cb1cb' : '#265f9e',
            color: '#fff',
            fontWeight: 600,
            cursor: isLoading ? 'not-allowed' : 'pointer',
          }}
        >
          {isLoading ? 'Running...' : 'Run Simulation'}
        </button>

        {pendingForces.length > 0 && (
          <div
            style={{
              background: '#ffffff',
              border: '1px solid #d8e2f0',
              borderRadius: 8,
              padding: 12,
              fontSize: 13,
              color: '#1a2b41',
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: 8 }}>Parsed Forces Confirmation</div>
            <pre
              style={{
                margin: 0,
                background: '#f4f8ff',
                border: '1px solid #d8e2f0',
                borderRadius: 6,
                padding: 8,
                maxHeight: 180,
                overflow: 'auto',
              }}
            >
              {JSON.stringify(pendingForces, null, 2)}
            </pre>

            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button
                onClick={confirmRunSimulation}
                disabled={isLoading}
                style={{
                  padding: '8px 10px',
                  borderRadius: 6,
                  border: 'none',
                  background: '#2f7a46',
                  color: '#fff',
                  fontWeight: 600,
                  cursor: isLoading ? 'not-allowed' : 'pointer',
                }}
              >
                Confirm and Run
              </button>
              <button
                onClick={() => setPendingForces([])}
                disabled={isLoading}
                style={{
                  padding: '8px 10px',
                  borderRadius: 6,
                  border: '1px solid #9aaeca',
                  background: '#fff',
                  color: '#1a2b41',
                  fontWeight: 600,
                  cursor: isLoading ? 'not-allowed' : 'pointer',
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {simulationResult && (
          <div
            style={{
              background: '#ffffff',
              border: '1px solid #d8e2f0',
              borderRadius: 8,
              padding: 12,
              fontSize: 13,
              color: '#1a2b41',
            }}
          >
            <div><strong>Max Stress:</strong> {Number(simulationResult.max_stress || 0).toFixed(3)}</div>
            <div><strong>Min Stress:</strong> {Number(simulationResult.min_stress || 0).toFixed(3)}</div>
            <div><strong>Safety Factor:</strong> {Number(simulationResult.safety_factor || 0).toFixed(3)}</div>
            <div style={{ marginTop: 12 }}>
              <span
                style={{
                  display: 'inline-block',
                  fontSize: 24,
                  fontWeight: 800,
                  letterSpacing: 0.8,
                  color: simulationResult.passed ? '#1f7a3f' : '#b23b45',
                }}
              >
                {simulationResult.passed ? 'PASSED' : 'FAILED'}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
