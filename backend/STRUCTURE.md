# Backend Module Structure

## Organization

- **core/**: Core FEA and orchestration logic
  - `agents.py`: LangGraph multi-agent pipeline
  - `pipeline.py`: FEA simulation execution and force parsing
  
- **utils/**: Utility functions and helpers
  - `mesh.py`: STL/STEP conversion and preprocessing
  - `calibration_store.py`: Calibration state management
  - `calibrate.py`: Calibration execution
  - `benchmark.py`: Benchmark geometry generation
  - `logger.py`: Session event logging
  
- **models/**: Persistent data storage
  - `fea_calibration.json`: Calibration state
  - `foundry_memory.db`: Iteration history database
  - `MOUSQUETON_default.step`: Default test model
  
- **uploads/**: User-uploaded CAD files

- **app.py**: Flask API entry point (root level)
- **requirements.txt**: Python dependencies (root level)

## Quick Start

```python
from core import run_agent_pipeline
from core.pipeline import run_fenicsx_simulation
from utils import convert_step_to_stl, preprocess_stl
```
