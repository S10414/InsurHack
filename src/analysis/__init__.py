"""Budget vs actual analysis: variance, utilization (execution rate) and historical behavior."""
from __future__ import annotations

import pandas as pd

# Grouping levels shared by every analysis function.
LEVELS: dict[str, list[str]] = {
    "total": ["scope"],
    "dept": ["dept_code", "dept_name"],
    "cat": ["cat_code", "cat_name"],
    "dept_cat": ["dept_code", "dept_name", "cat_code", "cat_name"],
}


def parse_as_of(as_of: str) -> tuple[int, int]:
    """'2026-10' -> (2026, 10)."""
    year, month = (int(x) for x in as_of.split("-"))
    if not 1 <= month <= 12:
        raise ValueError(f"bad as_of month: {as_of}")
    return year, month


def keys_for(level: str) -> list[str]:
    if level not in LEVELS:
        raise ValueError(f"level must be one of {list(LEVELS)}, got {level!r}")
    return LEVELS[level]


def with_scope(df: pd.DataFrame) -> pd.DataFrame:
    """Add a constant 'scope' column so level='total' groups like any other level."""
    return df if "scope" in df.columns else df.assign(scope="全公司")


def safe_div(a, b):
    """Elementwise a / b with NaN where b == 0."""
    b = pd.Series(b) if not isinstance(b, pd.Series) else b
    return a / b.where(b != 0)
