"""
Budget vs actual variance.

Sign convention (expense budgets): variance = actual - budget.
    variance > 0  -> 超支 (unfavorable)
    variance < 0  -> 節省 / 未執行 (favorable, or behind plan)
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from . import keys_for, parse_as_of, safe_div, with_scope


def _window_months(month: int, window: str) -> range:
    if window == "month":
        return range(month, month + 1)
    if window == "qtd":
        return range(3 * ((month - 1) // 3) + 1, month + 1)
    if window == "ytd":
        return range(1, month + 1)
    raise ValueError("window must be 'month', 'qtd' or 'ytd'")


def compute_variance(
    monthly: pd.DataFrame,
    as_of: str,
    level: str = "dept",
    window: str = "ytd",
    materiality_pct: float = 0.10,
    materiality_amt: float = 1_000_000,
) -> pd.DataFrame:
    """Budget vs actual for the window ending at `as_of`, grouped by `level`.

    A line is material when BOTH |variance %| >= materiality_pct and |variance| >= materiality_amt,
    so tiny lines with big percentages and big lines with trivial percentages are not flagged.
    """
    year, month = parse_as_of(as_of)
    keys = keys_for(level)
    df = with_scope(monthly)
    df = df[(df.year == year) & df.month.isin(_window_months(month, window)) & df.is_closed]

    out = df.groupby(keys, as_index=False)[["budget", "actual"]].sum()
    out["variance"] = out.actual - out.budget
    out["variance_pct"] = safe_div(out.variance, out.budget)
    out["direction"] = np.where(out.variance > 0, "超支", "節省")
    out["is_material"] = (out.variance_pct.abs() >= materiality_pct) & (out.variance.abs() >= materiality_amt)
    out["window"] = window
    out["as_of"] = as_of
    return out.sort_values("variance", key=np.abs, ascending=False, ignore_index=True)


def variance_trend(
    monthly: pd.DataFrame,
    as_of: str,
    dept: str | None = None,
    cat: str | None = None,
    months: int = 24,
) -> pd.DataFrame:
    """Monthly budget / actual / variance for the last `months` closed months (crosses years).

    Also returns the cumulative YTD variance within each year, which is what the
    "is the gap widening?" chart needs.
    """
    year, month = parse_as_of(as_of)
    df = monthly[monthly.is_closed]
    df = df[(df.year < year) | (df.month <= month)]
    if dept:
        df = df[df.dept_code == dept]
    if cat:
        df = df[df.cat_code == cat]

    out = df.groupby(["year", "month", "period"], as_index=False)[["budget", "actual"]].sum()
    out = out.sort_values("period").tail(months).reset_index(drop=True)
    out["variance"] = out.actual - out.budget
    out["variance_pct"] = safe_div(out.variance, out.budget)
    out["ytd_variance"] = out.groupby("year").variance.cumsum()
    return out


def waterfall_frame(
    monthly: pd.DataFrame,
    as_of: str,
    by: str = "dept",
    dept: str | None = None,
    window: str = "ytd",
    top_n: int = 8,
) -> pd.DataFrame:
    """Budget -> (contribution of each dept or category) -> actual, ready for a Plotly waterfall.

    Columns: label, value, measure ('absolute' | 'relative' | 'total').
    Items beyond `top_n` by absolute variance are lumped into '其他'.
    """
    df = monthly if dept is None else monthly[monthly.dept_code == dept]
    var = compute_variance(df, as_of, level=by, window=window)
    name_col = "dept_name" if by == "dept" else "cat_name"

    head, tail = var.head(top_n), var.iloc[top_n:]
    rows = [{"label": "預算", "value": var.budget.sum(), "measure": "absolute"}]
    rows += [{"label": r[name_col], "value": r.variance, "measure": "relative"} for _, r in head.iterrows()]
    if len(tail):
        rows.append({"label": "其他", "value": tail.variance.sum(), "measure": "relative"})
    rows.append({"label": "實際", "value": var.actual.sum(), "measure": "total"})
    return pd.DataFrame(rows)


def flag_spikes(
    monthly: pd.DataFrame,
    as_of: str,
    ratio_threshold: float = 1.5,
    z_threshold: float = 3.0,
    lookback: int = 12,
) -> pd.DataFrame:
    """Find dept x category months of the current year with abnormal spend.

    A month is a spike when actual >= ratio_threshold x budget AND its actual is z_threshold
    standard deviations above the series' own trailing `lookback` months.
    pattern = '單月異常' (one-off: neighbours are normal) or '持續偏高' (a run of spikes).
    """
    year, month = parse_as_of(as_of)
    df = monthly[monthly.is_closed & ((monthly.year < year) | (monthly.month <= month))].copy()
    df = df.sort_values(["dept_code", "cat_code", "period"])
    g = df.groupby(["dept_code", "cat_code"]).actual
    prior_mean = g.transform(lambda s: s.shift(1).rolling(lookback, min_periods=6).mean())
    prior_std = g.transform(lambda s: s.shift(1).rolling(lookback, min_periods=6).std())

    df["ratio"] = safe_div(df.actual, df.budget)
    df["z"] = safe_div(df.actual - prior_mean, prior_std)
    df["is_spike"] = (df.ratio >= ratio_threshold) & (df.z >= z_threshold)

    # Persistent vs one-off: look at whether neighbouring months are also far above budget.
    # (After the first spike the trailing mean adapts, so z alone would miss the follow-on months.)
    df["_high"] = df.ratio >= ratio_threshold
    hg = df.groupby(["dept_code", "cat_code"])._high
    neighbour = hg.shift(1, fill_value=False) | hg.shift(-1, fill_value=False)
    df["pattern"] = np.where(neighbour, "持續偏高", "單月異常")

    out = df[df.is_spike & (df.year == year)]
    cols = ["period", "dept_code", "dept_name", "cat_code", "cat_name", "budget", "actual", "ratio", "z", "pattern"]
    return out[cols].reset_index(drop=True)
