# Mission Control data of Lazurio Example Organization

This repository holds the Mission Control planning data of **Lazurio Example
Organization**, Lazurio's public reference Organization. All data is
fictional.

It is a `repository-db` v3 data repository on branch `v3`, mounted in the
Organization root at `mission-control/db/` inside the Mission Control app
checkout. The app code comes from the public upstream
[Lazurio/mission-control](https://github.com/Lazurio/mission-control); this
repository holds only the Organization's data and the control plane copied
from the upstream's `templates/organization-data/`.

| Path | Holds |
|---|---|
| `repository-db.yaml` | The repository-db boundary: remote, branch `v3`, layout and the validate hook |
| `data/mission-control/mission-control.config.json` | Plan prefix `EX`, schema references, the Organization Admin identity and the publish policy |
| `data/mission-control/plans/` | Plans, `plans/<year>/<month>/EX-XXXX-<slug>.yaml` |
| `data/mission-control/roadmaps/` | Roadmaps |
| `data/mission-control/TODO.tasks.json`, `DONE.tasks.json` | Tasks |
| `data/mission-control/ISSUES.open.json`, `ISSUES.resolved.json` | Legacy issue ledgers, read-only; new technical issues are GitHub Issues of the owning repository |
| `data/mission-control/reports/`, `import-reviews/` | Evidence and import reviews |
| `schemas/`, `scripts/validate-mission-control-data.mjs` | Schemas and the validator |

## Validate

```sh
npm install --ignore-scripts --no-package-lock
npm run validate
```

CI runs the same validation on every pull request to `v3`.

## Writing

Plans and tasks are written through the Mission Control App (a local draft,
reviewed and published as one fast-forward commit) or as a pull request to
`v3`. GitHub repository grants are the only access authority. Never force
push, rewrite history or store secrets, tokens or personal runtime state
here.
