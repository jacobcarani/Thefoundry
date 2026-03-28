import { useState } from 'react';

export default function PartDescriptionForm({
  forces = [],
  setForces = () => {},
  onSaveDescription = () => {},
  activeForceIndex = -1,
}) {
  const [material, setMaterial] = useState('');
  const [partPurpose, setPartPurpose] = useState('');
  const [savedDescription, setSavedDescription] = useState(null);

  const saveDescription = () => {
    const payload = { material, partPurpose };
    setSavedDescription(payload);
    onSaveDescription(payload);
  };

  const addForce = () => {
    setForces((prev) => [
      ...prev,
      {
        id: Date.now() + Math.floor(Math.random() * 1000),
        type: '',
        magnitude: '',
        direction: '',
        paintedVertexIndices: [],
        normal: [0, 0, 1],
        centroid: [0, 0, 0],
        paintedArea: 0,
      },
    ]);
  };

  const updateForce = (index, key, value) => {
    setForces((prev) => prev.map((force, i) => (i === index ? { ...force, [key]: value } : force)));
  };

  const removeForce = (index) => {
    setForces((prev) => prev.filter((_, i) => i !== index));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <section style={{ background: '#ffffff', border: '1px solid #d8e2f0', borderRadius: 8, padding: 12 }}>
        <h3 style={{ margin: '0 0 10px 0' }}>Part Description</h3>

        <label style={{ display: 'block', fontSize: 13, marginBottom: 4 }}>Material</label>
        <input
          type="text"
          placeholder="e.g. 6061 Aluminum"
          value={material}
          onChange={(e) => setMaterial(e.target.value)}
          style={{ width: '100%', padding: 8, marginBottom: 10 }}
        />

        <label style={{ display: 'block', fontSize: 13, marginBottom: 4 }}>Part Purpose</label>
        <input
          type="text"
          placeholder="e.g. motor mounting bracket"
          value={partPurpose}
          onChange={(e) => setPartPurpose(e.target.value)}
          style={{ width: '100%', padding: 8, marginBottom: 10 }}
        />

        <button
          type="button"
          onClick={saveDescription}
          style={{
            padding: '8px 12px',
            borderRadius: 6,
            border: 'none',
            background: '#2f7a46',
            color: '#fff',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Save Description
        </button>

        {savedDescription && (
          <div style={{ marginTop: 10, fontSize: 13, color: '#24374d' }}>
            <div>
              <strong>Material:</strong> {savedDescription.material || 'N/A'}
            </div>
            <div>
              <strong>Part Purpose:</strong> {savedDescription.partPurpose || 'N/A'}
            </div>
          </div>
        )}
      </section>

      <section style={{ background: '#ffffff', border: '1px solid #d8e2f0', borderRadius: 8, padding: 12 }}>
        <h3 style={{ margin: '0 0 10px 0' }}>Forces Acting on Part</h3>

        <button
          type="button"
          onClick={addForce}
          style={{
            padding: '8px 12px',
            borderRadius: 6,
            border: 'none',
            background: '#2a5d98',
            color: '#fff',
            fontWeight: 600,
            cursor: 'pointer',
            marginBottom: 12,
          }}
        >
          Add Force
        </button>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {forces.map((force, index) => {
            const isActive = index === activeForceIndex;
            const isPlaced = (force.paintedVertexIndices || []).length > 0;

            return (
              <div
                key={force.id}
                style={{
                  padding: 10,
                  borderRadius: 8,
                  border: isActive ? '1px solid #f3b63f' : '1px solid #d8e2f0',
                  background: isActive ? '#fff8e7' : '#f7faff',
                }}
              >
                <div style={{ fontSize: 12, marginBottom: 8 }}>
                  <strong>Force #{index + 1}</strong>{' '}
                  {isPlaced ? '(placed)' : isActive ? '(active)' : '(waiting)'}
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr auto', gap: 6 }}>
                  <select
                    value={force.type}
                    onChange={(e) => updateForce(index, 'type', e.target.value)}
                    style={{ padding: 6 }}
                  >
                    <option value="">Type</option>
                    <option value="Compression">Compression</option>
                    <option value="Tension">Tension</option>
                    <option value="Shear">Shear</option>
                    <option value="Torsion">Torsion</option>
                  </select>

                  <input
                    type="number"
                    placeholder="N"
                    value={force.magnitude}
                    onChange={(e) => updateForce(index, 'magnitude', e.target.value)}
                    style={{ padding: 6 }}
                  />

                  <select
                    value={force.direction}
                    onChange={(e) => updateForce(index, 'direction', e.target.value)}
                    style={{ padding: 6 }}
                  >
                    <option value="">Dir</option>
                    <option value="X+">X+</option>
                    <option value="X-">X-</option>
                    <option value="Y+">Y+</option>
                    <option value="Y-">Y-</option>
                    <option value="Z+">Z+</option>
                    <option value="Z-">Z-</option>
                  </select>

                  <button
                    type="button"
                    onClick={() => removeForce(index)}
                    style={{
                      padding: '6px 8px',
                      borderRadius: 6,
                      border: 'none',
                      background: '#b23b45',
                      color: '#fff',
                      cursor: 'pointer',
                    }}
                  >
                    Remove
                  </button>
                </div>

                {isPlaced && (
                  <div style={{ fontSize: 12, marginTop: 8, color: '#3a4d63' }}>
                    Painted: {(force.paintedVertexIndices || []).length} surface points
                    {force.paintedArea ? ` (${(force.paintedArea).toFixed(3)} units²)` : ''}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
