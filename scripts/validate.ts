// Validator of the Mission Control data repository, run by repository-db
// before every publish (`validate` in repository-db.yaml) and by the required
// CI check `validate` on every pull request.
//
// It runs Mission Control's own check of the data, `mission-control-check.js`
// beside it: generated from the App by `bun run schema:export`, with the same
// Zod schemas (their refinements included), the same rules across records and
// the same YAML parser as the App, as one bundle without dependencies. A
// change passes here exactly when the App accepts it. The check reads only
// this checkout and never follows a symbolic link: a link in any part of a
// path (the data directories, a record, the settings, this bundle) is refused.
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export interface Issue {
  record: string;
  code: string;
  message: string;
}

interface Check {
  validateRepository(root: string): Issue[];
}

const BUNDLE = ["scripts", "mission-control-check.js"] as const;

export async function validateRepository(root: string): Promise<Issue[]> {
  for (let index = 1; index <= BUNDLE.length; index += 1) {
    const path = BUNDLE.slice(0, index).join("/");
    if (lstatSync(join(root, ...BUNDLE.slice(0, index))).isSymbolicLink()) {
      return [{ record: path, code: "link_refused", message: `${path} is a symbolic link` }];
    }
  }
  const check = (await import(pathToFileURL(join(root, ...BUNDLE)).href)) as Check;
  return check.validateRepository(root);
}

if (import.meta.main) {
  const issues = await validateRepository(process.cwd());
  if (issues.length > 0) {
    console.error(`Mission Control data: ${issues.length} problem(s)`);
    for (const issue of issues) console.error(`  ${issue.record}: ${issue.message}`);
    process.exit(1);
  }
  console.log("Mission Control data: OK");
}
