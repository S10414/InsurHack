# Cardif FP&A Copilot

Entry for the 4th Cardif InsurHack (2026), topic **6-1 Budget Forecasting & Variance Analysis Assistant**:
an AI-assisted tool that tracks departmental expense budgets, compares budget vs. actual, forecasts the
year-end outcome and warns about likely overruns or under-execution.

> All data in `data/synthetic/` is synthetic and not based on any internal Cardif data.

## Status

| Module | State |
|---|---|
| `src/data/generator.py` synthetic data (10 depts x 8 categories, 2023-2026, commitments) | done |
| `src/analysis/` variance, utilization, historical execution | done, tested |
| `src/forecast/` year-end forecast + back-test | done, tested |
| `site/` + `docs/` GitHub Pages dashboard | done |
| `src/alert/`, `src/optimize/`, `src/ai/` | planned |

## Quick start

```bash
pip install -r requirements.txt
python src/data/generator.py     # regenerate data/synthetic (seed 42, as-of 2026-10)
python -m pytest tests -q
```

## Conventions
- Variance = actual - budget; positive means overspend.
- Pace is measured against the budget's own monthly phasing, not a flat 1/12 per month.

## Live demo (GitHub Pages)

Static dashboard built from the same modules: <https://s10414.github.io/InsurHack/>

```bash
python scripts/build_site.py     # regenerates docs/index.html (template: site/template.html)
```

## Forecast engine (`src/forecast/`)
Four projection methods (YTD pace, recent 3 months, historical seasonality, historical execution rate) are
blended per dept x category using back-test weights, floored by signed commitments, with single-month
one-offs excluded from what the methods learn. Walk-forward back-test on 2025 (full-year WAPE, series level):
blend 1.4% vs. "use budget" 5.1% vs. linear extrapolation 9.9%.
