"""Environment smoke test: every core dependency imports and its native code actually runs.

This is not a model test - it only proves the Python environment is usable.
"""

import importlib
import sys

import pytest

REQUIRED = [
    "numpy",
    "scipy",
    "pandas",
    "pyarrow",
    "sklearn",
    "lightgbm",
    "torch",
    "onnx",
    "onnxruntime",
    "matplotlib",
    "IPython",
    "ipykernel",
    "jupyterlab",
    "sugarsense_ml",
]


def test_python_version():
    assert sys.version_info[:2] == (3, 12)


@pytest.mark.parametrize("module", REQUIRED)
def test_imports(module):
    importlib.import_module(module)


def test_numpy_scipy_pandas_roundtrip():
    import numpy as np
    import pandas as pd
    from scipy import stats

    x = np.linspace(0.0, 1.0, 101)
    df = pd.DataFrame({"x": x, "y": 2.0 * x + 1.0})
    slope = stats.linregress(df["x"], df["y"]).slope
    assert slope == pytest.approx(2.0)


def test_lightgbm_native_library_runs():
    import lightgbm as lgb
    import numpy as np

    rng = np.random.default_rng(0)
    X = rng.normal(size=(200, 3))
    y = X[:, 0] + rng.normal(scale=0.1, size=200)
    model = lgb.LGBMRegressor(objective="quantile", alpha=0.5, n_estimators=5, verbose=-1)
    model.fit(X, y)
    assert model.predict(X).shape == (200,)


def test_torch_runs_on_cpu():
    import torch

    a = torch.ones(2, 3)
    assert float((a @ a.T).sum()) == 12.0


def test_onnxruntime_lists_cpu_provider():
    import onnxruntime as ort

    assert "CPUExecutionProvider" in ort.get_available_providers()
