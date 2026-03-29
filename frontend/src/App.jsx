import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import {
  BufferAttribute,
  Color,
  Matrix4,
  MOUSE,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  RingGeometry,
  CircleGeometry,
  Vector3,
} from 'three';

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:5000';
const UPLOAD_PREVIEW_RESOLUTION = 'low';
const SIMULATION_RESOLUTION = 'high';

const BASE_COLOR = [0.68, 0.73, 0.78];
const HOVER_COLOR = [1.0, 0.86, 0.2];

const FORCE_COLORS = [
  { hex: '#e05a3a', rgb: [0.88, 0.35, 0.23] },
  { hex: '#e0a03a', rgb: [0.88, 0.63, 0.23] },
  { hex: '#5aab7a', rgb: [0.35, 0.67, 0.48] },
  { hex: '#2a5aab', rgb: [0.16, 0.35, 0.67] },
  { hex: '#ab6de0', rgb: [0.67, 0.43, 0.88] },
  { hex: '#6fa7d8', rgb: [0.44, 0.65, 0.85] },
];

const MATERIAL_DENSITY_KG_M3 = {
  aluminum: 2700,
  steel: 7850,
  titanium: 4500,
  brass: 8500,
  copper: 8960,
  pla: 1240,
  abs: 1040,
  nylon: 1150,
  'carbon fiber': 1600,
};

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

function normalizeVectorObject(vec) {
  if (Array.isArray(vec) && vec.length >= 3) {
    const x = Number(vec[0] || 0);
    const y = Number(vec[1] || 0);
    const z = Number(vec[2] || 0);
    const m = Math.sqrt(x * x + y * y + z * z);
    if (m > 1e-9) {
      return { x: x / m, y: y / m, z: z / m };
    }
    return { x: 0, y: 0, z: -1 };
  }

  if (vec && typeof vec === 'object') {
    const x = Number(vec.x || 0);
    const y = Number(vec.y || 0);
    const z = Number(vec.z || 0);
    const m = Math.sqrt(x * x + y * y + z * z);
    if (m > 1e-9) {
      return { x: x / m, y: y / m, z: z / m };
    }
  }

  return { x: 0, y: 0, z: -1 };
}

function formatCompact(value, fallback = '--') {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return numeric.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatExp(value, fallback = '--') {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return numeric.toExponential(2);
}

function formatClockTime(epochMs) {
  return new Date(epochMs).toLocaleTimeString([], {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatElapsed(ms) {
  const numeric = Number(ms);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return '--';
  }
  if (numeric < 1000) {
    return `${Math.round(numeric)}ms`;
  }
  return `${(numeric / 1000).toFixed(2)}s`;
}

function specialistLabel(rec) {
  const raw = String(rec?.specialist || '').trim().toUpperCase();
  if (raw === 'GEOMETRY') {
    return 'GEOMETRY';
  }
  if (raw === 'MATERIAL' || raw === 'MATERIALS') {
    return 'MATERIAL';
  }
  if (raw === 'LOAD_PATH' || raw === 'LOADPATH' || raw === 'LOAD PATH') {
    return 'LOAD PATH';
  }
  return raw || 'GEOMETRY';
}

async function uploadModelWithProgress(url, formData, onUploadProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || typeof onUploadProgress !== 'function') {
        return;
      }
      const ratio = Math.max(0, Math.min(1, event.loaded / event.total));
      onUploadProgress(ratio);
    };

    xhr.onerror = () => {
      reject(new Error('Network error during upload'));
    };

    xhr.onload = () => {
      let payload = {};
      try {
        payload = xhr.responseText ? JSON.parse(xhr.responseText) : {};
      } catch {
        payload = {};
      }

      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(payload);
        return;
      }

      reject(new Error(payload.error || `Upload failed (${xhr.status})`));
    };

    xhr.send(formData);
  });
}

function parseDirectionFromText(text) {
  const t = String(text || '').toLowerCase();
  if (t.includes('down') || t.includes('downward')) return { x: 0, y: 0, z: -1 };
  if (t.includes('up') || t.includes('upward')) return { x: 0, y: 0, z: 1 };
  if (t.includes('left')) return { x: -1, y: 0, z: 0 };
  if (t.includes('right')) return { x: 1, y: 0, z: 0 };
  if (t.includes('forward') || t.includes('front')) return { x: 0, y: 1, z: 0 };
  if (t.includes('back') || t.includes('rear')) return { x: 0, y: -1, z: 0 };
  return { x: 0, y: 0, z: -1 };
}

function extractMagnitudeNewton(segment) {
  const t = String(segment || '').toLowerCase();

  const lbsMatch = t.match(/([0-9]+(?:\.[0-9]+)?)\s*(lb|lbs|pound|pounds)\b/);
  if (lbsMatch) {
    const lbs = Number(lbsMatch[1]);
    if (Number.isFinite(lbs)) {
      return lbs * 4.4482216153;
    }
  }

  const knMatch = t.match(/([0-9]+(?:\.[0-9]+)?)\s*(kn|kilonewton|kilonewtons)\b/);
  if (knMatch) {
    const kn = Number(knMatch[1]);
    if (Number.isFinite(kn)) {
      return kn * 1000;
    }
  }

  const nMatch = t.match(/([0-9]+(?:\.[0-9]+)?)\s*(n|newton|newtons)\b/);
  if (nMatch) {
    const n = Number(nMatch[1]);
    if (Number.isFinite(n)) {
      return n;
    }
  }

  const plainNumber = t.match(/([0-9]+(?:\.[0-9]+)?)/);
  if (plainNumber) {
    const guessed = Number(plainNumber[1]);
    if (Number.isFinite(guessed)) {
      return guessed;
    }
  }

  return 0;
}

