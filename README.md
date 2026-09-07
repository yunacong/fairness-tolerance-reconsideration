# Fairness tolerance reconsideration study

Code for *Investigating How Lay Stakeholders Reconsider Fairness Tolerance Thresholds after Viewing Fairness–Accuracy Trade-offs*.

The study collects PRE/POST fairness tolerance decisions, confidence, comprehension responses, SUS and Raw NASA-TLX. The offline pipeline generates fairness–accuracy configurations from 200 fixed predictions; it does not train a model.


## Structure

- `apps/web/`: participant interface and questionnaires.
- `apps/server/`: session handling, SQLite storage and research exports.
- `research/`: frozen configuration generation, protocol, generated assets and metric tests.
- `src/data/results.json`: fixed 200-record prediction asset used by the pipeline.
- `analysis/`: final study analysis and Python dependencies.
- `docs/data-schema.md`: database field definitions.


