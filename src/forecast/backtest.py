"""
Walk-forward back-test of the year-end forecast.

For each closed target year and as-of month, the forecast only sees data up to that month, and its
weights are fitted on *earlier* years only. Error metric: WAPE = sum|forecast - actual| / sum(actual)
of the full-year spend (series = dept x category, dept = aggregated to department).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .ensemble import blend, fit_weights
from .panel import METHODS, METHOD_LABELS, Panel, build_panel, method_factors


def _wape(fc: np.ndarray, act: np.ndarray) -> float:
    return float(np.abs(fc - act).sum() / act.sum())


def evaluate(monthly: pd.DataFrame, target_years: list[int] | None = None,
             as_of_months: tuple[int, ...] = (4, 6, 8, 10)) -> pd.DataFrame:
    """Long table: year, as_of_month, model, series_wape, dept_wape."""
    P = build_panel(monthly)
    closed_years = [y for y in P.years if not np.isnan(P.A[:, P.years.index(y), :]).any()]
    targets = target_years or [y for y in closed_years if y != P.years[0]]
    dept_idx = pd.factorize(P.keys.dept_code)[0]
    nd = dept_idx.max() + 1

    def dept_sum(x):
        return np.bincount(dept_idx, weights=x, minlength=nd)

    rows = []
    for y in targets:
        yi = P.years.index(y)
        actual_fy = P.A[:, yi, :].sum(1)
        B = P.B[:, yi, :]
        for m in as_of_months:
            ytd_a, rem_b = P.A[:, yi, :m].sum(1), B[:, m:].sum(1)
            F = method_factors(P, yi, m)
            W, _, _ = fit_weights(P, m, list(range(1, yi)))
            f_ens = blend(F, W)
            preds = {"ensemble": ytd_a + f_ens * rem_b,
                     "budget": B.sum(1),
                     "linear": ytd_a / m * 12}
            for j, name in enumerate(METHODS):
                f = np.where(np.isnan(F[:, j]), F[:, 0], F[:, j])
                preds[name] = ytd_a + f * rem_b
            for model, fc in preds.items():
                rows.append({
                    "year": y, "as_of_month": m, "model": model,
                    "label": {"ensemble": "加權組合(本系統)", "budget": "直接採用預算",
                              "linear": "線性外推(年累計/月數×12)", **METHOD_LABELS}[model],
                    "series_wape": _wape(fc, actual_fy),
                    "dept_wape": _wape(dept_sum(fc), dept_sum(actual_fy)),
                })
    return pd.DataFrame(rows)


def summarize(bt: pd.DataFrame, year: int) -> pd.DataFrame:
    """Average error over as-of months for one target year, best model first."""
    d = bt[bt.year == year]
    return (d.groupby(["model", "label"], as_index=False)[["series_wape", "dept_wape"]].mean()
            .sort_values("series_wape", ignore_index=True))