function fallbackParseForces(promptText) {
  const raw = String(promptText || '').trim();
  if (!raw) {
    return [];
  }

  const segments = raw
    .split(/\s+(?:and|&)\s+|\s*;\s*|\s*,\s*(?=\d)/i)
    .map((s) => s.trim())
    .filter(Boolean);

  const parts = segments.length > 0 ? segments : [raw];

  const parsed = parts.map((part, idx) => ({
    name: `FORCE ${idx + 1}`,
    magnitude: extractMagnitudeNewton(part),
    direction: parseDirectionFromText(part),
  }));

  return parsed.filter((p) => Number(p.magnitude) > 0);
}

function ForcePaintMesh({
  geometry,
  brushRadius,
  hoveredVertexIndices,
  paintedVertexGroups,
  stressVertexColors,
  onBrushHover,
  onBrushPaint,
  onPointerUp,
  cursor,
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

  const brushRingGeometry = useMemo(() => new RingGeometry(0.92, 1.0, 56), []);
  const brushDotGeometry = useMemo(() => new CircleGeometry(0.06, 18), []);
  const brushRingMaterial = useMemo(
    () =>
      new MeshBasicMaterial({
        color: '#e05a3a',
        transparent: true,
        opacity: 0.6,
        depthWrite: false,
      }),
    []
  );
  const brushDotMaterial = useMemo(
    () =>
      new MeshBasicMaterial({
        color: '#e05a3a',
        transparent: true,
        opacity: 0.9,
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

    paintedVertexGroups.forEach((group) => {
      colorVertices(group.vertexIndices, group.rgb);
    });

    colorVertices(hoveredVertexIndices, HOVER_COLOR);
  };

  useEffect(() => {
    repaintAll();
  }, [hoveredVertexIndices, paintedVertexGroups, stressVertexColors]);

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
    if (event.buttons === 2) {
      return;
    }

    const result = collectVerticesInBrush(event);
    onBrushHover(result);
    if (event.buttons === 1) {
      event.stopPropagation();
      onBrushPaint(result);
    }
  };

  const handlePointerDown = (event) => {
    if (event.button !== 0) {
      return;
    }

    event.stopPropagation();
    const result = collectVerticesInBrush(event);
    onBrushHover(result);
    onBrushPaint(result, true);
  };

  const handlePointerUpLocal = (event) => {
    if (event.button !== 0) {
      return;
    }

    event.stopPropagation();
    onPointerUp();
  };

  const handlePointerOut = () => {
    onBrushHover({ vertexIndices: [], point: null, normal: null });
    onPointerUp();
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
        <group matrix={cursorMatrix} matrixAutoUpdate={false} scale={[brushRadius, brushRadius, 1]}>
          <mesh>
            <primitive object={brushRingGeometry} attach="geometry" />
            <primitive object={brushRingMaterial} attach="material" />
          </mesh>
          <mesh position={[0, 0, 0.001]}>
            <primitive object={brushDotGeometry} attach="geometry" />
            <primitive object={brushDotMaterial} attach="material" />
          </mesh>
        </group>
      )}
    </>
  );
}

