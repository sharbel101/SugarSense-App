# sugarsense-ml

Python environment for the SugarSense modelling layer (see `../CLAUDE.md`). **No models, datasets or
training code exist yet** - this is only the environment.

## Setup (already done on the dev machine)

```powershell
cd ml
py -3.12 -m venv .venv
.venv\Scripts\python.exe -m pip install -e ".[dev]"
```

Activate with `.venv\Scripts\Activate.ps1`, or call `.venv\Scripts\python.exe` directly.
Exact resolved versions are recorded in `requirements-lock.txt`.

## Checks

```powershell
.venv\Scripts\python.exe -m pytest        # environment smoke test
.venv\Scripts\python.exe -m ruff check .  # lint
```

## Data

`data/` is gitignored. OhioT1DM is released under a data use agreement - never commit raw or derived
patient data.
