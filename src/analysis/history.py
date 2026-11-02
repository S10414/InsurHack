"""
Historical budget execution (歷史預算執行情況).

Used for two things:
    1. Describe each unit's track record (rates, trend, Q4 behaviour) and tag it.
    2. Feed the year-end forecast: how much of the full year is usually spent by month m?
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from . import keys_for, safe_div, with_scope


def annual_execution(annual: pd.DataFrame, level: str = "dept", current_year: int | None = None) -> pd.DataFrame:
    """Execution rate (actual / budget) per closed year, one column per year."""
    keys = keys_for(level)
    df = with_scope(annual.dropna(subset=["annual_actual"]))
    if current_year is not None:
        df = df[df.year < current_year]
    g = df.groupby(keys + ["year"])[["annual_budget", "annual_actual"]].sum()
    rate = safe_div(g.annual_actual, g.annual_budget).rename("rate")
    return rate.unstack("year").reset_index()


def completion_ratio(monthly: pd.DataFrame, month: int, level: str = "dept_cat",
                     current_year: int | None = None) -> pd.DataFrame:
    """Share of the full-year actual typically spent by the end of `month`, across closed years.

    mean_ratio = 0.70 means: historically 70% of the year's spend had happened by `month`.
    """
    keys = keys_for(level)
    df = with_scope(monthly)
    if current_year is not None:
        df = df[df.year < current_year]
    fy = df.groupby(keys + ["year"]).actual.sum()
    to_date = df[df.month <= month].groupby(keys + ["year"]).actual.sum()
    r = safe_div(to_date, fy).rename("ratio").reset_index()
    return (r.groupby(keys).ratio.agg(mean_ratio="mean", std_ratio="std", n_years="count").reset_index())


def execution_profile(
    annual: pd.DataFrame,
    monthly: pd.DataFrame,
    current_year: int,
    level: str = "dept_cat",
    over: float = 1.03,
    under: float = 0.92,
    q4_gap_threshold: float = 0.05,
    trend_threshold: float = 0.05,
) -> pd.DataFrame:
    """Track record per unit with behaviour tags.

    Tags (a unit may carry several):
        長期超支     every closed year >= 100% and the average >= `over`
        長期未用完   every closed year <= 100% and the average <= `under`
        Q4集中消化   Q4 share of actual spend exceeds Q4 share of budget by >= `q4_gap_threshold`
        執行率上升 / 執行率下降   monotonic, slope >= +/-`trend_threshold` per year
        穩定         none of the above
    """
    keys = keys_for(level)
    rates = annual_execution(annual, level, current_year)
    year_cols = [c for c in rates.columns if isinstance(c, (int, np.integer))]
    r = rates[year_cols]

    out = rates[keys].copy()
    out["mean_rate"], out["min_rate"], out["max_rate"] = r.mean(axis=1), r.min(axis=1), r.max(axis=1)
    out["std_rate"] = r.std(axis=1)
    if len(year_cols) >= 2:
        x = np.asarray(year_cols, dtype=float)
        out["trend_per_year"] = r.apply(lambda row: np.polyfit(x, row.values, 1)[0], axis=1)
    else:
        out["trend_per_year"] = np.nan
    out["last_year_rate"] = r[max(year_cols)]
    diffs = r.diff(axis=1).iloc[:, 1:]
    out["monotonic_up"] = (diffs > 0).all(axis=1) & (len(year_cols) >= 2)
    out["monotonic_down"] = (diffs < 0).all(axis=1) & (len(year_cols) >= 2)

    # Q4 behaviour: actual Q4 share minus budget Q4 share, averaged over closed years.
    m = with_scope(monthly[monthly.year < current_year])
    tot = m.groupby(keys + ["year"])[["budget", "actual"]].sum()
    q4 = m[m.month >= 10].groupby(keys + ["year"])[["budget", "actual"]].sum()
    gap = (safe_div(q4.actual, tot.actual) - safe_div(q4.budget, tot.budget)).rename("q4_gap")
    out = out.merge(gap.groupby(keys).mean().reset_index(), on=keys, how="left")

    def tags(row) -> str:
        t = []
        if row.min_rate >= 1.0 and row.mean_rate >= over:
            t.append("長期超支")
        if row.max_rate <= 1.0 and row.mean_rate <= under:
            t.append("長期未用完")
        if row.q4_gap >= q4_gap_threshold:
            t.append("Q4集中消化")
        # Trend needs a clear slope AND a monotonic path, otherwise 3 noisy years produce false tags.
        if row.monotonic_up and row.trend_per_year >= trend_threshold:
            t.append("執行率上升")
        elif row.monotonic_down and row.trend_per_year <= -trend_threshold:
            t.append("執行率下降")
        return "、".join(t) if t else "穩定"

    out["tags"] = out.apply(tags, axis=1)
    rate_cols = {c: f"rate_{c}" for c in year_cols}
    return out.merge(rates.rename(columns=rate_cols), on=keys)
