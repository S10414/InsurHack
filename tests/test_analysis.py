"""Planted scenarios in the synthetic data must be picked up by the analysis modules.

Run: python -m pytest tests -q
"""
import pytest

from src.data.generator import generate
from src.analysis.variance import compute_variance, flag_spikes, waterfall_frame
from src.analysis.utilization import utilization
from src.analysis.history import execution_profile

AS_OF = "2026-10"


@pytest.fixture(scope="module")
def data():
    t = generate(seed=42, as_of=AS_OF)
    return t["budget_actual_monthly"], t["annual_budget"]


def _row(df, dept, cat=None):
    q = df[df.dept_code == dept]
    if cat:
        q = q[q.cat_code == cat]
    assert len(q) == 1
    return q.iloc[0]


def test_variance_sign_and_totals(data):
    m, _ = data
    v = compute_variance(m, AS_OF, "dept")
    assert (v.variance == v.actual - v.budget).all()
    total = compute_variance(m, AS_OF, "total")
    assert total.budget.iloc[0] == pytest.approx(v.budget.sum())
    w = waterfall_frame(m, AS_OF)
    assert w.iloc[0].value + w[w.measure == "relative"].value.sum() == pytest.approx(w.iloc[-1].value)


def test_material_variances(data):
    m, _ = data
    v = compute_variance(m, AS_OF, "dept_cat")
    mat = v[v.is_material]
    assert _row(mat, "IT", "IT").direction == "節省"          # project delay
    assert _row(mat, "FIN", "CONS").direction == "超支"       # one-off consultant fee
    assert _row(mat, "CLM", "CONS").direction == "超支"       # emerging overrun


def test_utilization_status(data):
    m, _ = data
    u = utilization(m, AS_OF, "dept")
    assert _row(u, "IT").status == "執行落後"
    assert _row(u, "IT").run_rate_ratio > 2                  # would need to triple spending
    assert _row(u, "FIN").status == "執行超前"


def test_spikes(data):
    m, _ = data
    s = flag_spikes(m, AS_OF)
    fin = s[(s.dept_code == "FIN") & (s.cat_code == "CONS")]
    assert list(fin.period) == ["2026-09"] and fin.pattern.iloc[0] == "單月異常"
    clm = s[(s.dept_code == "CLM") & (s.cat_code == "CONS")]
    assert len(clm) and (clm.pattern == "持續偏高").all()


def test_history_tags(data):
    m, a = data
    p = execution_profile(a, m, 2026, "dept_cat")
    for cat in ["TRVL", "MKT", "TRN"]:
        assert "長期超支" in _row(p, "SALES", cat).tags
    assert "長期未用完" in _row(p, "HR", "TRN").tags
    assert "Q4集中消化" in _row(p, "MKTG", "MKT").tags
    # normal departments should mostly be untagged
    normal = p[p.dept_code.isin(["CS", "ACT", "CMP", "ADM"])]
    assert (normal.tags == "穩定").mean() >= 0.8
