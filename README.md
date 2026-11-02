# Cardif FP&A Copilot

Entry for the 4th Cardif InsurHack (2026), topic **6-1 Budget Forecasting & Variance Analysis Assistant**:
an AI-assisted tool that tracks departmental expense budgets, compares budget vs. actual, forecasts the
year-end outcome and warns about likely overruns or under-execution.

> All data in `data/synthetic/` is synthetic and not based on any internal Cardif data.

## Live tool (GitHub Pages)

<https://s10414.github.io/InsurHack/> — a static, no-backend budget analysis tool. Load the sample data or upload your own
CSVs (budget + actual per dept x category x month, optional signed commitments). Everything is computed in the browser.

| Tab | What it does |
|---|---|
| Overview | KPIs, company cumulative chart, department table with traffic lights |
| Variance | month / QTD / YTD budget vs actual, waterfall, 24-month trend, one-off detection |
| Year-end forecast | 4 methods + weighted blend + commitment floor, 80% band, what-if on remaining execution rate |
| Alerts | adjustable rules (probability, % and amount materiality), CSV export |
| History | multi-year execution rates, behaviour tags (chronic overrun / underspend / Q4 rush), seasonality chart |
| Reallocation | suggested transfers from safe-surplus lines to likely-overrun lines, with caveats |
| Data | sample / upload / templates / data-quality warnings |

### Front-end stack
- `docs/js/field.js` — WebGL2 "budget field" in the hero: one bar per department x month (actual, or translucent hatched
  forecast), a plate at that month's budget, coloured by spend vs budget. Hover for numbers, click to open that
  department's forecast. Hand-written shaders, no 3D library.
- `docs/js/motion.js` — GSAP 3.15 + ScrollTrigger and Lenis 1.3 (vendored in `docs/vendor/`): one load sequence, a pinned
  scroll that tilts the field into a top-down heat map, and transitions only in response to user actions.
  `prefers-reduced-motion` turns smooth scrolling and animation off; browsers without WebGL2 get the headline only.
- GSAP is used under its standard no-charge license; Lenis is MIT.

Pages setting: Settings -> Pages -> Deploy from a branch -> `main` and either `/ (root)` or `/docs` (root redirects to `docs/`).

## Status

| Module | State |
|---|---|
| `src/data/generator.py` synthetic data (10 depts x 8 categories, 2023-2026, commitments) | done |
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
dept x category using back-test weights, floored by signed commitments, with single-month one-offs excluded from what the
methods learn. Walk-forward back-test on 2025 (full-year WAPE, series level): blend 1.4% vs. "use budget" 5.1% vs. linear
extrapolation 9.9%. Intervals add series variances as if independent, which understates risk for correlated units.
