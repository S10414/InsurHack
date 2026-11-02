"""
Synthetic departmental expense budget data for Cardif FP&A Copilot
(Cardif InsurHack 2026, topic 6-1 Budget Forecasting & Variance Analysis Assistant).

What it produces (all amounts in NTD):
    departments.csv            department master + planted behavior profile
    categories.csv             expense category master
    budget_actual_monthly.csv  monthly budget vs actual, 3 closed years + current year to as-of month
    annual_budget.csv          annual budget / actual per department x category
    commitments.csv            open contracts / POs for the remaining months of the current year
    scenarios.json             ground truth of planted patterns (for testing alerts)
    metadata.json              seed, as-of month, units
    _holdout/ground_truth_current_year.csv
                               the "true" full-year actuals of the current year, hidden from the app,
                               used only to score the year-end forecast

Usage:
    python src/data/generator.py                     # default: seed 42, as-of 2026-10
    python src/data/generator.py --as-of 2026-09 --seed 7 --out data/synthetic

Or from code:
    from src.data.generator import generate
    tables = generate(seed=42, as_of="2026-10")
"""
from __future__ import annotations

import argparse
import json
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd

# --------------------------------------------------------------------------- #
# Master data
# --------------------------------------------------------------------------- #

CATEGORIES: dict[str, dict] = {
    # code: name, monthly phasing weights (Jan..Dec), monthly noise (lognormal sigma), commitment type
    "PERS": {"name_zh": "人事費用", "name_en": "Personnel",
             "phasing": [1.0, 2.2, 1.0, 1.0, 1.0, 1.0, 1.1, 1.0, 1.0, 1.0, 1.0, 1.0],  # 年終獎金 in Feb
             "sigma": 0.02, "commit_ratio": 0.0, "commit_type": None},
    "MKT":  {"name_zh": "行銷廣告", "name_en": "Marketing & Advertising",
             "phasing": [0.6, 0.7, 1.0, 1.0, 1.1, 1.0, 0.9, 0.9, 1.1, 1.2, 1.3, 1.2],
             "sigma": 0.12, "commit_ratio": 0.30, "commit_type": "採購單"},
    "IT":   {"name_zh": "資訊軟硬體", "name_en": "IT Hardware & Software",
             "phasing": [0.6, 0.7, 0.9, 1.0, 1.0, 1.1, 1.0, 1.0, 1.1, 1.1, 1.2, 1.3],
             "sigma": 0.10, "commit_ratio": 0.50, "commit_type": "合約"},
    "CONS": {"name_zh": "外包顧問", "name_en": "Outsourcing & Consulting",
             "phasing": [0.5, 0.6, 0.9, 1.0, 1.0, 1.1, 1.0, 1.0, 1.1, 1.2, 1.3, 1.3],
             "sigma": 0.10, "commit_ratio": 0.40, "commit_type": "合約"},
    "TRVL": {"name_zh": "差旅交際", "name_en": "Travel & Entertainment",
             "phasing": [0.7, 0.6, 1.0, 1.1, 1.1, 1.0, 1.0, 0.9, 1.0, 1.1, 1.2, 1.3],
             "sigma": 0.12, "commit_ratio": 0.05, "commit_type": "採購單"},
    "RENT": {"name_zh": "租金及設施", "name_en": "Rent & Facilities",
             "phasing": [1.0] * 12,
             "sigma": 0.01, "commit_ratio": 1.00, "commit_type": "租約"},
    "TRN":  {"name_zh": "教育訓練", "name_en": "Training",
             "phasing": [0.5, 0.6, 1.2, 1.2, 1.1, 1.0, 0.8, 0.8, 1.2, 1.2, 1.2, 1.2],
             "sigma": 0.15, "commit_ratio": 0.15, "commit_type": "採購單"},
    "MISC": {"name_zh": "其他雜支", "name_en": "Miscellaneous",
             "phasing": [0.9, 0.9, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.1, 1.1],
             "sigma": 0.08, "commit_ratio": 0.05, "commit_type": "採購單"},
}


