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
  const [sharedDescriptionText, setSharedDescriptionText] = useState('');
  const [descriptionStage, setDescriptionStage] = useState('part');
  const [forces, setForces] = useState([]);
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
          description: force.description || '',
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
      formData.append('resolution', 'high');

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
    description: '',
    paintedVertexIndices: [],
    normal: [0, 0, 1],
    centroid: [0, 0, 0],
    paintedArea: 0,
  });

  const extractPartContextFromText = (text) => {
    const raw = String(text || '').trim();
    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    let material = '';
    let partPurpose = '';

    for (const line of lines) {
      const lower = line.toLowerCase();
      if (!material && lower.startsWith('material')) {
        material = line.split(':').slice(1).join(':').trim();
        continue;
      }
      if (!partPurpose && (lower.startsWith('part') || lower.startsWith('purpose'))) {
        partPurpose = line.split(':').slice(1).join(':').trim();
      }
    }

    if (!partPurpose) {
      partPurpose = lines[0] || raw;
    }
    if (!material) {
      const materialMatch = raw.match(/\b(aluminum|steel|titanium|pla|abs|nylon|carbon\s*fiber|brass|copper)\b/i);
      material = materialMatch ? materialMatch[0] : 'unknown';
    }

    return {
      material: material || 'unknown',
      partPurpose: partPurpose || 'unknown',
    };
  };

  const savePartDescriptionFromSharedBox = () => {
    if (!sharedDescriptionText.trim()) {
      alert('Please describe what the part is and what it is made of.');
      return;
    }

    const extracted = extractPartContextFromText(sharedDescriptionText);
    setPartDescription(extracted);
    setDescriptionStage('force');
    setSharedDescriptionText('');
    setStatus('Part description saved. Click Add Force, describe the force, then paint it.');
  };

  const saveForceDescriptionFromSharedBox = () => {
    if (selectedForceIndex === null || selectedForceIndex < 0 || selectedForceIndex >= forces.length) {
      alert('Click Add Force (or select a force) before saving force text.');
      return;
    }
    if (!sharedDescriptionText.trim()) {
      alert('Please type the force description in plain language.');
      return;
    }

    updateForceDescription(selectedForceIndex, sharedDescriptionText.trim());
    setSharedDescriptionText('');
    setStatus(`Force #${selectedForceIndex + 1} text saved. Draw on the part where this force is exerted.`);

    const wantsAnother = window.confirm(
      `Force #${selectedForceIndex + 1} saved.\n\nNow draw on the part where this force is exerted.\n\nDo you want to add another force now?`
    );
    if (wantsAnother) {
      addForce();
    }
  };

  const addForce = () => {
    setForces((prev) => {
      const next = [...prev, createEmptyForce()];
      setSelectedForceIndex(next.length - 1);
      setPaintingForceIndex(null);
      setDescriptionStage('force');
      setStatus(`Created Force #${next.length}. Write force in plain language, then paint it.`);
      return next;
    });
  };

  const updateForceDescription = (index, value) => {
    setForces((prev) => prev.map((force, i) => (i === index ? { ...force, description: value } : force)));
  };

  const removeForce = (index) => {
    setForces((prev) => prev.filter((_, i) => i !== index));
    if (selectedForceIndex === index) {
      setSelectedForceIndex(null);
      setPaintingForceIndex(null);
    } else if (selectedForceIndex !== null && index < selectedForceIndex) {
      setSelectedForceIndex(selectedForceIndex - 1);
    }
  };

  const selectForce = (index) => {
    setSelectedForceIndex(index);
    setPaintingForceIndex(null);
    setDescriptionStage('force');
    setSharedDescriptionText(forces[index]?.description || '');
  };

  const runSimulation = async () => {
    if (!filename) {
      alert('Please upload an STL or STEP file first.');
      return;
    }

    if (!partDescription.partPurpose.trim() || !partDescription.material.trim()) {
      alert('Please enter both part purpose and material in Step 1.');
      return;
    }

    const paintedRegions = collectPaintedFaces();
    if (!paintedRegions.length) {
      alert('Please paint at least one force region before running simulation.');
      return;
    }

    const forceInputIssues = forces.filter(
      (force) => !(force.description || '').trim() || !(force.paintedVertexIndices || []).length
    );
    if (forceInputIssues.length) {
      alert('Each force needs plain-language text and a painted region before simulation.');
      return;
    }

    setIsLoading(true);

    try {
      logSessionEvent('Part description entered', {
        part_purpose: partDescription.partPurpose,
        material: partDescription.material,
      });

      const structuredForces = [];
      for (let i = 0; i < forces.length; i += 1) {
        const force = forces[i];
        const region = paintedRegions.find((r) => r.region_id === i);
        if (!region) {
          continue;
        }

        logSessionEvent('Force description entered', {
          force_index: i,
          raw_text: force.description,
        });

        const parseResponse = await fetch(`${API_BASE}/api/parse_forces`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            description: force.description,
            faces: [region],
            part_context: {
              part_purpose: partDescription.partPurpose,
              material: partDescription.material,
            },
          }),
        });

        if (!parseResponse.ok) {
          alert(`Failed to parse force #${i + 1} with Gemini.`);
          return;
        }

        const parsed = await parseResponse.json();
        const firstParsed = Array.isArray(parsed) && parsed.length ? parsed[0] : null;
        if (!firstParsed) {
          alert(`Gemini returned no structured force for force #${i + 1}.`);
          return;
        }

        structuredForces.push({
          ...firstParsed,
          region_id: i,
        });
      }

      logSessionEvent('Forces parsed', {
        structured_forces: structuredForces,
      });

      const simulationForces = mergeParsedForcesWithPaintedRegions(structuredForces, paintedRegions);
      const response = await fetch(`${API_BASE}/api/run_simulation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stl_filename: filename,
          forces: simulationForces,
          resolution: 'high',
          part_context: {
            material: partDescription.material,
            part_purpose: partDescription.partPurpose,
          },
        }),
      });

      if (!response.ok) {
        alert('Failed to submit simulation.');
      } else {
        const result = await response.json();
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
          background: '#f5f7fa',
          borderLeft: '1px solid #d0d9e6',
          overflowY: 'auto',
        }}
      >
        {/* Chat-style message feed */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '20px 16px',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          {/* Initial system message */}
          {!geometry && (
            <div
              style={{
                background: '#e3f2fd',
                border: '1px solid #90caf9',
                borderRadius: 8,
                padding: '12px 14px',
                fontSize: 13,
                color: '#1565c0',
              }}
            >
              👋 Upload an STL or STEP file to begin. Then describe your part and the forces acting on it in plain language.
            </div>
          )}

          {/* Upload success */}
          {geometry && !partDescription.partPurpose && (
            <div
              style={{
                background: '#e8f5e9',
                border: '1px solid #81c784',
                borderRadius: 8,
                padding: '12px 14px',
                fontSize: 13,
                color: '#2e7d32',
              }}
            >
              ✓ {filename} loaded successfully
              {triangleCounts.before && (
                <div style={{ fontSize: 12, marginTop: 4 }}>
                  Mesh: {triangleCounts.before} → {triangleCounts.after} triangles
                </div>
              )}
            </div>
          )}

          {/* Part description prompt */}
          {geometry && descriptionStage === 'part' && !partDescription.partPurpose && (
            <div
              style={{
                background: '#fff9c4',
                border: '1px solid #fbc02d',
                borderRadius: 8,
                padding: '12px 14px',
                fontSize: 13,
                color: '#f57f17',
              }}
            >
              📝 What is this part? What material is it? (e.g., "aluminum motor bracket")
            </div>
          )}

          {/* Part description display */}
          {partDescription.partPurpose && (
            <div
              style={{
                background: '#f3e5f5',
                border: '1px solid #ce93d8',
                borderRadius: 8,
                padding: '12px 14px',
                fontSize: 13,
                color: '#6a1b9a',
              }}
            >
              ✓ Part: {partDescription.partPurpose} | Material: {partDescription.material}
            </div>
          )}

          {/* Forces list */}
          {forces.length > 0 && (
            <div
              style={{
                background: '#f3e5f5',
                border: '1px solid #ce93d8',
                borderRadius: 8,
                padding: '12px 14px',
                fontSize: 13,
              }}
            >
              <div style={{ fontWeight: 600, color: '#6a1b9a', marginBottom: 6 }}>
                Forces added:
              </div>
              {forces.map((force, idx) => (
                <div
                  key={force.id}
                  style={{
                    fontSize: 12,
                    color: '#7b1fa2',
                    marginBottom: idx < forces.length - 1 ? 4 : 0,
                  }}
                >
                  • Force {idx + 1}: {force.description || '(no description)'}
                </div>
              ))}
            </div>
          )}

          {/* Force prompt */}
          {partDescription.partPurpose && descriptionStage === 'force' && (
            <div
              style={{
                background: '#fff9c4',
                border: '1px solid #fbc02d',
                borderRadius: 8,
                padding: '12px 14px',
                fontSize: 13,
                color: '#f57f17',
              }}
            >
              ⚡ Describe Force {selectedForceIndex + 1}: magnitude, direction, and where it acts. Then paint it on the model.
            </div>
          )}

          {/* Paint instruction */}
          {selectedForceIndex !== null && forces[selectedForceIndex]?.description && !paintModeEnabled && (
            <div
              style={{
                background: '#fff3e0',
                border: '1px solid #ffb74d',
                borderRadius: 8,
                padding: '12px 14px',
                fontSize: 13,
                color: '#e65100',
              }}
            >
              🎨 Paint Mode is off. Enable it below to paint Force {selectedForceIndex + 1} on the model.
            </div>
          )}

          {/* Ready to simulate */}
          {partDescription.partPurpose && forces.length > 0 && forces.every(f => f.description) && (
            <div
              style={{
                background: '#c8e6c9',
                border: '1px solid #66bb6a',
                borderRadius: 8,
                padding: '12px 14px',
                fontSize: 13,
                color: '#2e7d32',
              }}
            >
              ✓ Ready! Click <strong>Analyze</strong> to run the simulation.
            </div>
          )}

          {/* Simulation results */}
          {simulationResult && (
            <div
              style={{
                background: simulationResult.passed ? '#e8f5e9' : '#ffebee',
                border: simulationResult.passed ? '2px solid #66bb6a' : '2px solid #ef5350',
                borderRadius: 8,
                padding: '14px 16px',
                fontSize: 13,
              }}
            >
              <div
                style={{
                  fontSize: 20,
                  fontWeight: 800,
                  letterSpacing: 1,
                  color: simulationResult.passed ? '#1b5e20' : '#c62828',
                  marginBottom: 10,
                }}
              >
                {simulationResult.passed ? '✓ PASSED' : '✗ FAILED'}
              </div>
              <div style={{ color: '#1a2b41', marginBottom: 8 }}>
                <div>Max stress: <strong>{Number(simulationResult.max_stress || 0).toExponential(2)}</strong> Pa</div>
                <div>Safety factor: <strong>{Number(simulationResult.safety_factor || 0).toFixed(1)}x</strong></div>
              </div>
              {!simulationResult.passed && (
                <div style={{ fontSize: 12, color: '#c62828', marginTop: 8 }}>
                  💡 Refine your design and try again.
                </div>
              )}
            </div>
          )}
        </div>

        {/* Input area */}
        <div
          style={{
            borderTop: '1px solid #d0d9e6',
            padding: '14px 16px',
            background: '#ffffff',
          }}
        >
          {/* File upload area */}
          {!geometry && (
            <div
              style={{
                position: 'relative',
                marginBottom: 10,
              }}
            >
              <input
                type="file"
                accept=".stl,.step,.stp"
                onChange={onFileChange}
                disabled={isLoading}
                style={{
                  display: 'none',
                }}
                id="file-input"
              />
              <label
                htmlFor="file-input"
                style={{
                  display: 'block',
                  padding: '10px 12px',
                  borderRadius: 6,
                  border: '2px dashed #90caf9',
                  background: '#f0f8ff',
                  textAlign: 'center',
                  cursor: isLoading ? 'not-allowed' : 'pointer',
                  fontSize: 13,
                  color: '#1565c0',
                  fontWeight: 500,
                }}
              >
                📁 Choose file or drag here
              </label>
            </div>
          )}

          {/* Brush and paint controls - horizontal compact */}
          {geometry && (
            <div
              style={{
                display: 'flex',
                gap: 8,
                marginBottom: 10,
                alignItems: 'center',
                fontSize: 12,
              }}
            >
              <label style={{ color: '#1a2b41', fontWeight: 500, minWidth: 50 }}>
                Brush:
              </label>
              <input
                type="range"
                min="2"
                max="20"
                step="0.5"
                value={brushRadius}
                onChange={(e) => setBrushRadius(Number(e.target.value))}
                style={{ flex: 1, minWidth: 60 }}
              />
              <span style={{ color: '#1a2b41', minWidth: 24 }}>
                {brushRadius.toFixed(1)}
              </span>
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  cursor: 'pointer',
                  color: paintModeEnabled ? '#b35900' : '#7a7a7a',
                  fontWeight: paintModeEnabled ? 600 : 400,
                }}
              >
                <input
                  type="checkbox"
                  checked={paintModeEnabled}
                  onChange={(e) => setPaintModeEnabled(e.target.checked)}
                  style={{ cursor: 'pointer' }}
                />
                Paint
              </label>
            </div>
          )}

          {/* Chat-style input */}
          {geometry && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
              <textarea
                value={sharedDescriptionText}
                onChange={(e) => setSharedDescriptionText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && e.ctrlKey) {
                    if (descriptionStage === 'part') {
                      savePartDescriptionFromSharedBox();
                    } else {
                      saveForceDescriptionFromSharedBox();
                    }
                  }
                }}
                rows={2}
                placeholder={
                  descriptionStage === 'part'
                    ? 'Describe your part...'
                    : `Describe Force ${selectedForceIndex + 1}...`
                }
                style={{
                  flex: 1,
                  resize: 'none',
                  borderRadius: 6,
                  border: '1px solid #d0d9e6',
                  padding: '10px 12px',
                  fontFamily: 'system-ui, -apple-system, sans-serif',
                  fontSize: 13,
                }}
              />
              <button
                onClick={() => {
                  if (descriptionStage === 'part') {
                    savePartDescriptionFromSharedBox();
                  } else {
                    saveForceDescriptionFromSharedBox();
                  }
                }}
                style={{
                  padding: '9px 14px',
                  borderRadius: 6,
                  border: 'none',
                  background: '#265f9e',
                  color: '#fff',
                  fontWeight: 500,
                  cursor: 'pointer',
                  fontSize: 13,
                  minWidth: 60,
                  height: 40,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                Send
              </button>
            </div>
          )}

          {/* Compact button row */}
          {geometry && partDescription.partPurpose && (
            <div
              style={{
                display: 'flex',
                gap: 6,
                marginTop: 10,
                flexWrap: 'wrap',
              }}
            >
              {descriptionStage === 'force' && (
                <button
                  onClick={addForce}
                  style={{
                    padding: '8px 12px',
                    borderRadius: 6,
                    border: '1px solid #ff9800',
                    background: 'transparent',
                    color: '#ff9800',
                    fontWeight: 500,
                    cursor: 'pointer',
                    fontSize: 12,
                  }}
                >
                  + Add another force
                </button>
              )}
              {forces.length > 0 && forces.every(f => f.description) && !isLoading && (
                <button
                  onClick={runSimulation}
                  style={{
                    padding: '8px 14px',
                    borderRadius: 6,
                    border: 'none',
                    background: '#265f9e',
                    color: '#fff',
                    fontWeight: 600,
                    cursor: 'pointer',
                    fontSize: 12,
                  }}
                >
                  🔍 Analyze
                </button>
              )}
              {isLoading && (
                <div style={{ fontSize: 12, color: '#7a7a7a', fontStyle: 'italic' }}>
                  Analyzing...
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
