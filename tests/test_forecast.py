"""Forecast engine: no look-ahead, internal consistency, back-test beats naive baselines, planted
scenarios are classified sensibly and the 2026 forecast lands near the held-out truth."""
import numpy as np
import pytest

from src.data.generator import generate
from src.forecast import aggregate, evaluate, forecast_year_end, summarize

AS_OF = "2026-10"


@pytest.fixture(scope="module")
def t():
    return generate(seed=42, as_of=AS_OF)


@pytest.fixture(scope="module")
def res(t):
    return forecast_year_end(t["budget_actual_monthly"], AS_OF, t["commitments"])


def test_consistency(t, res):
    s, p = res.series, res.path
    assert (s.fy_forecast >= s.ytd_actual - 1).all()
    assert (s.lo <= s.fy_forecast + 1).all() and (s.hi >= s.fy_forecast - 1).all()
    assert p.forecast.sum() == pytest.approx(s.fc_remaining.sum())
    assert s.fy_budget.sum() == pytest.approx(t["budget_actual_monthly"].query("year == 2026").budget.sum())
    d = aggregate(s, "dept")
    assert d.fy_forecast.sum() == pytest.approx(s.fy_forecast.sum())
    assert (d.sd <= s.groupby("dept_code").sd.sum().values + 1e-6).all()


def test_no_lookahead(t):
    """Changing actuals after the as-of month of a closed year must not change that year's forecast."""
    m = t["budget_actual_monthly"]
    base = forecast_year_end(m, "2025-06").series.fy_forecast.to_numpy()
    m2 = m.copy()
    late = (m2.year == 2025) & (m2.month > 6)
    m2.loc[late, "actual"] = m2.loc[late, "actual"] * 3
    assert np.allclose(base, forecast_year_end(m2, "2025-06").series.fy_forecast.to_numpy())


def test_backtest_beats_baselines(t):
    s = summarize(evaluate(t["budget_actual_monthly"]), 2025).set_index("model")
    assert s.loc["ensemble", "series_wape"] < 0.5 * s.loc["budget", "series_wape"]
    assert s.loc["ensemble", "series_wape"] < s.loc["linear", "series_wape"]
    assert s.loc["ensemble", "dept_wape"] < 0.02


def test_one_off_not_extrapolated(res):
    assert list(res.one_offs.dept_code) == ["FIN"] and res.one_offs.one_off_amount.iloc[0] > 1e7


def test_risk_labels(res):
    d = aggregate(res.series, "dept").set_index("dept_code")
    assert d.loc["IT", "risk"].startswith("黃燈")
    assert d.loc["MKTG", "risk"].startswith("綠燈")      # Q4 rush must not be read as a problem
    for code in ("CLM", "FIN", "SALES"):
        assert d.loc[code, "risk"].startswith("紅燈")
    assert d.loc[["ACT", "CMP", "CS", "ADM", "HR"], "risk"].str.startswith("綠燈").all()


def test_close_to_holdout(t, res):
    truth = t["holdout"].groupby("dept_code").actual.sum()
    d = aggregate(res.series, "dept").set_index("dept_code")
    err = (d.fy_forecast / truth - 1).abs()
    assert abs(res.series.fy_forecast.sum() / truth.sum() - 1) < 0.03
    assert (err.drop("IT") < 0.05).all()                  # IT project catch-up is the known miss