@dataclass(frozen=True)
class Department:
    code: str
    name_zh: str
    name_en: str
    base_budget: float                 # annual opex budget of the first year, NTD
    mix: dict[str, float]              # category share of the budget, sums to 1
    profile: str = "normal"            # planted behavior, see exec_multiplier()
    affected: tuple[str, ...] = ()     # categories the profile applies to
    description: str = ""
    budget_bump_current: dict[str, float] = field(default_factory=dict)  # new initiatives this year


M = 1_000_000
DEPARTMENTS: list[Department] = [
    Department("SALES", "業務通路部", "Sales & Distribution", 450 * M,
               {"PERS": .55, "MKT": .15, "TRVL": .12, "TRN": .08, "CONS": .03, "IT": .02, "RENT": .03, "MISC": .02},
               profile="chronic_overrun", affected=("TRVL", "MKT", "TRN"),
               description="差旅、通路行銷與業務訓練每年都超支約 10%，預算只部分反映"),
    Department("MKTG", "行銷企劃部", "Marketing", 320 * M,
               {"MKT": .55, "PERS": .25, "CONS": .10, "TRVL": .03, "IT": .03, "TRN": .02, "MISC": .02},
               profile="q4_rush", affected=("MKT", "CONS"),
               description="前三季執行偏低，11~12 月集中消化預算"),
    Department("IT", "資訊科技部", "Information Technology", 600 * M,
               {"PERS": .30, "IT": .45, "CONS": .18, "TRN": .02, "RENT": .03, "MISC": .02},
               profile="project_delay", affected=("IT", "CONS"),
               description="今年新增核心系統專案，招標延後，前三季執行率明顯落後",
               budget_bump_current={"IT": 1.35, "CONS": 1.25}),
    Department("CS", "客戶服務部", "Customer Service", 280 * M,
               {"PERS": .65, "IT": .10, "CONS": .12, "TRN": .05, "RENT": .05, "MISC": .03},
               description="穩定執行"),
    Department("CLM", "理賠部", "Claims", 220 * M,
               {"PERS": .70, "CONS": .12, "IT": .06, "TRN": .04, "RENT": .05, "MISC": .03},
               profile="emerging_overrun", affected=("CONS",),
               description="理賠案件量上升，下半年委外調查與外包費用暴增"),
    Department("ACT", "精算部", "Actuarial", 150 * M,
               {"PERS": .70, "CONS": .15, "IT": .08, "TRN": .04, "MISC": .03},
               description="穩定執行"),
    Department("FIN", "財務部", "Finance", 180 * M,
               {"PERS": .60, "CONS": .20, "IT": .10, "TRN": .04, "TRVL": .02, "MISC": .04},
               profile="one_off", affected=("CONS",),
               description="9 月一次性顧問費（會計準則與系統調整），單月大幅超支"),
    Department("HR", "人力資源部", "Human Resources", 130 * M,
               {"PERS": .45, "TRN": .35, "CONS": .08, "IT": .05, "TRVL": .03, "MISC": .04},
               profile="chronic_underspend", affected=("TRN",),
               description="教育訓練預算長期只用 80~88%，有預算寬列跡象"),
    Department("CMP", "法令遵循部", "Compliance", 120 * M,
               {"PERS": .65, "CONS": .20, "IT": .07, "TRN": .05, "MISC": .03},
               description="穩定執行"),
    Department("ADM", "行政管理部", "Administration", 350 * M,
               {"RENT": .55, "PERS": .20, "MISC": .15, "IT": .05, "CONS": .05},
               description="租金為主，執行最穩定"),
]

# --------------------------------------------------------------------------- #
# Behavior model
# --------------------------------------------------------------------------- #


def annual_exec_rate(dept: Department, cat: str, rng: np.random.Generator) -> float:
    """Underlying full-year execution rate (actual / budget) before monthly shape."""
    mu, sd = 0.97, 0.02
    if dept.profile == "chronic_overrun" and cat in dept.affected:
        mu = 1.12
    elif dept.profile == "chronic_underspend" and cat in dept.affected:
        mu = 0.84
    elif dept.profile == "q4_rush" and cat in dept.affected:
        mu = 1.0  # the monthly shape already pulls the year down a bit
    return float(rng.normal(mu, sd))


