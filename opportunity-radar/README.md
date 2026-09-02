# Opportunity Radar

Local-first, human-approved assistant for discovering, verifying, matching,
drafting and tracking remote jobs and other professional opportunities. Part
of the FTW Labs AI dashboard; runs entirely on your machine.

```bash
npm install
cp .env.example .env   # optional
npm run dev            # http://127.0.0.1:4747/opportunity-radar/
npm test
```

Documentation lives in the repository `docs/` folder:

- [Setup](../docs/opportunity-radar-setup.md) — install, Ollama, résumé folder, scoring, troubleshooting
- [Privacy and safety](../docs/opportunity-radar-privacy-and-safety.md) — what never happens, where data lives, deletion
- [Source policy](../docs/opportunity-radar-source-policy.md) — permitted and refused sources
- [Implementation plan](../docs/opportunity-radar-implementation-plan.md) — architecture and decisions

Nothing here submits applications, uploads files, or sends messages. AI output is advisory.
