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
2. Change only domain data under `data/mission-control/`. No secrets, tokens,
   OAuth or session files, personal caches or host-specific runtime state.
3. Run `npm run validate` before publishing. A commit has exactly one parent
   and contains only the intended canonical change.
4. Publish only with a normal, non-force fast-forward push to `v3` or a pull
   request. A concurrent remote advance is a normal collision: pull, validate
   again, then push again.
5. Committing and pushing here is a Publication of data; an agent does it only
   on its Operator's explicit instruction.

## Control plane

`mission-control.config.json`, `repository-db.yaml`, the validator, the schemas
and these agent rules are the control plane. Change them in a dedicated pull
request without unrelated domain data, with validation of the old and new
shape and a described rollback. `publish_policy.protected_paths` stays
concrete and non-empty.

## Language

This Organization works in English: plans, tasks and reports are written in
English.
