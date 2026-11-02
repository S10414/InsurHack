"""
Synthetic departmental expense budget data for Cardif FP&A Copilot
(Cardif InsurHack 2026, topic 6-1 Budget Forecasting & Variance Analysis Assistant).

What it produces (all amounts in NTD):
    departments.csv            department master
    projects.csv               projects inside each department + planted behavior profile
    categories.csv             expense category master
    budget_actual_monthly.csv  monthly budget vs actual per dept x project x category, 3 closed years + current year to as-of month
    annual_budget.csv          annual budget / actual per dept x project x category
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
class Project:
    """A budget holder inside a department: a running operation or a time-bound initiative.

    mix is the project's category budget as a share of the *department's* first-year budget.
    """
    code: str
    name_zh: str
    mix: dict[str, float]
    profile: str = "normal"            # planted behavior, see exec_multiplier()
    affected: tuple[str, ...] = ()     # categories the profile applies to
    mu: float | None = None            # override of the underlying annual execution rate
    description: str = ""
    budget_bump_current: dict[str, float] = field(default_factory=dict)  # new phase / scope this year


@dataclass(frozen=True)
class Department:
    code: str
    name_zh: str
    name_en: str
    base_budget: float                 # annual opex budget of the first year, NTD
    projects: tuple[Project, ...]
    description: str = ""

    @property
    def mix(self) -> dict[str, float]:
        out: dict[str, float] = {}
        for p in self.projects:
            for c, v in p.mix.items():
                out[c] = out.get(c, 0.0) + v
        return out


M = 1_000_000
P = Project
DEPARTMENTS: list[Department] = [
    Department("SALES", "業務通路部", "Sales & Distribution", 450 * M, (
        P("SALES-BANCA", "銀行保險通路經營", {"PERS": .28, "MKT": .06, "TRVL": .05, "TRN": .03},
          profile="chronic_overrun", affected=("TRVL", "MKT", "TRN"), mu=1.07,
          description="銀行通路的教育訓練與通路活動每年小幅超支"),
        P("SALES-AGENCY", "經代通路拓展", {"PERS": .22, "MKT": .09, "TRVL": .07, "TRN": .05},
          profile="chronic_overrun", affected=("TRVL", "MKT", "TRN"), mu=1.16,
          description="經紀代理通路的差旅、獎勵活動與訓練每年都超支約 15%，是業務部超支的主因"),
        P("SALES-OPS", "業務支援與據點", {"PERS": .05, "CONS": .03, "IT": .02, "RENT": .03, "MISC": .02}),
    ), description="差旅、通路行銷與業務訓練每年都超支，預算只部分反映"),
    Department("MKTG", "行銷企劃部", "Marketing", 320 * M, (
        P("MKTG-BRAND", "品牌形象廣告", {"MKT": .25, "CONS": .04}, profile="q4_rush", affected=("MKT", "CONS"),
          description="品牌廣告檔期集中在年底，前三季執行偏低"),
        P("MKTG-LAUNCH", "新商品上市活動", {"MKT": .12, "CONS": .03, "TRVL": .01}, profile="q4_rush",
          affected=("MKT", "CONS"), description="新商品於第四季上市，宣傳費用集中在 11~12 月"),
        P("MKTG-DIGI", "數位投保推廣", {"MKT": .18, "IT": .03, "CONS": .03}),
        P("MKTG-OPS", "部門營運", {"PERS": .25, "TRVL": .02, "TRN": .02, "MISC": .02}),
    ), description="前三季執行偏低，11~12 月集中消化預算"),
    Department("IT", "資訊科技部", "Information Technology", 600 * M, (
        P("IT-CORE", "核心系統換版", {"IT": .26, "CONS": .13}, profile="project_delay", affected=("IT", "CONS"),
          description="今年進入第二期，招標延後，前三季執行率明顯落後",
          budget_bump_current={"IT": 1.6, "CONS": 1.4}),
        P("IT-OPS", "系統維運", {"PERS": .30, "IT": .14, "CONS": .03, "RENT": .03, "MISC": .02, "TRN": .02}),
        P("IT-SEC", "資安強化", {"IT": .05, "CONS": .02}),
    ), description="核心系統專案招標延後，前三季執行率明顯落後"),
    Department("CS", "客戶服務部", "Customer Service", 280 * M, (
        P("CS-CALL", "客服中心營運", {"PERS": .55, "CONS": .08, "RENT": .05, "MISC": .03, "TRN": .03}),
        P("CS-DIGI", "智能客服", {"PERS": .10, "IT": .10, "CONS": .04, "TRN": .02}),
    ), description="穩定執行"),
    Department("CLM", "理賠部", "Claims", 220 * M, (
        P("CLM-OPS", "理賠作業", {"PERS": .70, "IT": .06, "TRN": .04, "RENT": .05, "MISC": .03}),
        P("CLM-INV", "委外理賠調查", {"CONS": .12}, profile="emerging_overrun", affected=("CONS",),
          description="理賠案件量上升，下半年委外調查費用暴增"),
    ), description="理賠案件量上升，下半年委外調查與外包費用暴增"),
    Department("ACT", "精算部", "Actuarial", 150 * M, (
        P("ACT-OPS", "精算作業", {"PERS": .62, "IT": .05, "TRN": .04, "MISC": .03, "CONS": .05}),
        P("ACT-IFRS", "IFRS 17 模型維護", {"PERS": .08, "CONS": .10, "IT": .03}),
    ), description="穩定執行"),
    Department("FIN", "財務部", "Finance", 180 * M, (
        P("FIN-OPS", "財會作業", {"PERS": .60, "IT": .06, "TRN": .04, "TRVL": .02, "MISC": .04}),
        P("FIN-ICS", "TW-ICS 接軌專案", {"CONS": .20, "IT": .04}, profile="one_off", affected=("CONS",),
          description="9 月一次性顧問費（新一代清償能力制度與系統調整），單月大幅超支"),
    ), description="9 月一次性顧問費，單月大幅超支"),
    Department("HR", "人力資源部", "Human Resources", 130 * M, (
        P("HR-OPS", "人資作業", {"PERS": .45, "IT": .05, "MISC": .04, "CONS": .08}),
        P("HR-LEARN", "人才培育計畫", {"TRN": .35, "TRVL": .03}, profile="chronic_underspend", affected=("TRN",),
          description="教育訓練預算長期只用 80~88%，有預算寬列跡象"),
    ), description="教育訓練預算長期只用 80~88%，有預算寬列跡象"),
    Department("CMP", "法令遵循部", "Compliance", 120 * M, (
        P("CMP-OPS", "法遵作業", {"PERS": .65, "TRN": .05, "MISC": .03, "CONS": .08}),
        P("CMP-AML", "洗錢防制系統", {"IT": .07, "CONS": .12}),
    ), description="穩定執行"),
    Department("ADM", "行政管理部", "Administration", 350 * M, (
        P("ADM-FAC", "辦公室與設施", {"RENT": .55, "MISC": .10, "CONS": .03}),
        P("ADM-OPS", "行政作業", {"PERS": .20, "MISC": .05, "IT": .05, "CONS": .02}),
    ), description="租金為主，執行最穩定"),
]
del P

# --------------------------------------------------------------------------- #
# Behavior model
# --------------------------------------------------------------------------- #


def annual_exec_rate(proj: Project, cat: str, rng: np.random.Generator) -> float:
    """Underlying full-year execution rate (actual / budget) before monthly shape."""
    mu, sd = 0.97, 0.02
    if cat in proj.affected:
        if proj.profile == "chronic_overrun":
            mu = 1.12
        elif proj.profile == "chronic_underspend":
            mu = 0.84
        elif proj.profile == "q4_rush":
            mu = 1.0  # the monthly shape already pulls the year down a bit
        if proj.mu is not None:
            mu = proj.mu
    return float(rng.normal(mu, sd))


def exec_multiplier(proj: Project, cat: str, year: int, month: int, current_year: int) -> float:
    """Month-level deviation from the budget phasing caused by the planted profile."""
    if cat not in proj.affected:
        return 1.0
    p = proj.profile
    if p == "q4_rush":
        return {10: 1.0, 11: 1.35, 12: 1.6}.get(month, 0.85)
    if p == "project_delay" and year == current_year:
        if month <= 9:
            return 0.5
        return 0.8 if month == 10 else 1.2   # partial catch-up after the tender closes
    if p == "emerging_overrun":
        if year == current_year and month >= 6:
            return 1.75
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
    prev_budget: dict[tuple[str, str, str], float] = {}
    prev_actual: dict[tuple[str, str, str], float] = {}

    for year in years:
        for dept in DEPARTMENTS:
            growth = rng.normal(0.04, 0.01)
            for proj in dept.projects:
                for cat, share in proj.mix.items():
                    key = (dept.code, proj.code, cat)
                    meta = CATEGORIES[cat]

                    # Annual budget: first year from the base; later years anchored 60/40 on last
                    # year's budget and actual, plus growth (so chronic overruns are only partly budgeted).
                    if year == years[0]:
                        budget_annual = dept.base_budget * share
                    else:
                        budget_annual = (0.6 * prev_budget[key] + 0.4 * prev_actual[key]) * (1 + growth)
                    if year == current_year:
                        budget_annual *= proj.budget_bump_current.get(cat, 1.0)
                    budget_annual = round(budget_annual, -3)
                    budget_m = _phase(budget_annual, meta["phasing"])

                    # Actuals: budget phasing x annual execution x planted monthly shape x noise.
                    rate = annual_exec_rate(proj, cat, rng)
                    sigma = meta["sigma"]
                    noise = rng.lognormal(mean=-sigma**2 / 2, sigma=sigma, size=12)
                    shape = np.array([exec_multiplier(proj, cat, year, m, current_year) for m in range(1, 13)])
                    actual_m = budget_m * rate * shape * noise
                    if proj.profile == "one_off" and cat in proj.affected and year == current_year:
                        actual_m[8] += 0.45 * budget_annual   # September lump sum
                    actual_m = np.round(actual_m, -2)

                    ids = {"dept_code": dept.code, "dept_name": dept.name_zh,
                           "proj_code": proj.code, "proj_name": proj.name_zh,
                           "cat_code": cat, "cat_name": meta["name_zh"]}
                    for m in range(1, 13):
                        closed = year < current_year or m <= as_of_month
                        rec = {
                            "year": year, "month": m, "period": f"{year}-{m:02d}", **ids,
                            "budget": budget_m[m - 1],
                            "actual": actual_m[m - 1] if closed else np.nan,
                            "is_closed": closed,
                        }
                        rows.append(rec)
                        if year == current_year:
                            holdout_rows.append({**rec, "actual": actual_m[m - 1], "is_closed": True})

                    annual_rows.append({
                        "year": year, **ids,
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
        proj = PROJECTS[r.proj_code]
        ratio = meta["commit_ratio"]
        if proj.profile == "project_delay" and r.cat_code in proj.affected:
            ratio = 0.8   # tender awarded, large contract already signed
        if ratio == 0:
            continue
        amount = round(r.budget * ratio * (1.0 if r.cat_code == "RENT" else rng.uniform(0.8, 1.2)), -3)
        commit_rows.append({
            "year": r.year, "month": r.month, "period": r.period,
            "dept_code": r.dept_code, "proj_code": r.proj_code, "cat_code": r.cat_code,
            "committed_amount": amount, "commit_type": meta["commit_type"],
        })
    commitments = pd.DataFrame(commit_rows)

    departments = pd.DataFrame([{
        "dept_code": d.code, "dept_name": d.name_zh, "dept_name_en": d.name_en,
        "profile": next((p.profile for p in d.projects if p.profile != "normal"), "normal"),
        "n_projects": len(d.projects), "description": d.description,
    } for d in DEPARTMENTS])
    projects = pd.DataFrame([{
        "dept_code": d.code, "proj_code": p.code, "proj_name": p.name_zh, "profile": p.profile,
        "affected_categories": ",".join(p.affected), "categories": ",".join(p.mix), "description": p.description,
    } for d in DEPARTMENTS for p in d.projects])
    categories = pd.DataFrame([{
        "cat_code": c, "cat_name": v["name_zh"], "cat_name_en": v["name_en"], "commit_type": v["commit_type"],
    } for c, v in CATEGORIES.items()])

    scenarios = [
        {"dept_code": d.code, "proj_code": p.code, "categories": list(p.affected), "profile": p.profile,
         "description": p.description, "expected_signal": EXPECTED_SIGNAL[p.profile]}
        for d in DEPARTMENTS for p in d.projects if p.profile != "normal"
    ]
    metadata = {
        "seed": seed, "as_of": as_of, "current_year": current_year, "years": years,
        "currency": "TWD", "unit": "NTD (元)",
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "note": "Synthetic data. Not based on any internal Cardif data.",
    }
    return {
        "departments": departments, "projects": projects, "categories": categories,
        "budget_actual_monthly": monthly, "annual_budget": annual,
        "commitments": commitments, "holdout": holdout,
        "scenarios": scenarios, "metadata": metadata,
    }


PROJECTS: dict[str, Project] = {p.code: p for d in DEPARTMENTS for p in d.projects}

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
    for name in ["departments", "projects", "categories", "budget_actual_monthly", "annual_budget", "commitments"]:
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
