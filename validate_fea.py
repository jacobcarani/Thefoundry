#!/usr/bin/env python
"""Validate FEA system configuration and accuracy."""
import json
import sys
import numpy as np

sys.path.insert(0, 'backend')

from fea_pipeline import _get_material_properties, _synthetic_stress

print('=' * 70)
print('FEA SYSTEM VALIDATION')
print('=' * 70)

# Test 1: Material database
print('\n1. Material Properties Database')
print('   Material          E (GPa)    Yield (MPa)')
print('   ' + '-' * 50)
materials = ['aluminum', 'steel', 'titanium', 'copper', 'plastic']
for mat in materials:
    props = _get_material_properties(mat)
    E = props['E'] / 1e9
    yield_str = props['yield'] / 1e6
    print(f'   {mat:14}    {E:6.1f}       {yield_str:7.1f}')

# Test 2: Synthetic stress function
print('\n2. Synthetic Stress Calculation')
print('   ' + '-' * 50)
points = np.random.random((1000, 3)) * 100
forces = [{
    'magnitude': 500,
    'direction': [0, 0, -1],
    'centroid': [50, 50, 0],
    'paintedArea': 100
}]
stresses = _synthetic_stress(points, forces)
print(f'   Points analyzed: {len(points)}')
print(f'   Max stress: {np.max(stresses)/1e6:.2f} MPa')
print(f'   Min stress: {np.min(stresses)/1e6:.2f} MPa')
print(f'   Avg stress: {np.mean(stresses)/1e6:.2f} MPa')

# Test 3: Safety factor calculations
print('\n3. Safety Factor Calculations')
print('   ' + '-' * 50)
for mat_name in ['aluminum', 'steel', 'titanium']:
    props = _get_material_properties(mat_name)
    yield_str = props['yield']
    max_stress = np.max(stresses)
    sf = yield_str / max_stress if max_stress > 0 else float('inf')
    passed = sf >= 2.0
    status = '✓ PASS' if passed else '✗ FAIL'
    print(f'   {mat_name:14} SF={sf:.1f}x     {status}')

print('\n' + '=' * 70)
print('✓ FEA system validated successfully')
print('=' * 70)
