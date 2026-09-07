# Fairness tolerance reconsideration study

Code for *Investigating How Lay Stakeholders Reconsider Fairness Tolerance Thresholds after Viewing Fairness–Accuracy Trade-offs*.

The study collects PRE/POST fairness tolerance decisions, confidence, comprehension responses, SUS and Raw NASA-TLX. The offline pipeline generates fairness–accuracy configurations from 200 fixed predictions; it does not train a model.

## Run

Requires Node.js >=20.19 and Python 3.12+.

```sh
npm ci
npm run data:generate
npm run dev
```

Open http://localhost:5173. The API runs on port 3001. For production: `npm run build`, then `NODE_ENV=production npm start`. Set `RESEARCH_EXPORT_TOKEN` to a private random value before using research export endpoints. `.env.example` lists environment variables; export them in the shell before starting the server.

Validation: `npm run check`; browser tests: `npx playwright install chromium && npm run test:e2e`.

## Structure

- `apps/web/`: participant interface and questionnaires.
- `apps/server/`: session handling, SQLite storage and research exports.
- `research/`: frozen configuration generation, protocol, generated assets and metric tests.
- `src/data/results.json`: fixed 200-record prediction asset used by the pipeline.
- `analysis/`: final study analysis and Python dependencies.
- `docs/data-schema.md`: database field definitions.

## Data and analysis

Participant records and manual qualitative coding are supplied only in the local submission, outside this repository. From `source_code/` in that submission:

```sh
python3 -m pip install -r analysis/requirements.txt
python3 analysis/analyze_study.py
```

Use `--database`, `--coding` and `--output` to override paths. Outputs include participant-level CSVs, summaries and figures. The original analysis includes exploratory/sensitivity statistics in addition to the dissertation's reported Wilcoxon results.

The fixed prediction asset comes from Lin Luo's `LInnnLUooo/Lay-Stakeholder-AI-Fairness-Assessment-Tool`, commit `62d893d`. The upstream asset lacks published split-generation/OOF provenance. Original participant study source: `yunacong/Fairness-Accuracy-Tradeoff-Participant-Study`, commit `4fefc99`. No licence file is present in that source snapshot; this submission adds no new licence grant.
