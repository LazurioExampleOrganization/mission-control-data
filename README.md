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

## Main roadmap: schema and rollback (2026-11-01)

The roadmap schema and the validator are copies of `templates/organization-data/`
of [Lazurio/mission-control v3.1.0](https://github.com/Lazurio/mission-control/releases/tag/v3.1.0),
which the App integrates in LazurioExampleOrganization/mission-control#4. They
add an optional approximate step timing `timing` and the flag `main: true`,
which at most one roadmap carries, and never an archived one. The App and this
data change in one short window: an updated App refuses inbound data on the
old schema, and an App on 3.0.x cannot import data on the new one.

**Rollback**, when the new App or schema fails and a fix forward cannot come
in time. Every step is a new commit through a pull request, never a reset or a
force push, so data published after the window stays; only the `main` and
`timing` fields go.

1. Find out whether roadmaps already use the new fields. From the root of a
   fresh `v3` checkout, after the install above:

   ```sh
   node --input-type=module -e 'import{execFileSync as x}from"node:child_process";import{readFileSync as r}from"node:fs";import{parse as p}from"yaml";const h=x("git",["ls-files","data/mission-control/roadmaps"],{encoding:"utf8"}).split("\n").filter(f=>/\.ya?ml$/.test(f)).flatMap(f=>{const d=p(r(f,"utf8"))??{};return[...(Object.hasOwn(d,"main")?[f+": main"]:[]),...(Array.isArray(d.steps)?d.steps:[]).flatMap((s,i)=>s&&Object.hasOwn(s,"timing")?[f+": steps["+i+"].timing"]:[])]});console.log(h.length?h.join("\n"):"no roadmap uses main or timing");process.exit(h.length?1:0)'
   ```

   It prints `no roadmap uses main or timing` (exit 0), or the files and
   fields (exit 1).
2. When it prints something, first remove those fields with a pull request to
   `v3` while the App and the data are still new, or revert the pull request
   that added them, and publish it. Repeat the check until it prints nothing.
   Never roll the schema back first: the old validator would refuse the
   roadmaps, and old Apps could not import the data.
3. In one short window, in this order:
   1. revert the schema change on `v3` with a pull request (`git revert`) and
      check `npm run validate`;
   2. revert the App's integration of `v3.1.0` in
      `LazurioExampleOrganization/mission-control` with a pull request
      (`git revert -m 1 <merge commit>`; the first parent is the previous
      `main`) and check `bun run check`, `bun run test` and `bun run build`
      against the reverted data;
   3. let every Environment of the Organization take both reverted heads. Its
      Launchpad fast-forwards clean checkouts of both repositories within its
      next sweep, and the App then shows no **Hlavní roadmapa**.
4. A new adoption reverts these reverts, again in one window. For the App, that
   means reverting the revert of the merge commit; otherwise Git would not take
   the already joined history of the tag again.

## Writing

Plans and tasks are written through the Mission Control App (a local draft,
reviewed and published as one fast-forward commit) or as a pull request to
`v3`. GitHub repository grants are the only access authority. Never force
push, rewrite history or store secrets, tokens or personal runtime state
here.
