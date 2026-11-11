# Mission Control data: rules for agents

This repository holds the canonical Mission Control data of Lazurio Example
Organization. Work only on behalf of your Operator and never bring in data of
another Organization. The rules of the Organization root `AGENTS.md` apply.

## Authority

- GitHub is the only access authority. Whoever has live write access to this
  repository may contribute to Mission Control.
- Do not create a second roster, approval roles, a changeset approval or a
  stored shared writer credential. A role named in text authorises nothing;
  a successful normal GitHub push by the current identity decides.
- No force push, no deletion of `v3` and no history rewrite. The `v3` ruleset
  enforces this.

## Writing canonical data

1. Work from a clean, up-to-date checkout of `v3`, or from a task worktree for
   a pull request.
2. Change only plans, roadmaps and settings under `data/mission-control/`.
   The task and issue ledgers, `changesets/`, `import-reviews/` and
   `reports/` are the frozen 3.x history
   (`data/mission-control/history.lock.json` names every file): never change,
   add or remove a file there, add nothing else beside the records and never
   edit the lock. A deliberate change of the history is
   `bun scripts/validate.ts --freeze-history` on your Operator's instruction,
   in a pull request of its own that says why. New tasks are a plan's
   `proposed_tasks`, and the work itself is GitHub Issues of the owning
   repository, linked to the plan (root `AGENTS.md`). No secrets, tokens,
   OAuth or session files, personal caches or host-specific runtime state.
   Evidence of a roadmap step is a file of this repository, named by a
   portable relative path; keep new evidence outside `data/mission-control/`
   (for example `evidence/`), and never in a file that `.gitignore` or
   `.git/info/exclude` leaves out: Git would never publish it. No URL carries
   a credential (a token, a key, user info).
3. Run `bun scripts/validate.ts` before publishing. It is the App's own check:
   when it fails, the App would refuse or skip the record. A commit has
   exactly one parent and contains only the intended canonical change.
4. Publish only with a normal, non-force fast-forward push to `v3` or a pull
   request. A concurrent remote advance is a normal collision: pull, validate
   again, then push again.
5. Committing and pushing here is a Publication of data; an agent does it only
   on its Operator's explicit instruction.

## Control plane

`mission-control.config.json`, `repository-db.yaml`, the history lock, the
validator, the schemas and these agent rules are the control plane. `schemas/`,
`scripts/validate.ts` and `scripts/mission-control-check.js` come from Mission
Control's `templates/data-repo/`; the schemas and the check bundle are
generated there (`bun run schema:export` in its `app/v3`). Take a new copy
when the Organization takes the release that changes them, in the same window
as the App's merge, and never edit them here by hand. Change
them in a dedicated pull request without unrelated domain data, with validation
of the old and new shape and a described rollback.
`publish_policy.protected_paths` stays concrete and non-empty.

## Language

This Organization works in English: plans, tasks and reports are written in
English.
