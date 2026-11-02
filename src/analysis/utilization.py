"""
Budget utilization (預算使用率 / 執行率).

Two ways to judge whether spending is on pace:
    time_progress    = months elapsed / 12            (naive)
    phased_progress  = YTD budget / full-year budget  (respects the budget's own seasonality,
                       e.g. year-end bonuses in February or Q4-heavy marketing)
pace_index = utilization / phased_progress = YTD actual / YTD budget.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from . import keys_for, parse_as_of, safe_div, with_scope


def utilization(
    monthly: pd.DataFrame,
    as_of: str,
    level: str = "dept",
    ahead: float = 0.05,
    behind: float = -0.10,
    recent_n: int = 3,
) -> pd.DataFrame:
    """Execution rate and pace for the current year, grouped by `level`.

    status:  執行超前 if pace_index > 1 + ahead, 執行落後 if pace_index < 1 + behind, else 正常.
    run_rate_ratio = required monthly spend to land exactly on budget / recent monthly spend.
        > 1  the unit must speed up to use its budget (or will underspend)
        < 1  at the current pace the unit will overspend
    """
    year, month = parse_as_of(as_of)
    keys = keys_for(level)
    cur = with_scope(monthly[monthly.year == year])
    closed = cur[cur.is_closed & (cur.month <= month)]

    fy = cur.groupby(keys).budget.sum().rename("fy_budget")
    ytd = closed.groupby(keys)[["budget", "actual"]].sum().rename(columns={"budget": "ytd_budget",
                                                                          "actual": "ytd_actual"})
    recent_months = range(max(1, month - recent_n + 1), month + 1)
    recent = (closed[closed.month.isin(recent_months)].groupby(keys).actual.sum()
              / len(recent_months)).rename("recent_run_rate")

    out = pd.concat([fy, ytd, recent], axis=1).reset_index()
    months_left = 12 - month
    out["utilization"] = safe_div(out.ytd_actual, out.fy_budget)
    out["time_progress"] = month / 12
    out["phased_progress"] = safe_div(out.ytd_budget, out.fy_budget)
    out["pace_index"] = safe_div(out.ytd_actual, out.ytd_budget)
    out["remaining_budget"] = out.fy_budget - out.ytd_actual
    out["months_left"] = months_left
    out["required_run_rate"] = out.remaining_budget / months_left if months_left else np.nan
    out["run_rate_ratio"] = safe_div(out.required_run_rate, out.recent_run_rate)
    out["status"] = np.select(
        [out.pace_index > 1 + ahead, out.pace_index < 1 + behind],
        ["執行超前", "執行落後"],
        default="正常",
    )
    out["as_of"] = as_of
    return out.sort_values("pace_index", ignore_index=True)


def utilization_curve(monthly: pd.DataFrame, as_of: str, dept: str | None = None,
                      cat: str | None = None, proj: str | None = None) -> pd.DataFrame:
    """Cumulative budget vs actual (% of full-year budget) by month, for the S-curve chart."""
    year, month = parse_as_of(as_of)
    df = monthly[monthly.year == year]
    if dept:
        df = df[df.dept_code == dept]
    if proj:
        df = df[df.proj_code == proj]
    if cat:
        df = df[df.cat_code == cat]
    m = df.groupby("month")[["budget", "actual"]].sum(min_count=1).reset_index()
    fy_budget = m.budget.sum()
    m["cum_budget_pct"] = m.budget.cumsum() / fy_budget
    m.loc[m.month <= month, "cum_actual_pct"] = m.loc[m.month <= month, "actual"].cumsum() / fy_budget
    return m