export default function App() {
  const [agentSessionId] = useState(() => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return `session-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  });

  const [geometry, setGeometry] = useState(null);
  const [filename, setFilename] = useState('');
  const [status, setStatus] = useState('UPLOAD STL OR STEP TO BEGIN.');
  const [isLoading, setIsLoading] = useState(false);

  const [partDescription, setPartDescription] = useState({ material: '', partPurpose: '' });
  const [forcePrompt, setForcePrompt] = useState('');
  const [forces, setForces] = useState([]);
  const [activeForceId, setActiveForceId] = useState(null);

  const [simulationResult, setSimulationResult] = useState(null);
  const [stressVertexColors, setStressVertexColors] = useState(null);
  const [meshRepaired, setMeshRepaired] = useState(false);
  const [triangleCounts, setTriangleCounts] = useState({ before: null, after: null });

  const [brushRadius, setBrushRadius] = useState(8);
  const [paintingForceIndex, setPaintingForceIndex] = useState(null);
  const [hoveredVertexIndices, setHoveredVertexIndices] = useState([]);
  const [brushCursor, setBrushCursor] = useState({ point: null, normal: null });
  const [isDragOverCenter, setIsDragOverCenter] = useState(false);
  const [taskProgress, setTaskProgress] = useState({
    active: false,
    kind: '',
    title: '',
    step: '',
    startedAt: 0,
    percent: null,
  });
  const [taskNow, setTaskNow] = useState(Date.now());

  const [chatMessages, setChatMessages] = useState([
    { role: 'SYSTEM', label: 'SYSTEM', text: 'READY. ENTER FORCE DESCRIPTION IN THE RIGHT PANEL INPUT.' },
  ]);
  const [inlineWarning, setInlineWarning] = useState('');

  const orbitRef = useRef(null);
  const timelineStepRef = useRef(1);
  const activeTimersRef = useRef(new Map());

  const appendTimelineMessage = (label, text) => {
    const now = Date.now();
    const step = timelineStepRef.current;
    timelineStepRef.current += 1;
    const prefix = `[${String(step).padStart(2, '0')}] ${formatClockTime(now)}`;

    setChatMessages((prev) => [
      ...prev,
      {
        role: 'SYSTEM',
        label,
        text: `${prefix} ${text}`,
      },
    ]);
  };

  const startTimedStep = (key, description) => {
    activeTimersRef.current.set(key, Date.now());
    appendTimelineMessage('LOADING', `STARTED: ${description}`);
  };

  const completeTimedStep = (key, description) => {
    const now = Date.now();
    const startedAt = activeTimersRef.current.get(key);
    if (startedAt !== undefined) {
      activeTimersRef.current.delete(key);
    }
    const elapsedText = startedAt === undefined ? 'N/A' : formatElapsed(now - startedAt);
    appendTimelineMessage('TIMING', `COMPLETED: ${description} | DURATION ${elapsedText}`);
  };

  const failTimedStep = (key, description) => {
    const now = Date.now();
    const startedAt = activeTimersRef.current.get(key);
    if (startedAt !== undefined) {
      activeTimersRef.current.delete(key);
    }
    const elapsedText = startedAt === undefined ? 'N/A' : formatElapsed(now - startedAt);
    appendTimelineMessage('ERROR', `FAILED: ${description} | AFTER ${elapsedText}`);
  };

  const startTaskProgress = ({ kind, title, step, percent = null }) => {
    setTaskProgress({
      active: true,
      kind,
      title,
      step,
      startedAt: Date.now(),
      percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null,
    });
  };

  const updateTaskProgress = ({ step, percent }) => {
    setTaskProgress((prev) => {
      if (!prev.active) {
        return prev;
      }
      const nextPercent = Number.isFinite(percent)
        ? Math.max(0, Math.min(100, percent))
        : (percent === null ? null : prev.percent);

      return {
        ...prev,
        step: step || prev.step,
        percent: nextPercent,
      };
    });
  };

  const finishTaskProgress = () => {
    setTaskProgress({ active: false, kind: '', title: '', step: '', startedAt: 0, percent: null });
  };

  const activeForceIndex = useMemo(() => forces.findIndex((f) => f.id === activeForceId), [forces, activeForceId]);

  // Auto-load default model on app startup
  useEffect(() => {
    const loadDefaultModel = async () => {
      try {
        startTaskProgress({ kind: 'model-load', title: 'Model', step: 'Loading default model...', percent: 0 });
        const response = await fetch(`${API_BASE}/api/default_model`);
        if (response.ok) {
          const arrayBuffer = await response.arrayBuffer();
          const loader = new STLLoader();
          const geometry = loader.parse(arrayBuffer);
          geometry.center();
          geometry.computeVertexNormals();
          geometry.computeBoundingBox();
          
          setGeometry(geometry);
          setFilename('MOUSQUETON_default.stl');
          setStatus('DEFAULT MODEL LOADED. ENTER FORCE DESCRIPTION.');
          setPartDescription({ material: 'steel', partPurpose: 'carabiner' });
          
          updateTaskProgress({ step: 'Ready', percent: 100 });
          setTimeout(finishTaskProgress, 500);
          
          appendTimelineMessage('LOADED', 'Default model (MOUSQUETON steel carabiner) loaded');
        } else {
          finishTaskProgress();
        }
      } catch (error) {
        console.warn('Failed to load default model:', error);
        finishTaskProgress();
      }
    };

    loadDefaultModel();
  }, []);

  useEffect(() => {
    if (activeForceId && !forces.some((f) => f.id === activeForceId)) {
      setActiveForceId(null);
      setPaintingForceIndex(null);
    }
  }, [forces, activeForceId]);

  useEffect(() => {
    if (!taskProgress.active) {
      return undefined;
    }

    const id = window.setInterval(() => {
      setTaskNow(Date.now());
    }, 100);

    return () => {
      window.clearInterval(id);
    };
  }, [taskProgress.active]);

  const approxVolume = useMemo(() => {
    if (!geometry) {
      return null;
    }
    const cloned = geometry.clone();
    cloned.computeBoundingBox();
    const bb = cloned.boundingBox;
    if (!bb) {
      return null;
    }
    const dx = bb.max.x - bb.min.x;
    const dy = bb.max.y - bb.min.y;
    const dz = bb.max.z - bb.min.z;
    const vol = Math.abs(dx * dy * dz * 0.35);
    return Number.isFinite(vol) ? vol : null;
  }, [geometry]);

  const materialDensity = useMemo(() => {
    const key = (partDescription.material || '').toLowerCase().trim();
    return MATERIAL_DENSITY_KG_M3[key] || null;
  }, [partDescription.material]);

  const partMassKg = useMemo(() => {
    if (!materialDensity || !approxVolume) {
      return null;
    }
    // Assume geometry units are mm and convert mm^3 -> m^3.
    const volumeM3 = approxVolume * 1e-9;
    return materialDensity * volumeM3;
  }, [materialDensity, approxVolume]);

  const partWeightN = useMemo(() => {
    if (!partMassKg) {
      return null;
    }
    return partMassKg * 9.81;
  }, [partMassKg]);

  const paintedVertexGroups = useMemo(() => {
    return forces
      .filter((f) => Array.isArray(f.paintedVertexIndices) && f.paintedVertexIndices.length > 0)
      .map((f) => ({
        vertexIndices: f.paintedVertexIndices,
        rgb: f.color.rgb,
      }));
  }, [forces]);

  const calculateRegionStatsFromVertices = (vertexIndices, targetGeometry, fallbackNormal = [0, 0, 1]) => {
    if (!vertexIndices || !vertexIndices.length || !targetGeometry) {
      return { centroid: [0, 0, 0], area: 0 };
    }

    const position = targetGeometry.attributes.position;
    const normalAttr = targetGeometry.attributes.normal;
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

  const extractFaceDataFromVertices = (vertexIndices, targetGeometry) => {
    if (!vertexIndices || !vertexIndices.length || !targetGeometry) {
      return { faceIndices: [], faceNormals: [] };
    }

    const vertexSet = new Set(vertexIndices);
    const position = targetGeometry.attributes.position;
    const normalAttr = targetGeometry.attributes.normal;

    const faceIndices = [];
    const faceNormals = [];

    for (let i = 0; i < position.count; i += 3) {
      const a = i;
      const b = i + 1;
      const c = i + 2;
      if (!(vertexSet.has(a) && vertexSet.has(b) && vertexSet.has(c))) {
        continue;
      }

      faceIndices.push(i / 3);

      let nx = 0;
      let ny = 0;
      let nz = 1;

      if (normalAttr) {
        nx = normalAttr.getX(a) + normalAttr.getX(b) + normalAttr.getX(c);
        ny = normalAttr.getY(a) + normalAttr.getY(b) + normalAttr.getY(c);
        nz = normalAttr.getZ(a) + normalAttr.getZ(b) + normalAttr.getZ(c);
        const mag = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (mag > 1e-9) {
          nx /= mag;
          ny /= mag;
          nz /= mag;
        }
      }

      faceNormals.push([nx, ny, nz]);
    }

    return { faceIndices, faceNormals };
  };

  const collectPaintedFaces = () => {
    const paintedRegions = [];

    forces.forEach((force, idx) => {
      const vertexIndices = force.paintedVertexIndices || [];
      if (!vertexIndices.length) {
        return;
      }

      const fallbackNormal = force.face_normals?.[0] || [0, 0, 1];
      const stats = calculateRegionStatsFromVertices(vertexIndices, geometry, fallbackNormal);

      paintedRegions.push({
        region_id: idx,
        normal: stats.normal,
        centroid: stats.centroid,
        paintedArea: stats.area,
        force_hint: {
          description: force.source_description || '',
          parsed_name: force.parsed_name || '',
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

  const uploadCadFile = async (file) => {
    if (!file) {
      return;
    }

    const lowerName = String(file.name || '').toLowerCase();
    const supported = lowerName.endsWith('.stl') || lowerName.endsWith('.step') || lowerName.endsWith('.stp');
    if (!supported) {
      setInlineWarning('UNSUPPORTED FILE TYPE. USE STL, STEP, OR STP.');
      return;
    }

    setIsLoading(true);
    setStatus('UPLOADING MODEL TO BACKEND...');
    startTaskProgress({
      kind: 'model-load',
      title: 'LOADING PART...',
      step: 'UPLOADING FILE TO BACKEND',
      percent: 0,
    });
    startTimedStep('upload', `Uploading ${file.name} to backend.`);

    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('resolution', UPLOAD_PREVIEW_RESOLUTION);

      const uploadData = await uploadModelWithProgress(`${API_BASE}/api/upload`, formData, (ratio) => {
        updateTaskProgress({
          step: 'UPLOADING FILE TO BACKEND',
          percent: Math.round(ratio * 35),
        });
      });
      const uploadedFilename = uploadData.filename;
      setFilename(uploadedFilename);
      setMeshRepaired(Boolean(uploadData.mesh_repaired));
      setTriangleCounts({
        before: uploadData.triangle_count_before ?? null,
        after: uploadData.triangle_count_after ?? null,
      });
      completeTimedStep('upload', `Uploaded ${uploadedFilename}.`);
      updateTaskProgress({
        step: 'SERVER PREPROCESSING COMPLETE',
        percent: 40,
      });
      setStatus(`${(uploadData.source_format || 'stl').toUpperCase()} RECEIVED. LOADING VIEWPORT MESH...`);
      appendTimelineMessage(
        'TIMING',
        `UPLOAD PREVIEW RESOLUTION: ${String(uploadData.resolution_used || UPLOAD_PREVIEW_RESOLUTION).toUpperCase()}`
      );
      if (uploadData.fast_preview) {
        appendTimelineMessage('TIMING', 'FAST PREVIEW MODE ENABLED (STEP REPAIR/REFINE SKIPPED).');
      }
      updateTaskProgress({
        step: 'LOADING MESH INTO VIEWPORT',
        percent: 45,
      });
      startTimedStep('mesh-load', `Loading viewport mesh for ${uploadedFilename}.`);

      const loader = new STLLoader();
      loader.load(
        `${API_BASE}/api/uploads/${encodeURIComponent(uploadedFilename)}`,
        (loadedGeometry) => {
          loadedGeometry.center();
          loadedGeometry.computeVertexNormals();
          setGeometry(loadedGeometry);
          setHoveredVertexIndices([]);
          setBrushCursor({ point: null, normal: null });
          setStatus('MODEL READY. ENTER FORCES IN PLAIN ENGLISH.');
          setChatMessages((prev) => [
            ...prev,
            { role: 'AI', label: 'SYSTEM', text: `MODEL ${uploadedFilename.toUpperCase()} LOADED.` },
          ]);
          completeTimedStep('mesh-load', `Viewport mesh ready for ${uploadedFilename}.`);
          updateTaskProgress({
            step: 'MODEL READY',
            percent: 100,
          });
          finishTaskProgress();
          setIsLoading(false);
        },
        (event) => {
          if (!event || !event.total) {
            updateTaskProgress({ step: 'LOADING MESH INTO VIEWPORT', percent: null });
            return;
          }
          const ratio = Math.max(0, Math.min(1, event.loaded / event.total));
          const mapped = 45 + Math.round(ratio * 55);
          updateTaskProgress({
            step: 'LOADING MESH INTO VIEWPORT',
            percent: mapped,
          });
        },
        () => {
          failTimedStep('mesh-load', `Geometry load failed for ${uploadedFilename}.`);
          finishTaskProgress();
          setStatus('FAILED TO LOAD GEOMETRY.');
          setIsLoading(false);
        }
      );
    } catch (err) {
      failTimedStep('upload', `Upload exception for ${file.name}.`);
      finishTaskProgress();
      setStatus(String(err?.message || 'UPLOAD EXCEPTION OCCURRED.').toUpperCase());
      setIsLoading(false);
    }
  };

  const taskElapsed = taskProgress.active && taskProgress.startedAt
    ? formatElapsed(taskNow - taskProgress.startedAt)
    : '--';

  const onFileChange = async (event) => {
    const file = event.target.files?.[0];
    await uploadCadFile(file);
  };

  const onCenterDragEnter = (event) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragOverCenter(true);
  };

  const onCenterDragOver = (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!isDragOverCenter) {
      setIsDragOverCenter(true);
    }
  };

  const onCenterDragLeave = (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.currentTarget.contains(event.relatedTarget)) {
      return;
    }
    setIsDragOverCenter(false);
  };

  const onCenterDrop = async (event) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragOverCenter(false);

    const file = event.dataTransfer?.files?.[0];
    await uploadCadFile(file);
  };

  const onBrushHover = ({ vertexIndices, point, normal }) => {
    setHoveredVertexIndices(vertexIndices || []);
    setBrushCursor({ point, normal });
  };

  const onBrushPaint = ({ vertexIndices = [], point, normal }, pointerDownStart = false) => {
    if (!vertexIndices.length || activeForceIndex < 0) {
      return;
    }

    let forceIndex = paintingForceIndex;

    if (pointerDownStart) {
      forceIndex = activeForceIndex;
      setPaintingForceIndex(forceIndex);
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

      const paintedArray = Array.from(currentPainted);
      const { faceIndices, faceNormals } = extractFaceDataFromVertices(paintedArray, geometry);

      next[forceIndex] = {
        ...selectedForce,
        paintedVertexIndices: paintedArray,
        face_indices: faceIndices,
        face_normals: faceNormals,
        located: faceIndices.length > 0,
      };

      if (point) {
        logSessionEvent('Force point placed', {
          xyz: { x: point.x, y: point.y, z: point.z },
          force_index: forceIndex,
          painted_vertices: paintedArray.length,
        });
      }

      return next;
    });

    setInlineWarning('');
  };

  const onPointerUp = () => {
    setPaintingForceIndex(null);
  };

  const resetViewportState = () => {
    setStressVertexColors(null);
    setHoveredVertexIndices([]);
    setBrushCursor({ point: null, normal: null });
    if (orbitRef.current && typeof orbitRef.current.reset === 'function') {
      orbitRef.current.reset();
    }
  };

  const parseForcePrompt = async () => {
    const prompt = forcePrompt.trim();
    if (!prompt) {
      return;
    }
    if (!filename) {
      setInlineWarning('LOAD A MODEL BEFORE PARSING FORCE TEXT.');
      return;
    }

    setInlineWarning('');
    setChatMessages((prev) => [...prev, { role: 'USER', label: 'YOU', text: prompt }]);
    setStatus('PARSING FORCES WITH GEMINI...');
    startTaskProgress({
      kind: 'force-parse',
      title: 'PARSING FORCES',
      step: 'SENDING DESCRIPTION TO PARSER',
      percent: 5,
    });
    startTimedStep('force-parse', 'Parsing plain-English force description.');

    try {
      const paintedFaces = collectPaintedFaces();
      const response = await fetch(`${API_BASE}/api/parse_forces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: prompt,
          faces: paintedFaces,
          part_context: {
            material: partDescription.material || 'unknown',
            part_purpose: partDescription.partPurpose || 'unknown',
          },
        }),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || 'Force parsing failed');
      }

      updateTaskProgress({ step: 'INTERPRETING RESPONSE', percent: 75 });

      const parsedApi = await response.json();
      const parsed = Array.isArray(parsedApi) && parsedApi.length > 0
        ? parsedApi
        : fallbackParseForces(prompt);
      const usedFallback = !(Array.isArray(parsedApi) && parsedApi.length > 0);

      if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error('No forces were parsed from that description');
      }

      const nextForces = parsed.map((pf, idx) => {
        const existing = forces[idx];
        const color = FORCE_COLORS[idx % FORCE_COLORS.length];
        const direction = normalizeVectorObject(pf.direction || pf.vector || pf.dir || [0, 0, -1]);
        const magnitude = Number(pf.magnitude ?? pf.amount ?? pf.force_n ?? pf.newtons ?? 0);

        return {
          id: existing?.id || `force-${Date.now()}-${idx}`,
          source_description: prompt,
          parsed_name: String(pf.name || pf.label || `FORCE ${idx + 1}`).toUpperCase(),
          magnitude_n: Number.isFinite(magnitude) ? magnitude : 0,
          direction,
          face_indices: existing?.face_indices || [],
          face_normals: existing?.face_normals || [],
          paintedVertexIndices: existing?.paintedVertexIndices || [],
          located: Boolean(existing?.located),
          color,
        };
      });

      setForces(nextForces);
      if (nextForces.length > 0) {
        setActiveForceId(nextForces[0].id);
      }
      setForcePrompt('');
      setStatus(`PARSED ${parsed.length} FORCES. SELECT FORCE AND PAINT ITS LOCATION.`);
      updateTaskProgress({ step: 'FORCES PARSED', percent: 100 });
      finishTaskProgress();
      completeTimedStep(
        'force-parse',
        `${usedFallback ? 'Local parser fallback used. ' : ''}${parsed.length} force entries parsed.`
      );
      setChatMessages((prev) => [
        ...prev,
        {
          role: 'AI',
          label: 'BOUNDARY AGENT',
          text: `${usedFallback ? 'USED LOCAL PARSER. ' : ''}PARSED ${parsed.length} FORCES. PAINT EACH FORCE REGION ON THE MODEL.`,
        },
      ]);

    } catch (err) {
      failTimedStep('force-parse', 'Force parsing request failed.');
      finishTaskProgress();
      const message = String(err?.message || 'Force parsing failed').toUpperCase();
      setInlineWarning(message);
      setStatus('FORCE PARSING FAILED.');
      setChatMessages((prev) => [...prev, { role: 'AI', label: 'SYSTEM', text: message }]);
    }
  };

  const runSimulation = async () => {
    if (!filename) {
      setInlineWarning('PLEASE UPLOAD AN STL OR STEP FILE FIRST.');
      return;
    }

    if (!partDescription.material.trim()) {
      setInlineWarning('ENTER A MATERIAL TO CALCULATE WEIGHT AND RUN SIMULATION.');
      return;
    }

    if (!forces.length) {
      setInlineWarning('PARSE AT LEAST ONE FORCE BEFORE RUNNING SIMULATION.');
      return;
    }

    const unlocatedForces = forces.filter((f) => !f.located);
    if (unlocatedForces.length) {
      const pending = unlocatedForces.map((f) => f.parsed_name).join(', ');
      const warning = `LOCATE THESE FORCES BEFORE SIMULATION: ${pending}`;
      setInlineWarning(warning);
      setChatMessages((prev) => [...prev, { role: 'AI', label: 'VALIDATION', text: warning }]);
      return;
    }

    setInlineWarning('');
    setIsLoading(true);
    setStatus('RUNNING AGENT PIPELINE...');
    startTaskProgress({
      kind: 'simulation',
      title: 'RUNNING SIMULATION',
      step: 'SUBMITTING MODEL TO AGENTS',
      percent: 10,
    });
    startTimedStep('simulation', 'Submitting model and force regions to the multi-agent pipeline.');

    try {
      const paintedRegions = collectPaintedFaces();

      const structuredForces = forces.map((f, idx) => ({
        name: f.parsed_name,
        magnitude: f.magnitude_n,
        amount: f.magnitude_n,
        direction: [f.direction.x, f.direction.y, f.direction.z],
        region_id: idx,
      }));

      const simulationForces = mergeParsedForcesWithPaintedRegions(structuredForces, paintedRegions);

      const response = await fetch(`${API_BASE}/api/run_agent_pipeline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stl_filename: filename,
          forces: simulationForces,
          painted_faces: paintedRegions,
          resolution: SIMULATION_RESOLUTION,
          session_id: agentSessionId,
          part_context: {
            material: partDescription.material,
            part_purpose: partDescription.partPurpose || 'unknown',
          },
        }),
      });

      if (!response.ok) {
        let serverError = `Failed to submit simulation (${response.status})`;
        try {
          const payload = await response.json();
          if (payload?.error) {
            serverError = String(payload.error);
          }
        } catch {
          // Keep default message when response body is not valid JSON.
        }
        throw new Error(serverError);
      }

      updateTaskProgress({ step: 'PROCESSING SIMULATION RESULT', percent: 85 });

      const result = await response.json();
      setSimulationResult(result);
      completeTimedStep(
        'simulation',
        `Simulation iteration ${result.iteration_number ?? '--'} completed with verdict ${result.passed ? 'PASS' : 'FAIL'}.`
      );

      if (geometry && result.stress_points) {
        updateTaskProgress({ step: 'APPLYING HEATMAP TO MODEL', percent: 92 });
        startTimedStep('heatmap', 'Applying stress heatmap to viewport vertices.');
        const stressColors = buildStressColors(geometry, result.stress_points);
        setStressVertexColors(stressColors);
        completeTimedStep('heatmap', 'Stress heatmap applied in viewport.');
      }

      updateTaskProgress({ step: 'SIMULATION COMPLETE', percent: 100 });
      finishTaskProgress();

      setStatus('SIMULATION COMPLETE. HEATMAP APPLIED.');
      setChatMessages((prev) => [
        ...prev,
        {
          role: 'AI',
          label: 'ANALYSIS AGENT',
          text: `RESULT ${result.passed ? 'PASSED' : 'FAILED'} · SF ${formatCompact(result.safety_factor)}`,
        },
      ]);

      logSessionEvent('Report generated', {
        max_stress: result.max_stress,
        min_stress: result.min_stress,
        safety_factor: result.safety_factor,
        verdict: result.passed ? 'PASS' : 'FAIL',
      });
    } catch (err) {
      failTimedStep('simulation', 'Simulation pipeline request failed.');
      finishTaskProgress();
      const warning = String(err?.message || 'SIMULATION SUBMISSION FAILED.').toUpperCase();
      setInlineWarning(warning);
      setStatus('SIMULATION PIPELINE ERROR.');
      setChatMessages((prev) => [...prev, { role: 'AI', label: 'SYSTEM', text: warning }]);
    } finally {
      setIsLoading(false);
    }
  };

  const failureDetected = simulationResult && !simulationResult.passed;
  const safetyFactor = Number(simulationResult?.safety_factor || 0);
  const safetyPct = Math.max(0, Math.min(100, (safetyFactor / 2) * 100));

  const maxStressMpa = Number(simulationResult?.max_stress || 0) / 1_000_000;
  const minStressMpa = Number(simulationResult?.min_stress || 0) / 1_000_000;
  const midStressMpa = (maxStressMpa + minStressMpa) / 2;

  const uploadButtonLabel = filename ? `FILE: ${filename}` : 'UPLOAD STL / STEP';

  return (
    <div className="foundry-app">
      <header className="topbar">
        <div className="topbar-left">
          <div className="brand">THE FOUNDRY</div>
          <div className="tag-badge">FEA ENGINE v0.1</div>
          <div className="tag-badge">LANGRAPH AGENTS</div>
        </div>
        <div className="topbar-right">
          <span className="docker-dot" />
          <span className="docker-text">DOCKER READY</span>
        </div>
      </header>

      <div className="workspace">
        <aside className="left-panel">
          <div className="panel-section fixed-height">
            <div className="panel-header">PART SETUP</div>
            <div className="panel-body part-setup-body">
              <div className="upload-row">
                <label htmlFor="stl-upload" className="upload-button">{uploadButtonLabel}</label>
                <input
                  id="stl-upload"
                  type="file"
                  accept=".stl,.step,.stp"
                  onChange={onFileChange}
                  disabled={isLoading}
                  className="hidden-input"
                />
              </div>

              <input
                className="chat-input"
                style={{ minHeight: 28, maxHeight: 28 }}
                value={partDescription.material}
                onChange={(e) => setPartDescription((prev) => ({ ...prev, material: e.target.value }))}
                placeholder="MATERIAL (E.G. STEEL)"
              />
              <input
                className="chat-input"
                style={{ minHeight: 28, maxHeight: 28 }}
                value={partDescription.partPurpose}
                onChange={(e) => setPartDescription((prev) => ({ ...prev, partPurpose: e.target.value }))}
                placeholder="PART PURPOSE"
              />

              <div className="filename-display">{filename || 'NO MODEL LOADED'}</div>

              <div className="stats-grid">
                <div className="stat-cell">
                  <div className="stat-label">TRIANGLES</div>
                  <div className="stat-value">{formatCompact(triangleCounts.after ?? triangleCounts.before)}</div>
                </div>
                <div className="stat-cell">
                  <div className="stat-label">VOLUME</div>
                  <div className="stat-value">{approxVolume === null ? '--' : `${formatCompact(approxVolume)} u^3`}</div>
                </div>
                <div className="stat-cell">
                  <div className="stat-label">MATERIAL</div>
                  <div className="stat-value">{(partDescription.material || '--').toUpperCase()}</div>
                </div>
                <div className="stat-cell">
                  <div className="stat-label">WEIGHT</div>
                  <div className="stat-value">{partWeightN === null ? '--' : `${formatCompact(partWeightN)} N`}</div>
                </div>
              </div>

              {partMassKg !== null && (
                <div className="stat-value" style={{ color: '#5aab7a' }}>
                  MASS {formatCompact(partMassKg)} KG
                </div>
              )}

              {meshRepaired && <div className="mesh-badge">CHECKMARK MESH VALIDATED + REPAIRED</div>}
            </div>
          </div>

          <div className="panel-section fixed-height">
            <div className="panel-header">FORCE ANNOTATIONS</div>
            <div className="panel-body force-list">
              {forces.length === 0 && <div className="empty-note">NO FORCES PARSED YET.</div>}
              {forces.map((force, idx) => (
                <button
                  type="button"
                  key={force.id}
                  className={`force-row ${activeForceId === force.id ? 'selected' : ''}`}
                  onClick={() => setActiveForceId(force.id)}
                >
                  <span className="force-dot" style={{ background: force.color.hex }} />
                  <span className="force-copy">
                    <span className="force-name">{force.parsed_name}</span>
                    <span className="force-meta">
                      MAG {formatCompact(force.magnitude_n)}N · DIR {formatCompact(force.direction.x)},{formatCompact(force.direction.y)},{formatCompact(force.direction.z)} · FACES {force.face_indices.length}
                    </span>
                    <span className="force-meta" style={{ color: force.located ? '#5aab7a' : '#e0a03a' }}>
                      {force.located ? 'LOCATED' : 'NOT LOCATED'}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="panel-section chat-section">
            <div className="panel-header">ENGINEER CHAT</div>
            <div className="panel-body chat-body">
              {inlineWarning && <div className="chat-message AI"><div className="chat-label">VALIDATION</div><div className="chat-text">{inlineWarning}</div></div>}
              <div className="chat-scroll">
                {chatMessages.map((message, idx) => (
                  <div key={`${message.role}-${idx}`} className={`chat-message ${message.role}`}>
                    <div className="chat-label">{message.label}</div>
                    <div className="chat-text">{message.text}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </aside>

        <main
          className={`center-viewport ${isDragOverCenter ? 'drag-over' : ''}`}
          onDragEnter={onCenterDragEnter}
          onDragOver={onCenterDragOver}
          onDragLeave={onCenterDragLeave}
          onDrop={onCenterDrop}
        >
          <div className="grid-overlay" />
          {taskProgress.active && taskProgress.kind === 'model-load' && (
            <div className="model-loading-overlay">
              <div className="model-loading-title">{taskProgress.title || 'LOADING PART...'}</div>
              <div className="model-loading-step">{taskProgress.step}</div>
              <div className="task-progress-track large">
                <div
                  className={`task-progress-fill ${taskProgress.percent === null ? 'indeterminate' : ''}`}
                  style={taskProgress.percent === null ? undefined : { width: `${taskProgress.percent}%` }}
                />
              </div>
              <div className="model-loading-time">
                ELAPSED {taskElapsed}
                {taskProgress.percent !== null ? ` · ${taskProgress.percent}%` : ' · ESTIMATING...'}
              </div>
            </div>
          )}
          {isDragOverCenter && (
            <div className="drop-overlay">
              <div className="drop-overlay-text">DROP CAD FILE HERE</div>
              <div className="drop-overlay-subtext">STL / STEP / STP</div>
            </div>
          )}
          <Canvas
            onContextMenu={(event) => event.preventDefault()}
            camera={{ position: [0, 0, 120], fov: 45 }}
            style={{ position: 'absolute', inset: 0, zIndex: 1 }}
          >
            <ambientLight intensity={0.35} />
            <hemisphereLight intensity={0.6} groundColor="#1f242c" color="#d7dbe2" />
            <directionalLight intensity={0.85} position={[80, 90, 70]} />
            <directionalLight intensity={0.3} position={[-70, -40, -60]} />

            <Suspense fallback={null}>
              {geometry && (
                <ForcePaintMesh
                  geometry={geometry}
                  brushRadius={brushRadius}
                  hoveredVertexIndices={hoveredVertexIndices}
                  paintedVertexGroups={paintedVertexGroups}
                  stressVertexColors={stressVertexColors}
                  onBrushHover={onBrushHover}
                  onBrushPaint={onBrushPaint}
                  onPointerUp={onPointerUp}
                  cursor={brushCursor}
                />
              )}
            </Suspense>

            <OrbitControls
              ref={orbitRef}
              enableDamping
              dampingFactor={0.08}
              enabled
              mouseButtons={{ LEFT: -1, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.ROTATE }}
            />
          </Canvas>

          <div className="viewport-overlay top-left">
            <div className="badge">ORBIT + PAINT · RIGHT DRAG TO ORBIT</div>
            {failureDetected && <div className="badge failure">FAILURE ZONE DETECTED</div>}
          </div>

          <div className="tool-switcher">
            <button type="button" className="tool-btn active">ORBIT + PAINT</button>
            <button type="button" className="tool-btn" onClick={resetViewportState}>RESET</button>
          </div>
        </main>

        <aside className="right-panel">
          <div className="panel-section fixed-height">
            <div className="panel-header">SIMULATION RESULTS</div>
            <div className="panel-body sim-results">
              <div className={`result-state ${simulationResult?.passed ? 'pass' : 'fail'}`}>
                {simulationResult ? (simulationResult.passed ? 'PASSED' : 'FAILED') : 'WAITING'}
              </div>

              <div className="safety-bar-track">
                <div className="safety-bar-fill" style={{ width: `${safetyPct}%` }} />
              </div>
              <div className={`safety-readout ${simulationResult?.passed ? 'pass' : 'fail'}`}>
                SF {formatCompact(simulationResult?.safety_factor)}
              </div>

              <div className="metric-grid">
                <div className="metric-card">
                  <div className="metric-label">MAX STRESS</div>
                  <div className="metric-value">{formatExp(simulationResult?.max_stress)} PA</div>
                </div>
                <div className="metric-card">
                  <div className="metric-label">MIN STRESS</div>
                  <div className="metric-value">{formatExp(simulationResult?.min_stress)} PA</div>
                </div>
                <div className="metric-card">
                  <div className="metric-label">SAFETY FACTOR</div>
                  <div className="metric-value">{formatCompact(simulationResult?.safety_factor)}</div>
                </div>
                <div className="metric-card">
                  <div className="metric-label">ITERATION NUMBER</div>
                  <div className="metric-value">{formatCompact(simulationResult?.iteration_number)}</div>
                </div>
              </div>
            </div>
          </div>

          <div className="panel-section fixed-height">
            <div className="panel-header">STRESS LEGEND</div>
            <div className="panel-body">
              <div className="legend-bar" />
              <div className="legend-labels">
                <span>{formatCompact(minStressMpa)} MPA</span>
                <span>{formatCompact(midStressMpa)} MPA</span>
                <span>{formatCompact(maxStressMpa)} MPA</span>
              </div>
            </div>
          </div>

          <div className="panel-section recs-section">
            <div className="panel-header">AI REDESIGN RECOMMENDATIONS</div>
            <div className="panel-body recs-scroll">
              {Array.isArray(simulationResult?.redesign_recommendations) && simulationResult.redesign_recommendations.length > 0 ? (
                simulationResult.redesign_recommendations.map((rec, idx) => (
                  <div key={`rec-card-${idx}`} className="rec-card">
                    <div className="rec-label">REC {String(idx + 1).padStart(2, '0')} · {specialistLabel(rec)} SPECIALIST</div>
                    <div className="rec-text">
                      {(rec.specific_change || rec.expected_improvement || rec.zone_description || 'NO RECOMMENDATION RETURNED.').toUpperCase()}
                    </div>
                  </div>
                ))
              ) : (
                <div className="empty-note">NO RECOMMENDATIONS YET.</div>
              )}
            </div>
          </div>

          <div className="right-footer">
            <textarea
              className="chat-input"
              style={{ minHeight: 72, marginBottom: 8 }}
              value={forcePrompt}
              onChange={(e) => setForcePrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  parseForcePrompt();
                }
              }}
              placeholder="ENTER ALL FORCES IN PLAIN ENGLISH..."
            />
            <button type="button" className="run-button" onClick={parseForcePrompt} disabled={isLoading}>
              PARSE FORCES
            </button>
            <button
              type="button"
              className={`run-button ${isLoading ? 'running' : ''}`}
              onClick={runSimulation}
              disabled={isLoading}
              style={{ marginTop: 8 }}
            >
              {isLoading ? 'RUNNING...' : 'RUN SIMULATION'}
            </button>
            <div className="status-line">{status}</div>
            {taskProgress.active && taskProgress.kind !== 'model-load' && (
              <div className="task-progress-box">
                <div className="task-progress-title">{taskProgress.title}</div>
                <div className="task-progress-step">{taskProgress.step}</div>
                <div className="task-progress-track">
                  <div
                    className={`task-progress-fill ${taskProgress.percent === null ? 'indeterminate' : ''}`}
                    style={taskProgress.percent === null ? undefined : { width: `${taskProgress.percent}%` }}
                  />
                </div>
                <div className="task-progress-meta">
                  <span>ELAPSED {taskElapsed}</span>
                  <span>{taskProgress.percent === null ? 'ESTIMATING...' : `${taskProgress.percent}%`}</span>
                </div>
              </div>
            )}
            <div className="chat-hint">ENTER TO PARSE · PAINT TO LOCATE</div>
          </div>
        </aside>
      </div>
    </div>
  );
}