def exec_multiplier(dept: Department, cat: str, year: int, month: int, current_year: int) -> float:
    """Month-level deviation from the budget phasing caused by the planted profile."""
    if cat not in dept.affected:
        return 1.0
    p = dept.profile
    if p == "q4_rush":
        return {10: 1.0, 11: 1.35, 12: 1.6}.get(month, 0.85)
    if p == "project_delay" and year == current_year:
        if month <= 9:
            return 0.5
        return 0.8 if month == 10 else 1.2   # partial catch-up after the tender closes
    if p == "emerging_overrun":
        if year == current_year and month >= 6:
            return 1.6
        if year == current_year - 1 and month >= 10:
            return 1.15                      # early sign last year
    return 1.0


def _phase(annual: float, weights: list[float]) -> np.ndarray:
    """Split an annual amount into 12 months by weights, rounded to NTD 1,000, summing exactly."""
    w = np.asarray(weights, dtype=float)
    monthly = np.round(annual * w / w.sum(), -3)
    monthly[-1] += round(annual, -3) - monthly.sum()
    return monthly


# --------------------------------------------------------------------------- #
# Generator
# --------------------------------------------------------------------------- #


def generate(seed: int = 42, as_of: str = "2026-10", n_history: int = 3) -> dict[str, object]:
    """Build all tables. `as_of` is the last closed month of the current year (YYYY-MM)."""
    rng = np.random.default_rng(seed)
    current_year, as_of_month = (int(x) for x in as_of.split("-"))
    if not 1 <= as_of_month <= 11:
        raise ValueError("as_of month must be 1..11 so that there is something left to forecast")
    years = list(range(current_year - n_history, current_year + 1))

    rows, holdout_rows, annual_rows = [], [], []
    prev_budget: dict[tuple[str, str], float] = {}
    prev_actual: dict[tuple[str, str], float] = {}

    for year in years:
        for dept in DEPARTMENTS:
            growth = rng.normal(0.04, 0.01)
            for cat, share in dept.mix.items():
                key = (dept.code, cat)
                meta = CATEGORIES[cat]

                # Annual budget: first year from the base; later years anchored 60/40 on last
                # year's budget and actual, plus growth (so chronic overruns are only partly budgeted).
                if year == years[0]:
                    budget_annual = dept.base_budget * share
                else:
                    budget_annual = (0.6 * prev_budget[key] + 0.4 * prev_actual[key]) * (1 + growth)
                if year == current_year:
                    budget_annual *= dept.budget_bump_current.get(cat, 1.0)
                budget_annual = round(budget_annual, -3)
                budget_m = _phase(budget_annual, meta["phasing"])

                # Actuals: budget phasing x annual execution x planted monthly shape x noise.
                rate = annual_exec_rate(dept, cat, rng)
                sigma = meta["sigma"]
                noise = rng.lognormal(mean=-sigma**2 / 2, sigma=sigma, size=12)
                shape = np.array([exec_multiplier(dept, cat, year, m, current_year) for m in range(1, 13)])
                actual_m = budget_m * rate * shape * noise
                if dept.profile == "one_off" and cat in dept.affected and year == current_year:
                    actual_m[8] += 0.45 * budget_annual   # September lump sum
                actual_m = np.round(actual_m, -2)

                for m in range(1, 13):
                    closed = year < current_year or m <= as_of_month
                    rec = {
                        "year": year, "month": m, "period": f"{year}-{m:02d}",
                        "dept_code": dept.code, "dept_name": dept.name_zh,
                        "cat_code": cat, "cat_name": meta["name_zh"],
                        "budget": budget_m[m - 1],
                        "actual": actual_m[m - 1] if closed else np.nan,
                        "is_closed": closed,
                    }
                    rows.append(rec)
                    if year == current_year:
                        holdout_rows.append({**rec, "actual": actual_m[m - 1], "is_closed": True})

                annual_rows.append({
                    "year": year, "dept_code": dept.code, "dept_name": dept.name_zh,
                    "cat_code": cat, "cat_name": meta["name_zh"],
                    "annual_budget": budget_annual,
                    "annual_actual": actual_m.sum() if year < current_year else np.nan,
                })
                prev_budget[key], prev_actual[key] = budget_annual, actual_m.sum()

    monthly = pd.DataFrame(rows)
    annual = pd.DataFrame(annual_rows)
    holdout = pd.DataFrame(holdout_rows)

    # Commitments: signed contracts / POs not yet paid, for the open months of the current year.
    open_months = monthly[(monthly.year == current_year) & (~monthly.is_closed)]
    commit_rows = []
    for r in open_months.itertuples():
        meta = CATEGORIES[r.cat_code]
        dept = next(d for d in DEPARTMENTS if d.code == r.dept_code)
        ratio = meta["commit_ratio"]
        if dept.profile == "project_delay" and r.cat_code in dept.affected:
            ratio = 0.8   # tender awarded, large contract already signed
        if ratio == 0:
            continue
        amount = round(r.budget * ratio * (1.0 if r.cat_code == "RENT" else rng.uniform(0.8, 1.2)), -3)
        commit_rows.append({
            "year": r.year, "month": r.month, "period": r.period,
            "dept_code": r.dept_code, "cat_code": r.cat_code,
            "committed_amount": amount, "commit_type": meta["commit_type"],
        })
    commitments = pd.DataFrame(commit_rows)

    departments = pd.DataFrame([{
        "dept_code": d.code, "dept_name": d.name_zh, "dept_name_en": d.name_en,
        "profile": d.profile, "affected_categories": ",".join(d.affected), "description": d.description,
    } for d in DEPARTMENTS])
    categories = pd.DataFrame([{
        "cat_code": c, "cat_name": v["name_zh"], "cat_name_en": v["name_en"], "commit_type": v["commit_type"],
    } for c, v in CATEGORIES.items()])

    scenarios = [
        {"dept_code": d.code, "categories": list(d.affected), "profile": d.profile,
         "description": d.description, "expected_signal": EXPECTED_SIGNAL[d.profile]}
        for d in DEPARTMENTS if d.profile != "normal"
    ]
    metadata = {
        "seed": seed, "as_of": as_of, "current_year": current_year, "years": years,
        "currency": "TWD", "unit": "NTD (元)",
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "note": "Synthetic data. Not based on any internal Cardif data.",
    }
    return {
        "departments": departments, "categories": categories,
        "budget_actual_monthly": monthly, "annual_budget": annual,
        "commitments": commitments, "holdout": holdout,
        "scenarios": scenarios, "metadata": metadata,
    }


