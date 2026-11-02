"""
Year-end forecast = weighted blend of the four methods, floored by signed commitments.

Weights: each budget line (dept x project x category) gets weights proportional to the inverse of its own back-test
squared error (shrunk 50% toward the all-series average, because only two closed years are available).
Uncertainty: the blend's back-test error, pooled by expense category, scales with the remaining budget.
Intervals add series variances as if independent, which understates risk for correlated units.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
import pandas as pd

from ..analysis import SERIES, keys_for, parse_as_of, with_scope
from ..analysis.variance import flag_spikes
from .panel import METHODS, Panel, build_panel, method_factors, true_factor

Z80 = 1.2816  # two-sided 80% interval


@dataclass
class ForecastResult:
    as_of: str
    series: pd.DataFrame      # one row per budget line (dept x project x category)
    path: pd.DataFrame        # long monthly: budget / actual / forecast and cumulative uncertainty
    weights: pd.DataFrame     # method weights per series
    n_backtest_samples: int
    one_offs: pd.DataFrame    # single-month spikes removed from the learning data


# --------------------------------------------------------------------------- fitting


def fit_weights(P: Panel, m: int, train_yis: list[int], window: int = 2, shrink: float = 0.5,
                sigma_floor: float = 0.03, inflate: float = 1.25, default_sigma: float = 0.12):
    """Return (weights (K, M), sigma (K,), n_samples). Trains on closed years in `train_yis`
    at as-of months within +/- `window` of m."""
    M = len(METHODS)
    if not train_yis:
        return np.ones((P.K, M)) / M, np.full(P.K, default_sigma), 0

    F, T = [], []
    for yi in train_yis:
        for mm in range(max(3, m - window), min(11, m + window) + 1):
            F.append(method_factors(P, yi, mm))
            T.append(true_factor(P, yi, mm))
    F, T = np.stack(F), np.stack(T)                      # (S,K,M), (S,K)
    E = F - T[:, :, None]

    with np.errstate(invalid="ignore"):
        mse_k = np.nanmean(E**2, axis=0)                 # (K,M)
        mse_g = np.nanmean(mse_k, axis=0)                # (M,)
    eff = shrink * mse_g + (1 - shrink) * mse_k
    W = np.where(np.isnan(eff), 0.0, 1.0 / np.maximum(eff, 1e-6))
    W = W / W.sum(1, keepdims=True)

    ens_err = np.nansum(W[None] * np.nan_to_num(E), axis=2)   # (S,K), weights already sum to 1
    var_k = (ens_err**2).mean(0)
    cat = P.keys.cat_code.to_numpy()
    sigma = np.empty(P.K)
    for c in np.unique(cat):
        idx = cat == c
        sigma[idx] = math.sqrt(var_k[idx].mean())
    sigma = inflate * np.maximum(sigma, sigma_floor)
    return W, sigma, F.shape[0]


def blend(F: np.ndarray, W: np.ndarray) -> np.ndarray:
    """Weighted factor, ignoring unavailable (NaN) methods."""
    Wm = np.where(np.isnan(F), 0.0, W)
    return np.nansum(Wm * np.nan_to_num(F), axis=1) / Wm.sum(1)


# --------------------------------------------------------------------------- live forecast


def _commitment_array(P: Panel, commitments: pd.DataFrame | None, year: int) -> np.ndarray:
    C = np.zeros((P.K, 12))
    if commitments is None or commitments.empty:
        return C
    kmap = {k: i for i, k in enumerate(zip(*(P.keys[c] for c in SERIES)))}
    for r in commitments[commitments.year == year].itertuples():
        C[kmap[(r.dept_code, r.proj_code, r.cat_code)], r.month - 1] += r.committed_amount
    return C


def _norm_cdf(x: np.ndarray) -> np.ndarray:
    return 0.5 * (1.0 + np.vectorize(math.erf)(x / math.sqrt(2.0)))


def normalize_one_offs(monthly: pd.DataFrame, as_of: str) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Replace single-month spikes with the series' normal level so they are not extrapolated.

    Returns (adjusted monthly table, list of adjustments). The spike stays in the reported YTD actual;
    it is only removed from the data the projection methods learn from.
    """
    year, as_month = parse_as_of(as_of)
    spikes = flag_spikes(monthly, as_of)
    spikes = spikes[spikes.pattern == "單月異常"]
    adj = monthly.copy()
    log = []
    for r in spikes.itertuples():
        mask = ((adj.year == year) & (adj.dept_code == r.dept_code) & (adj.proj_code == r.proj_code)
                & (adj.cat_code == r.cat_code))
        month = int(r.period[-2:])
        cur = adj[mask & adj.is_closed & (adj.month <= as_month)]
        others = cur[cur.month != month]
        normal_ratio = float((others.actual / others.budget).median())
        i = adj[mask & (adj.month == month)].index[0]
        new_actual = adj.at[i, "budget"] * normal_ratio
        log.append({"period": r.period, "dept_code": r.dept_code, "proj_code": r.proj_code, "cat_code": r.cat_code,
                    "actual": adj.at[i, "actual"], "normalized_actual": new_actual,
                    "one_off_amount": adj.at[i, "actual"] - new_actual})
        adj.at[i, "actual"] = new_actual
    return adj, pd.DataFrame(log, columns=["period", "dept_code", "proj_code", "cat_code", "actual",
                                           "normalized_actual", "one_off_amount"])


