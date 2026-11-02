"""
Build the static GitHub Pages site (docs/index.html) from the synthetic data.

    python scripts/build_site.py

All numbers on the page are computed here with the same modules the tests cover; the HTML only draws.
"""
from __future__ import annotations

import json
import sys
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.analysis.history import execution_profile  # noqa: E402
from src.analysis.utilization import utilization  # noqa: E402
from src.analysis.variance import compute_variance, flag_spikes  # noqa: E402
from src.data.loader import load  # noqa: E402
from src.forecast import aggregate, evaluate, forecast_year_end, summarize  # noqa: E402
from src.forecast.ensemble import Z80  # noqa: E402
from src.forecast.panel import METHOD_LABELS  # noqa: E402

REPO_URL = "https://github.com/S10414/InsurHack"


def nn(x):
    """JSON-safe number."""
    if x is None or (isinstance(x, float) and not np.isfinite(x)):
        return None
    return float(x) if isinstance(x, (float, np.floating)) else int(x) if isinstance(x, (int, np.integer)) else x


def path_arrays(path: pd.DataFrame, month: int) -> dict:
    """Cumulative budget / actual / forecast and an 80% band for a set of series rows."""
    g = path.groupby("month")
    budget = g.budget.sum().to_numpy()
    actual = g.actual.sum(min_count=1).to_numpy()
    fc = g.forecast.sum(min_count=1).to_numpy()
    # series are perfectly correlated over time, independent across series
    var = path.assign(v=path.sd_cum**2).groupby("month").v.sum().to_numpy()
    cum_b = np.cumsum(budget)
    cum_a = np.cumsum(np.nan_to_num(actual[:month]))
    cum_f = cum_a[-1] + np.cumsum(fc[month:])
    sd = np.sqrt(var[month:])
    return {
        "budget": [nn(x) for x in cum_b],
        "actual": [nn(x) for x in cum_a],                       # months 1..m
        "forecast": [nn(x) for x in cum_f],                     # months m+1..12
        "lo": [nn(x) for x in np.maximum(cum_f - Z80 * sd, cum_a[-1])],
        "hi": [nn(x) for x in cum_f + Z80 * sd],
        "month_budget": [nn(x) for x in budget],
        "month_actual": [nn(x) for x in actual[:month]],
        "month_forecast": [nn(x) for x in fc[month:]],
    }