EXPECTED_SIGNAL = {
    "chronic_overrun": "年底預測超支；歷史執行率連續 >105%，建議調整預算基準",
    "q4_rush": "YTD 執行率低於時間進度，但歷史型態顯示 Q4 會補上，不應誤判為落後",
    "project_delay": "YTD 嚴重落後；承諾支出高，年底仍可能大幅未執行，提示專案進度風險",
    "emerging_overrun": "下半年月度差異持續擴大，年底預測超支，屬新出現的風險",
    "one_off": "單月重大差異，排除一次性項目後趨勢正常",
    "chronic_underspend": "歷年執行率 80~88%，建議調降明年預算或重分配餘額",
}


def save(tables: dict[str, object], out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "_holdout").mkdir(exist_ok=True)
    for name in ["departments", "categories", "budget_actual_monthly", "annual_budget", "commitments"]:
        tables[name].to_csv(out_dir / f"{name}.csv", index=False, encoding="utf-8-sig")
    tables["holdout"].to_csv(out_dir / "_holdout" / "ground_truth_current_year.csv",
                             index=False, encoding="utf-8-sig")
    for name in ["scenarios", "metadata"]:
        (out_dir / f"{name}.json").write_text(json.dumps(tables[name], ensure_ascii=False, indent=2),
                                              encoding="utf-8")


def _default_out() -> Path:
    # src/data/generator.py -> repo root -> data/synthetic
    return Path(__file__).resolve().parents[2] / "data" / "synthetic"


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate synthetic department budget data.")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--as-of", default="2026-10", help="last closed month of the current year, YYYY-MM")
    parser.add_argument("--out", type=Path, default=_default_out())
    args = parser.parse_args()

    tables = generate(seed=args.seed, as_of=args.as_of)
    save(tables, args.out)
    m = tables["budget_actual_monthly"]
    print(f"Wrote {len(m):,} monthly rows, {len(tables['commitments']):,} commitments to {args.out}")


if __name__ == "__main__":
    main()
