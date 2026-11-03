# Cardif FP&A Copilot

Entry for the 4th Cardif InsurHack (2026), topic **6-1 Budget Forecasting & Variance Analysis Assistant**:
an AI-assisted tool that tracks departmental expense budgets, compares budget vs. actual, forecasts the
year-end outcome and warns about likely overruns or under-execution.

> All data in `data/synthetic/` is synthetic and not based on any internal Cardif data.

## Live tool (GitHub Pages)

<https://s10414.github.io/InsurHack/> — a static, no-backend budget analysis tool. Load the sample data or upload your own
CSV or Excel (.xlsx) files (budget + actual per department x project x category x month — the project column is optional — plus optional signed
commitments). Everything is computed in the browser.

| Tab | What it does |
|---|---|
| Overview | drill-down company -> department -> project -> expense category: KPIs, budget-composition strip coloured by risk, cumulative chart and table for the current level; flags a department that is green in total but hides red projects |
| Variance | month / QTD / YTD budget vs actual by department, project, category or project x category; waterfall, 24-month trend, one-off detection |
| Year-end forecast | 4 methods + weighted blend + commitment floor, 80% band, what-if on remaining execution rate; filter by department / project / category |
| Alerts | adjustable rules (probability, % and amount materiality), CSV export |
| History | multi-year execution rates per department, project and category, behaviour tags (chronic overrun / underspend / Q4 rush), seasonality chart |
| Reallocation | suggested transfers from safe-surplus lines to likely-overrun lines (same department's other projects first, then other departments, then other categories), with caveats |
| Data | sample / upload CSV or Excel / templates / one-click full Excel report / data-quality warnings |

Every table has CSV and Excel export. Excel upload reads the first sheet as budget/actual and a sheet whose name contains 承諾 (or "commit") as commitments, so an exported report can be loaded back. Excel I/O uses SheetJS community 0.18.5 (Apache-2.0, vendored).

### Front-end stack
- `docs/js/field.js` — WebGL2 "budget field" in the hero: one bar per department x month (actual, or translucent hatched
  forecast), a plate at that month's budget, coloured by spend vs budget. Hover for numbers, click to open that
  department's projects. Hand-written shaders, no 3D library.
- `docs/js/motion.js` — GSAP 3.15 + ScrollTrigger and Lenis 1.3 (vendored in `docs/vendor/`): one load sequence, a pinned
  scroll that tilts the field into a top-down heat map, and transitions only in response to user actions.
  `prefers-reduced-motion` turns smooth scrolling and animation off; browsers without WebGL2 get the headline only.
- GSAP is used under its standard no-charge license; Lenis is MIT.

Pages setting: Settings -> Pages -> Deploy from a branch -> `main` and either `/ (root)` or `/docs` (root redirects to `docs/`).

## Status

| Module | State |
|---|---|
| `src/data/generator.py` synthetic data (10 depts, 24 projects, 8 categories, 2023-2026, commitments) | done |
| `src/analysis/`, `src/forecast/` reference implementation (Python) | done, tested |
| `docs/js/engine.js` browser port of the same logic | done, parity-tested against Python |
| `docs/` UI (7 tabs) | done |
| AI summary / natural-language query (`src/ai/`) | planned |

## Quick start

```bash
pip install -r requirements.txt
python src/data/generator.py          # regenerate data/synthetic (seed 42, as-of 2026-10)
python scripts/export_sample.py       # regenerate docs/js/sample-data.js + tests/fixtures/expected.json
python -m pytest tests -q             # Python tests
node tests/js/parity.test.js          # JS engine must match Python results
python tests/ui/smoke.py              # optional: Chromium smoke test of every tab
```

## Conventions
- Variance = actual - budget; positive means overspend.
- Pace is measured against the budget's own monthly phasing, not a flat 1/12 per month.

## Forecast engine
Four projection methods (YTD pace, recent 3 months, historical seasonality, historical execution rate) are blended per
budget line (department x project x category) using back-test weights, floored by signed commitments, with
single-month one-offs excluded from what the methods learn; projects and departments are sums of their lines.
Walk-forward back-test on 2025 (full-year WAPE): blend 1.4% per budget line and 0.5% per department, vs. "use budget"
4.3% / 3.3% and linear extrapolation 9.3% / 3.5%. On the held-out 2026 actuals every project except the two planted shocks
(delayed core-system project, claims-investigation surge) lands within 3%. Intervals add variances as if independent,
which understates risk for correlated units.

## Planted scenarios (sample data)
| Where | Pattern | What the tool should show |
|---|---|---|
| IT / 核心系統換版 | tender delayed, large contract already signed | yellow: large under-execution; sister projects green |
| Sales / 經代通路拓展 (and, milder, 銀行保險通路經營) | travel, incentives, training over budget every year | red; history tag 長期超支 |
| Marketing / 品牌形象廣告, 新商品上市活動 | spend concentrated in Nov-Dec | not misread as lagging; brand ads still ends ~4% over, so the department is green while one project is red |
| Claims / 委外理賠調查 | outsourced investigation cost x1.75 from June | red; spike detector labels it persistent |
| Finance / TW-ICS 接軌專案 | one-off consulting fee in September | red for the year, but the spike is not extrapolated |
| HR / 人才培育計畫 | training budget chronically under-used | history tag 長期未用完; donor in reallocation |
