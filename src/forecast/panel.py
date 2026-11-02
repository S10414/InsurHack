"""
Array view of the monthly budget table and the four year-end projection methods.

Every method answers one question: "what share of the *remaining budget* will be spent?"
That share is the execution factor f, so remaining spend = f x remaining budget. Because the
remaining budget keeps its own monthly phasing, the factor automatically carries seasonality
(e.g. Q4-heavy marketing) into the monthly path.

    pace       YTD actual / YTD budget                   (the unit keeps its year-to-date pace)
    recent     last-3-month actual / budget              (reacts quickly to a change in behaviour)
    seasonal   YTD / typical share of the year spent by now, from closed years
                                                         (catches Q4 rushes and back-loaded spend)
    hist_rate  typical annual execution rate of closed years x this year's budget
                                                         (catches chronic over/under-spenders)
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

METHODS = ["pace", "recent", "seasonal", "hist_rate"]
METHOD_LABELS = {
    "pace": "年累計進度法",
    "recent": "近三月趨勢法",
    "seasonal": "歷史季節型態法",
    "hist_rate": "歷史執行率法",
}


@dataclass
class Panel:
    keys: pd.DataFrame      # one row per dept x category: dept_code, dept_name, cat_code, cat_name
    years: list[int]
    B: np.ndarray           # budget  (K, Y, 12)
    A: np.ndarray           # actual  (K, Y, 12), NaN where not yet closed

    @property
    def K(self) -> int:
        return len(self.keys)


def build_panel(monthly: pd.DataFrame) -> Panel:
    cols = ["dept_code", "dept_name", "cat_code", "cat_name"]
    keys = monthly[cols].drop_duplicates().sort_values(["dept_code", "cat_code"]).reset_index(drop=True)
    years = sorted(monthly.year.unique().tolist())
    kmap = {(d, c): i for i, (d, c) in enumerate(zip(keys.dept_code, keys.cat_code))}
    ki = np.fromiter((kmap[(d, c)] for d, c in zip(monthly.dept_code, monthly.cat_code)), int, len(monthly))
    yi = monthly.year.map({y: i for i, y in enumerate(years)}).to_numpy()
    mi = monthly.month.to_numpy() - 1

    B = np.full((len(keys), len(years), 12), np.nan)
    A = np.full_like(B, np.nan)
    B[ki, yi, mi] = monthly.budget.to_numpy()
    A[ki, yi, mi] = np.where(monthly.is_closed, monthly.actual, np.nan)
    return Panel(keys, years, B, A)


def _div(a, b):
    a, b = np.asarray(a, dtype=float), np.asarray(b, dtype=float)
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.where(b > 0, a / np.where(b > 0, b, 1.0), np.nan)


def method_factors(P: Panel, yi: int, m: int, recent_n: int = 3) -> np.ndarray:
    """Execution factors (K, len(METHODS)) for year index `yi` as of month `m`.

    Only actuals up to month m of year yi and complete earlier years are read, so the same
    function is used for the live forecast and for honest back-tests. NaN = method unavailable.
    """
    B = P.B[:, yi, :]
    A = P.A[:, yi, :m]
    ytd_a, ytd_b, rem_b = A.sum(1), B[:, :m].sum(1), B[:, m:].sum(1)

    out = np.full((P.K, len(METHODS)), np.nan)
    out[:, 0] = _div(ytd_a, ytd_b)
    lo = max(0, m - recent_n)
    out[:, 1] = _div(A[:, lo:m].sum(1), B[:, lo:m].sum(1))

    prior = list(range(yi))
    if prior:
        Ap, Bp = P.A[:, prior, :], P.B[:, prior, :]
        mean_ratio = _div(Ap[:, :, :m].sum(2), Ap.sum(2)).mean(1)
        out[:, 2] = _div(_div(ytd_a, mean_ratio) - ytd_a, rem_b)
        mean_rate = _div(Ap.sum(2), Bp.sum(2)).mean(1)
        out[:, 3] = _div(mean_rate * (ytd_b + rem_b) - ytd_a, rem_b)
    return np.clip(out, 0, None)


def true_factor(P: Panel, yi: int, m: int) -> np.ndarray:
    """What actually happened to the remaining budget (only for closed years)."""
    return _div(P.A[:, yi, m:].sum(1), P.B[:, yi, m:].sum(1))
