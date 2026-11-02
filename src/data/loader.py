"""Load the synthetic budget tables produced by generator.py."""
from __future__ import annotations

import json
from pathlib import Path

import pandas as pd

DEFAULT_DIR = Path(__file__).resolve().parents[2] / "data" / "synthetic"


def load(data_dir: str | Path | None = None, include_holdout: bool = False) -> dict[str, object]:
    """Return {name: DataFrame} plus 'metadata' and 'scenarios' dicts.

    The holdout (true full-year actuals) is only loaded when explicitly asked, so the app
    and the forecast code can never peek at it by accident.
    """
    d = Path(data_dir) if data_dir else DEFAULT_DIR
    if not (d / "budget_actual_monthly.csv").exists():
        raise FileNotFoundError(f"No data in {d}. Run: python src/data/generator.py")

    out: dict[str, object] = {}
    for name in ["departments", "projects", "categories", "budget_actual_monthly", "annual_budget", "commitments"]:
        out[name] = pd.read_csv(d / f"{name}.csv", encoding="utf-8-sig")
    out["budget_actual_monthly"]["is_closed"] = out["budget_actual_monthly"]["is_closed"].astype(bool)
    for name in ["metadata", "scenarios"]:
        out[name] = json.loads((d / f"{name}.json").read_text(encoding="utf-8"))
    if include_holdout:
        out["holdout"] = pd.read_csv(d / "_holdout" / "ground_truth_current_year.csv", encoding="utf-8-sig")
    return out
