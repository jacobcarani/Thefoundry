import { Suspense, useMemo, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Center } from '@react-three/drei';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { MeshStandardMaterial } from 'three';

function StlMesh({ geometry }) {
  const material = useMemo(
    () =>
      new MeshStandardMaterial({
        color: '#f97316',
        metalness: 0.1,
        roughness: 0.5,
      }),
    []
  );

  return (
    <Center>
      <mesh geometry={geometry} material={material} rotation={[-Math.PI / 2, 0, 0]} />
    </Center>
  );
}

export default function App() {
  const [geometry, setGeometry] = useState(null);
  const [status, setStatus] = useState('Upload an STL file to begin.');

  const onFileChange = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setStatus('Uploading STL to backend...');

    const formData = new FormData();
    formData.append('file', file);

    try {
      const uploadResponse = await fetch('http://127.0.0.1:8000/upload/', {
        method: 'POST',
        body: formData,
      });

      if (!uploadResponse.ok) {
        throw new Error(`Upload failed with status ${uploadResponse.status}`);
      }

      const arrayBuffer = await file.arrayBuffer();
      const loader = new STLLoader();
      const parsedGeometry = loader.parse(arrayBuffer);
      parsedGeometry.computeVertexNormals();
      setGeometry(parsedGeometry);
      setStatus('Upload complete. STL rendered successfully.');
    } catch (error) {
      setStatus(`Error: ${error.message}`);
    }
  };

  return (
    <main className="app-shell">
      <header className="panel">
        <h1>The Foundry</h1>
        <p>Milestone: upload STL -&gt; backend save -&gt; browser render.</p>
        <input type="file" accept=".stl" onChange={onFileChange} />
        <p className="status">{status}</p>
      </header>

      <section className="viewer">
        <Canvas camera={{ position: [0, 2, 5], fov: 45 }}>
          <color attach="background" args={['#f8fafc']} />
          <ambientLight intensity={0.6} />
          <directionalLight position={[5, 10, 5]} intensity={0.9} />
          <Suspense fallback={null}>{geometry ? <StlMesh geometry={geometry} /> : null}</Suspense>
          <OrbitControls makeDefault />
        </Canvas>
      </section>
    </main>
  );
}
