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
| `src/forecast/` year-end forecast + backtest | next |
| `src/alert/`, `src/optimize/`, `src/ai/`, Streamlit `app/` | planned |

## Quick start

```bash
pip install -r requirements.txt
python src/data/generator.py     # regenerate data/synthetic (seed 42, as-of 2026-10)
python -m pytest tests -q
```

## Conventions
- Variance = actual - budget; positive means overspend.
- Pace is measured against the budget's own monthly phasing, not a flat 1/12 per month.
