// Validator of the Mission Control data repository, run by repository-db
// before every publish (`validate` in repository-db.yaml) and by the required
// CI check `validate` on every pull request.
//
// It runs Mission Control's own check of the data, `mission-control-check.js`
// beside it: generated from the App by `bun run schema:export`, with the same
// Zod schemas (their refinements included), the same rules across records,
// the same evidence and frozen-history checks and the same YAML parser as the
// App, as one bundle without dependencies. A change passes here exactly when
// the App accepts it. The check reads only this checkout and never follows a
// symbolic link: a link in any part of a path (the data directories, a record,
// the settings, evidence, the history, this bundle) is refused.
//
// `bun scripts/validate.ts --freeze-history` writes
// data/mission-control/history.lock.json: the files of the Mission Control
// 3.x history (ledgers, changesets, import reviews, reports) with the digests
// of their content. From then on any change of the history fails. Run it once,
// in the window that moves the repository to Mission Control 4, and again only
// to change the history on purpose; the change of the lock is reviewed in its
// pull request.
import { lstatSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export interface Issue {
  record: string;
  code: string;
  /** Values the issue names (a step, a path, a rule); never translated. */
  params?: Record<string, string>;
  message: string;
}

interface Freeze {
  path: string;
  text: string;
  count: number;
  changes: { added: string[]; changed: string[]; removed: string[] };
  issues: Issue[];
}

interface Check {
  validateRepository(root: string): Issue[];
  freezeRepositoryHistory(root: string): Freeze;
}

const BUNDLE = ["scripts", "mission-control-check.js"] as const;

async function load(root: string): Promise<Check | Issue[]> {
  for (let index = 1; index <= BUNDLE.length; index += 1) {
    const path = BUNDLE.slice(0, index).join("/");
    if (lstatSync(join(root, ...BUNDLE.slice(0, index))).isSymbolicLink()) {
      return [{ record: path, code: "link_refused", message: `${path} is a symbolic link` }];
    }
  }
  return (await import(pathToFileURL(join(root, ...BUNDLE)).href)) as Check;
}

export async function validateRepository(root: string): Promise<Issue[]> {
  const check = await load(root);
  return Array.isArray(check) ? check : check.validateRepository(root);
}

/** Writes a new history lock; returns what changed, or the issues that stop it. */
export async function freezeHistory(root: string): Promise<Freeze | Issue[]> {
  const check = await load(root);
  if (Array.isArray(check)) return check;
  const freeze = check.freezeRepositoryHistory(root);
  if (freeze.issues.length > 0) return freeze.issues;
  writeFileSync(join(root, ...freeze.path.split("/")), freeze.text);
  return freeze;
}

function report(issues: Issue[]): never {
  console.error(`Mission Control data: ${issues.length} problem(s)`);
  for (const issue of issues) console.error(`  ${issue.record}: ${issue.message}`);
  process.exit(1);
}

if (import.meta.main) {
  const root = process.cwd();
  if (process.argv.includes("--freeze-history")) {
    const freeze = await freezeHistory(root);
    if (Array.isArray(freeze)) report(freeze);
    const { added, changed, removed } = freeze.changes;
    console.log(`Froze ${freeze.count} history file(s) into ${freeze.path}.`);
    for (const [label, paths] of [
      ["added", added],
      ["changed", changed],
      ["removed", removed],
    ] as const) {
      for (const path of paths) console.log(`  ${label}: ${path}`);
    }
    console.log("Review the change of the lock in the pull request before it is merged.");
  } else {
    const issues = await validateRepository(root);
    if (issues.length > 0) report(issues);
    console.log("Mission Control data: OK");
  }
}
