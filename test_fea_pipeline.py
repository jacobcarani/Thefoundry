#!/usr/bin/env python3
"""
End-to-end FEA pipeline test using the Feb27STEP-JacobCarani_.step file
"""
import requests
import json
import time
from pathlib import Path

API_BASE = 'http://127.0.0.1:5000'
STEP_FILE = Path('Feb27STEP-JacobCarani_.step')

def test_health():
    """Test backend health endpoint"""
    try:
        r = requests.get(f'{API_BASE}/health', timeout=5)
        print(f'✓ Health check: {r.status_code}')
        print(f'  Response: {r.json()}')
        return True
    except Exception as e:
        print(f'✗ Health check failed: {e}')
        return False

def test_upload_step():
    """Upload STEP file"""
    if not STEP_FILE.exists():
        print(f'✗ STEP file not found: {STEP_FILE}')
        return None
    
    try:
        with open(STEP_FILE, 'rb') as f:
            files = {'file': (STEP_FILE.name, f)}
            data = {'resolution': 'high'}
            r = requests.post(f'{API_BASE}/api/upload', files=files, data=data, timeout=30)
        
        if r.status_code == 200:
            upload_data = r.json()
            print(f'✓ Upload successful: {r.status_code}')
            print(f'  Filename: {upload_data.get("filename")}')
            print(f'  Source format: {upload_data.get("source_format")}')
            print(f'  Mesh repaired: {upload_data.get("mesh_repaired")}')
            print(f'  Triangles: {upload_data.get("triangle_count_before")} → {upload_data.get("triangle_count_after")}')
            return upload_data.get('filename')
        else:
            print(f'✗ Upload failed: {r.status_code}')
            print(f'  Error: {r.text}')
            return None
    except Exception as e:
        print(f'✗ Upload error: {e}')
        return None

def test_parse_forces(filename):
    """Test force parsing with Gemini"""
    if not filename:
        return None
    
    painted_region = {
        'region_id': 0,
        'normal': [0, 0, -1],
        'centroid': [0, 0, 0],
        'paintedArea': 100.0,
    }
    
    force_text = "Apply a 500 Newton downward vertical load on the top surface"
    
    try:
        payload = {
            'description': force_text,
            'faces': [painted_region],
            'part_context': {
                'part_purpose': 'Structural bracket for testing',
                'material': '6061 Aluminum',
            }
        }
        r = requests.post(f'{API_BASE}/api/parse_forces', json=payload, timeout=30)
        
        if r.status_code == 200:
            parsed = r.json()
            print(f'✓ Force parsing successful: {r.status_code}')
            print(f'  Parsed forces: {json.dumps(parsed, indent=2)}')
            return parsed
        else:
            print(f'✗ Force parsing failed: {r.status_code}')
            print(f'  Error: {r.text}')
            return None
    except Exception as e:
        print(f'✗ Parse error: {e}')
        return None

def test_run_simulation(filename, parsed_forces):
    """Run FEA simulation"""
    if not filename or not parsed_forces:
        return None
    
    try:
        # Prepare forces with region data
        forces_with_regions = []
        for force in parsed_forces:
            forces_with_regions.append({
                **force,
                'region_id': 0,
                'paintedArea': 100.0,
                'centroid': [0, 0, 0],
                'normal': [0, 0, -1],
            })
        
        payload = {
            'stl_filename': filename,
            'forces': forces_with_regions,
            'resolution': 'high',
        }
        
        print(f'\n📊 Running FEniCSx FEA simulation...')
        r = requests.post(f'{API_BASE}/api/run_simulation', json=payload, timeout=120)
        
        if r.status_code == 200:
            result = r.json()
            print(f'✓ Simulation successful: {r.status_code}')
            print(f'  Solver used: {result.get("solver")}')
            print(f'  Max stress: {result.get("max_stress"):.6e} Pa')
            print(f'  Min stress: {result.get("min_stress"):.6e} Pa')
            print(f'  Safety factor: {result.get("safety_factor"):.3f}')
            print(f'  Result: {"PASSED ✓" if result.get("passed") else "FAILED ✗"}')
            print(f'  Stress points returned: {len(result.get("stress_points", []))}')
            
            if result.get('solver_warning'):
                print(f'  ⚠ Warning: {result.get("solver_warning")}')
            
            return result
        else:
            print(f'✗ Simulation failed: {r.status_code}')
            print(f'  Error: {r.text}')
            return None
    except Exception as e:
        print(f'✗ Simulation error: {e}')
        return None

def main():
    print('=' * 70)
    print('FEA PIPELINE TEST - Using Feb27STEP-JacobCarani_.step')
    print('=' * 70)
    print()
    
    # Test health
    print('Step 1: Health check')
    if not test_health():
        print('\n❌ Backend not responding. Make sure Flask server is running.')
        return
    print()
    
    # Test upload
    print('Step 2: Upload STEP file')
    filename = test_upload_step()
    if not filename:
        print('\n❌ Upload failed.')
        return
    print()
    
    # Test parse
    print('Step 3: Parse force description with Gemini')
    parsed_forces = test_parse_forces(filename)
    if parsed_forces is None:
        print('\n⚠  Parse failed (may be due to missing Gemini API key).')
        parsed_forces = [{'magnitude': 500, 'direction': [0, 0, -1], 'region_id': 0}]
        print('  Using fallback force: 500N downward')
    print()
    
    # Test simulation
    print('Step 4: Run FEniCSx FEA simulation')
    result = test_run_simulation(filename, parsed_forces)
    print()
    
    if result and result.get('solver') == 'fenicsx_cg_hypre':
        print('=' * 70)
        print('✅ SUCCESS: Real FEniCSx solver is active!')
        print('=' * 70)
    elif result:
        print('=' * 70)
        print(f'⚠  Solver used: {result.get("solver")} (not FEniCSx)')
        print('=' * 70)
    else:
        print('=' * 70)
        print('❌ Test failed')
        print('=' * 70)

if __name__ == '__main__':
    main()