def main() -> None:
    d = load()
    meta = d["metadata"]
    as_of = meta["as_of"]
    year, month = (int(x) for x in as_of.split("-"))
    m, annual = d["budget_actual_monthly"], d["annual_budget"]

    res = forecast_year_end(m, as_of, d["commitments"])
    s = res.series
    prof = execution_profile(annual, m, year, "dept_cat")[["dept_code", "cat_code", "tags", "mean_rate", "q4_gap"]]
    s = s.merge(prof, on=["dept_code", "cat_code"], how="left")
    w = res.weights
    best = w.set_index(["dept_code", "cat_code"])[list(METHOD_LABELS)].idxmax(axis=1).map(METHOD_LABELS)
    s["main_method"] = [best[(a, b)] for a, b in zip(s.dept_code, s.cat_code)]
    s["pace_index"] = s.ytd_actual / s.ytd_budget

    dept = aggregate(res.series, "dept")
    util = utilization(m, as_of, "dept").set_index("dept_code")
    dprof = execution_profile(annual, m, year, "dept").set_index("dept_code")
    total = aggregate(res.series, "total").iloc[0]

    path = res.path.merge(res.series[["dept_code", "cat_code"]], on=["dept_code", "cat_code"])
    names = m[["dept_code", "dept_name"]].drop_duplicates().set_index("dept_code").dept_name

    def series_row(r):
        return {
            "code": r.cat_code, "name": r.cat_name,
            "fy_budget": nn(r.fy_budget), "ytd_budget": nn(r.ytd_budget), "ytd_actual": nn(r.ytd_actual),
            "fy_forecast": nn(r.fy_forecast), "lo": nn(r.lo), "hi": nn(r.hi), "fy_rate": nn(r.fy_rate),
            "p_over": nn(r.p_over), "risk": r.risk, "tags": r.tags, "main_method": r.main_method,
            "commit": nn(r.commit_remaining), "commit_binding": bool(r.commit_binding),
            "pace_index": nn(r.pace_index),
        }

    depts = []
    for r in dept.sort_values("dept_code").itertuples():
        u = util.loc[r.dept_code]
        sub = s[s.dept_code == r.dept_code].sort_values("fy_budget", ascending=False)
        tags = [f"{x.cat_name}：{x.tags}" for x in sub.itertuples() if x.tags != "穩定"]
        depts.append({
            "code": r.dept_code, "name": names[r.dept_code],
            "fy_budget": nn(r.fy_budget), "ytd_budget": nn(r.ytd_budget), "ytd_actual": nn(r.ytd_actual),
            "utilization": nn(u.utilization), "phased_progress": nn(u.phased_progress),
            "pace_index": nn(u.pace_index), "status": u.status,
            "fy_forecast": nn(r.fy_forecast), "lo": nn(r.lo), "hi": nn(r.hi), "fy_rate": nn(r.fy_rate),
            "p_over": nn(r.p_over), "risk": r.risk, "gap": nn(r.gap),
            "history": dprof.loc[r.dept_code, "tags"], "history_detail": tags,
            "cats": [series_row(x) for x in sub.itertuples()],
            "path": path_arrays(path[path.dept_code == r.dept_code], month),
        })

    # ---- alerts (rule-based text; the AI-written summary layer comes later)
    alerts = []
    order = {"紅燈": 0, "黃燈": 1}
    sig = s[~s.risk.str.startswith("綠燈")].copy()
    sig["o"] = sig.risk.str[:2].map(order)
    sig = sig.sort_values(["o", "gap"], key=lambda c: c if c.name == "o" else -c.abs()).head(10)
    for r in sig.itertuples():
        lo_r, hi_r = r.lo / r.fy_budget, r.hi / r.fy_budget
        text = (f"年累計執行 {r.ytd_actual / r.fy_budget:.0%}（預算同期 {r.ytd_budget / r.fy_budget:.0%}），"
                f"預測全年 {r.fy_forecast / 1e6:,.1f} 百萬元，為預算的 {r.fy_rate:.0%}"
                f"（80% 區間 {lo_r:.0%}～{hi_r:.0%}），超支機率 {r.p_over:.0%}。")
        if r.commit_remaining > 0 and r.commit_binding:
            text += f"已簽約未付款 {r.commit_remaining / 1e6:,.1f} 百萬元，預測已納入。"
        if "Q4集中消化" in r.tags:
            text += "歷史上 Q4 會集中消化，年累計落後不代表全年不足。"
        if "長期超支" in r.tags:
            text += "近年執行率持續高於 100%，建議檢討預算基準。"
        alerts.append({"level": r.risk[:2], "title": f"{names[r.dept_code]}・{r.cat_name}：{r.risk[3:]}", "text": text})

    for r in res.one_offs.itertuples():
        row = s[(s.dept_code == r.dept_code) & (s.cat_code == r.cat_code)].iloc[0]
        alerts.append({"level": "提示", "title": f"{names[r.dept_code]}・{row.cat_name}：{r.period} 單月異常",
                       "text": f"當月支出 {r.actual / 1e6:,.1f} 百萬元，約為正常水準的 {r.actual / r.normalized_actual:.1f} 倍，"
                               f"判定為一次性支出；已計入實際數，但不外推到後續月份。"})
    info = s[s.risk.str.startswith("綠燈") & (s.pace_index < 0.90) & s.tags.str.contains("Q4集中消化")]
    for r in info.itertuples():
        alerts.append({"level": "提示", "title": f"{names[r.dept_code]}・{r.cat_name}：執行落後但屬季節性",
                       "text": f"年累計僅執行同期預算的 {r.pace_index:.0%}，但歷史上 Q4 會集中消化，"
                               f"預測全年為預算的 {r.fy_rate:.0%}，不列為風險。"})

    bt = evaluate(m)
    bsum = summarize(bt, year - 1)
    by_month = (bt[(bt.year == year - 1) & bt.model.isin(["ensemble", "budget", "linear"])]
                .pivot(index="as_of_month", columns="model", values="series_wape").reset_index())

    out = {
        "meta": {"as_of": as_of, "year": year, "month": month, "seed": meta["seed"],
                 "built": datetime.now().strftime("%Y-%m-%d"), "repo": REPO_URL, "n_depts": len(depts)},
        "total": {
            "fy_budget": nn(total.fy_budget), "ytd_actual": nn(total.ytd_actual), "ytd_budget": nn(total.ytd_budget),
            "fy_forecast": nn(total.fy_forecast), "lo": nn(total.lo), "hi": nn(total.hi),
            "fy_rate": nn(total.fy_rate), "gap": nn(total.gap),
            "path": path_arrays(path, month),
        },
        "depts": depts,
        "alerts": alerts,
        "backtest": {
            "year": year - 1,
            "summary": [{"model": r.model, "label": r.label, "series": nn(r.series_wape), "dept": nn(r.dept_wape)}
                        for r in bsum.itertuples()],
            "by_month": [{"m": int(r.as_of_month), "ensemble": nn(r.ensemble), "budget": nn(r.budget),
                          "linear": nn(r.linear)} for r in by_month.itertuples()],
        },
        "methods": METHOD_LABELS,
    }

    tpl = (ROOT / "site" / "template.html").read_text(encoding="utf-8")
    html = tpl.replace("/*__DATA__*/null", json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    dest = ROOT / "docs"
    dest.mkdir(exist_ok=True)
    (dest / "index.html").write_text(html, encoding="utf-8")
    (dest / ".nojekyll").write_text("", encoding="utf-8")
    print(f"Wrote {dest / 'index.html'} ({len(html) / 1024:.0f} KB), {len(alerts)} alerts")


if __name__ == "__main__":
    main()