def forecast_year_end(monthly: pd.DataFrame, as_of: str, commitments: pd.DataFrame | None = None,
                      floor_commitments: bool = True, adjust_one_offs: bool = True) -> ForecastResult:
    year, m = parse_as_of(as_of)
    if not 1 <= m <= 11:
        raise ValueError("as_of month must be 1..11")
    P = build_panel(monthly)
    yi = P.years.index(year)

    one_offs = pd.DataFrame()
    P_learn = P
    if adjust_one_offs:
        adj, one_offs = normalize_one_offs(monthly, as_of)
        P_learn = build_panel(adj)

    F = method_factors(P_learn, yi, m)
    W, sigma, n = fit_weights(P_learn, m, [i for i in range(1, yi)])
    f_ens = blend(F, W)

    B = P.B[:, yi, :]
    ytd_a, ytd_b, rem_b = P.A[:, yi, :m].sum(1), B[:, :m].sum(1), B[:, m:].sum(1)

    rem_month = B[:, m:] * f_ens[:, None]
    C = _commitment_array(P, commitments, year)[:, m:]
    binding = np.zeros(P.K, dtype=bool)
    if floor_commitments:
        floored = np.maximum(rem_month, C)
        binding = (floored - rem_month).sum(1) > 1.0
        rem_month = floored
    fc_rem = rem_month.sum(1)
    fy_fc = ytd_a + fc_rem

    sd = sigma * rem_b
    s = P.keys.copy()
    s["fy_budget"], s["ytd_budget"], s["ytd_actual"] = B.sum(1), ytd_b, ytd_a
    s["fc_remaining"], s["fy_forecast"] = fc_rem, fy_fc
    s["sd"] = sd
    s["commit_remaining"] = C.sum(1)
    s["commit_binding"] = binding
    for j, name in enumerate(METHODS):
        s[f"f_{name}"] = F[:, j]
    s["f_ensemble"] = f_ens

    # monthly path with cumulative uncertainty (perfectly correlated within a series)
    rows = []
    cum_rem_b = np.cumsum(B[:, m:], axis=1)
    for k in range(P.K):
        for mm in range(12):
            closed = mm < m
            rows.append({
                "dept_code": P.keys.dept_code[k], "proj_code": P.keys.proj_code[k], "cat_code": P.keys.cat_code[k],
                "year": year, "month": mm + 1,
                "budget": B[k, mm],
                "actual": P.A[k, yi, mm] if closed else np.nan,
                "forecast": np.nan if closed else rem_month[k, mm - m],
                "sd_cum": 0.0 if closed else sigma[k] * cum_rem_b[k, mm - m],
            })
    wdf = P.keys[SERIES].copy()
    for j, name in enumerate(METHODS):
        wdf[name] = W[:, j]
    return ForecastResult(as_of, finish(s), pd.DataFrame(rows), wdf, n, one_offs)


# --------------------------------------------------------------------------- aggregation & status


def finish(s: pd.DataFrame) -> pd.DataFrame:
    """Add rate, interval, overrun probability and risk label to a table that has sums + 'sd'."""
    s = s.copy()
    s["fy_rate"] = s.fy_forecast / s.fy_budget
    s["gap"] = s.fy_forecast - s.fy_budget
    s["lo"] = np.maximum(s.fy_forecast - Z80 * s.sd, s.ytd_actual)
    s["hi"] = s.fy_forecast + Z80 * s.sd
    sd = s.sd.to_numpy()
    z = np.where(sd > 0, (s.fy_budget.to_numpy() - s.fy_forecast.to_numpy()) / np.where(sd > 0, sd, 1), np.inf)
    s["p_over"] = 1.0 - _norm_cdf(z)
    s["risk"] = [classify_risk(r, p, g, b) for r, p, g, b in zip(s.fy_rate, s.p_over, s.gap, s.fy_budget)]
    return s


def classify_risk(fy_rate: float, p_over: float, gap: float, fy_budget: float,
                  min_amount: float = 1_000_000) -> str:
    """Traffic light with a materiality test, so a 2% overrun on a NT$13M line is not a red light.

    Red     likely overrun (p >= 75%), at least 0.5% of budget and NT$1M
    Yellow  smaller but probable overrun (p >= 50%, >= 1% of budget and >= NT$0.25M), or a large unspent balance
            (forecast < 85% of budget and at least NT$1M unspent)
    The full alert engine (src/alert) will refine this with drivers and per-department thresholds.
    """
    pct = gap / fy_budget if fy_budget else 0.0
    if p_over >= 0.75 and pct >= 0.005 and gap >= min_amount:
        return "紅燈・預計超支"
    if fy_rate < 0.85 and -gap >= min_amount:
        return "黃燈・預計大幅未執行"
    if p_over >= 0.50 and pct >= 0.01 and gap >= min_amount * 0.25:
        return "黃燈・小幅超支風險"
    return "綠燈・正常"


def aggregate(series: pd.DataFrame, level: str) -> pd.DataFrame:
    keys = keys_for(level)
    s = with_scope(series)
    g = s.groupby(keys, as_index=False).agg(
        fy_budget=("fy_budget", "sum"), ytd_budget=("ytd_budget", "sum"), ytd_actual=("ytd_actual", "sum"),
        fc_remaining=("fc_remaining", "sum"), fy_forecast=("fy_forecast", "sum"),
        commit_remaining=("commit_remaining", "sum"),
        var=("sd", lambda x: float((x**2).sum())),
    )
    g["sd"] = np.sqrt(g.pop("var"))
    return finish(g)
