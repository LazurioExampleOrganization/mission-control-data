"""One-off import of the in-tree Mission Control v1 data into this repository.

Plan EX-0001, step O2. Run once from the root of this repository:

    python3 convert_v1.py <Organization root checkout>

It reads the Organization root's in-tree `mission-control/` layer and the root
task ledgers, writes v3 plans and ledgers under `data/mission-control/`, and
writes `parity-report.md` next to this file. It is not a reusable migrator:
it is deleted once the import is merged (decision 0173).
"""

import json
import re
import subprocess
import sys
from pathlib import Path

import yaml

SOURCE = Path(sys.argv[1]).resolve()
TARGET = Path.cwd()
DATA = TARGET / "data" / "mission-control"
REVIEW = DATA / "import-reviews" / "2026-10-16-v1-import"
PEOPLE = {"jannovak": "alexmorgan"}
PLAN_TYPE_NOTE = "The v1 plan type `{}` has no v3 field."


class Literal(str):
    pass


def literal_representer(dumper, data):
    return dumper.represent_scalar("tag:yaml.org,2002:str", data, style="|")


yaml.add_representer(Literal, literal_representer)


def text(value):
    value = str(value).strip()
    return Literal(value + "\n") if "\n" in value else value


def person(value):
    return PEOPLE.get(value, value)


def path(value):
    value = re.sub(r"^modules/mission-control/", "mission-control/", value)
    return re.sub(r"^modules/", "workspace/", value)


def date(value):
    return str(value)


source_commit = subprocess.run(
    ["git", "-C", str(SOURCE), "rev-parse", "HEAD"], check=True, capture_output=True, text=True
).stdout.strip()

plans_v1 = []
for file in sorted((SOURCE / "mission-control" / "plans").rglob("*.yaml")):
    plans_v1.append((file, yaml.safe_load(file.read_text())))
plans_v1.sort(key=lambda item: item[1]["id"])

# EX-0001 is the GEN3 migration plan; imported plans start at EX-0002 in v1 id order.
code_for = {}
for index, (_, plan) in enumerate(plans_v1):
    code_for[plan["id"]] = f"EX-{index + 2:04d}"

report_plans = []
written_plans = {}
for index, (file, v1) in enumerate(plans_v1):
    code = code_for[v1["id"]]
    slug = file.stem
    created = date(v1["created_at"])
    year, month, _ = created.split("-")
    target = DATA / "plans" / year / month / f"{code}-{slug}.yaml"
    dropped = []
    plan = {
        "schema_version": "companiesascode.mission_control.plan.v2",
        "id": f"mcplan-{code.lower()}",
        "dev_code": code,
        "title": v1["title"],
        "status": v1["status"],
        "owner": person(v1["owner"]),
        "priority": "medium",
        "priority_rank": index + 1,
        "created_at": created,
        "updated_at": date(v1["updated_at"]),
        "context": text(v1["context"]),
        "current_problem": "The v1 plan recorded no separate problem statement; the context describes it.",
        "target_state": text("\n".join(f"- {goal}" for goal in v1["goals"])),
        "scope": {"in": list(v1["scope"].get("in") or []), "out": list(v1["scope"].get("out") or [])},
        "acceptance_criteria": list(v1["acceptance_criteria"]),
        "validation": ["Check every acceptance criterion against recorded evidence."],
    }
    if v1.get("outcome"):
        plan["implementation_validation"] = [text(f"Outcome recorded in v1: {str(v1['outcome']).strip()}")]
    if v1.get("risk_notes"):
        plan["risk_notes"] = list(v1["risk_notes"])
    if v1.get("decisions"):
        plan["decisions"] = [
            {key: (date(value) if key == "date" else value) for key, value in decision.items()}
            for decision in v1["decisions"]
        ]
    if v1.get("todo_outputs"):
        plan["todo_outputs"] = list(v1["todo_outputs"])
    if v1.get("planning_target"):
        plan["planning_target"] = {
            "scope": "lazurio-example-organization",
            "todo_tasks_path": "data/mission-control/TODO.tasks.json",
        }
    if v1.get("proposed_tasks"):
        tasks = []
        for task in v1["proposed_tasks"]:
            kept = {key: task[key] for key in ("title", "summary", "priority", "tags", "acceptance_criteria", "risk_notes") if key in task}
            if "links" in task:
                dropped.append(f"`links` of the proposed task \"{task['title']}\" ({len(task['links'])} links)")
            tasks.append(kept)
        plan["proposed_tasks"] = tasks
    if v1.get("links"):
        plan["links"] = [
            {key: (path(value) if key == "path" else value) for key, value in link.items()}
            for link in v1["links"]
        ]
    plan["import_review"] = {
        "path": "data/mission-control/import-reviews/2026-10-16-v1-import/parity-report.md",
        "schema_fit": f"Imported from v1 plan {v1['id']} ({file.relative_to(SOURCE)}).",
        "schema_changes": [
            "priority and priority_rank were not recorded in v1; set to medium and the v1 id order.",
            "current_problem and validation were not recorded in v1; filled with a neutral statement.",
            "target_state is the list of v1 goals.",
        ]
        + (["The v1 outcome is kept in implementation_validation."] if v1.get("outcome") else []),
    }
    if v1.get("tags"):
        dropped.append(f"`tags` ({', '.join(v1['tags'])})")
    dropped.append(PLAN_TYPE_NOTE.format(v1["type"]))
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(yaml.dump(plan, sort_keys=False, allow_unicode=True, width=100))
    written_plans[v1["id"]] = (code, target.relative_to(TARGET).as_posix())
    report_plans.append((v1["id"], file.relative_to(SOURCE).as_posix(), code, target.relative_to(TARGET).as_posix(), dropped))


def convert_task(task, ledger):
    task = dict(task)
    notes = []
    for key in ("assignee", "priority_decider", "completed_by"):
        if key in task:
            task[key] = person(task[key])
    for key in ("created_at", "updated_at", "completed_at"):
        if key in task:
            task[key] = date(task[key])
    if task.get("links"):
        task["links"] = [
            {k: (path(v) if k == "path" else v) for k, v in link.items()} for link in task["links"]
        ]
    planning = task.get("planning")
    if planning:
        code, plan_path = written_plans[planning["plan_id"]]
        if planning.get("role"):
            notes.append(f"planning.role `{planning['role']}` dropped")
        task["planning"] = {
            "source": "mission-control",
            "plan_id": f"mcplan-{code.lower()}",
            "dev_code": code,
            "path": plan_path,
        }
        task["dev_code"] = code
        task.setdefault("tags", [])
        if code not in task["tags"]:
            task["tags"].append(code)
    task["imported_from"] = ledger
    return task, notes


ledgers = {
    "TODO.tasks.json": [],
    "DONE.tasks.json": [],
}
report_tasks = []
for ledger in ("TODO.tasks.json", "mission-control/TODO.tasks.json", "DONE.tasks.json", "mission-control/DONE.tasks.json"):
    source = json.loads((SOURCE / ledger).read_text())
    target_name = "DONE.tasks.json" if ledger.endswith("DONE.tasks.json") else "TODO.tasks.json"
    for task in source["tasks"]:
        converted, notes = convert_task(task, ledger)
        ledgers[target_name].append(converted)
        report_tasks.append((task["id"], ledger, target_name, converted.get("dev_code", ""), notes))
for name, tasks in ledgers.items():
    (DATA / name).write_text(json.dumps(tasks, indent=2, ensure_ascii=False) + "\n")

issues = json.loads((SOURCE / "ISSUES.open.json").read_text())["issues"]
kept_issues = []
report_issues = []
for issue in issues:
    issue = dict(issue)
    if "github" in issue["title"].lower() or "GitHub" in issue["title"]:
        report_issues.append((issue["id"], "moved to a GitHub Issue in the infra repository: https://github.com/LazurioExampleOrganization/infra/issues/2"))
        continue
    for key in ("owner",):
        if key in issue:
            issue[key] = person(issue[key])
    for key in ("created_at", "updated_at"):
        if key in issue:
            issue[key] = date(issue[key])
    if issue.get("links"):
        issue["links"] = [{k: (path(v) if k == "path" else v) for k, v in link.items()} for link in issue["links"]]
    issue["imported_from"] = "ISSUES.open.json"
    kept_issues.append(issue)
    report_issues.append((issue["id"], "kept in ISSUES.open.json (business decision)"))
(DATA / "ISSUES.open.json").write_text(json.dumps(kept_issues, indent=2, ensure_ascii=False) + "\n")

entities = sorted(p.relative_to(SOURCE).as_posix() for p in (SOURCE / "mission-control" / "data" / "v1").rglob("*.yaml"))

lines = [
    "# Import of the v1 Mission Control data",
    "",
    f"Plan EX-0001, step O2. Source: the Organization root at commit `{source_commit}`",
    "(in-tree `mission-control/` layer and the root task ledgers). Generated by",
    "`convert_v1.py`; the script is removed after the import is merged.",
    "",
    "## Plans",
    "",
    "| v1 id | v1 file | v3 code | v3 file | Not carried over |",
    "|---|---|---|---|---|",
]
for v1_id, source_file, code, target_file, dropped in report_plans:
    lines.append(f"| `{v1_id}` | `{source_file}` | {code} | `{target_file}` | {'; '.join(dropped)} |")
lines += [
    "",
    f"{len(report_plans)} v1 plans, {len(report_plans)} v3 plans. EX-0001 is the GEN3 migration plan itself and is not imported.",
    "",
    "## Tasks",
    "",
    "| Task | v1 ledger | v3 ledger | Plan | Notes |",
    "|---|---|---|---|---|",
]
for task_id, ledger, target_name, code, notes in report_tasks:
    lines.append(f"| `{task_id}` | `{ledger}` | `{target_name}` | {code or 'none'} | {'; '.join(notes) or 'unchanged apart from people and paths'} |")
lines += [
    "",
    f"{len(report_tasks)} v1 tasks, {sum(len(t) for t in ledgers.values())} v3 tasks "
    f"({len(ledgers['TODO.tasks.json'])} in TODO, {len(ledgers['DONE.tasks.json'])} in DONE). "
    "Every task keeps its id and records its source ledger in `imported_from`; "
    "the v1 ledger envelopes (`schema_version`, `scope`) are dropped because v3 ledgers are plain arrays.",
    "",
    "## Issues",
    "",
    "| Issue | Result |",
    "|---|---|",
]
for issue_id, result in report_issues:
    lines.append(f"| `{issue_id}` | {result} |")
lines += [
    "",
    "## Dropped v1 entities",
    "",
    "The v1 app kept a Linear-like file database under `mission-control/data/v1/`.",
    "Its records describe building Mission Control v2 itself, which the public",
    "Mission Control v3 upstream replaces, so none is carried over as a roadmap.",
    "The planning context survives in the imported plans (the v2 core plan is",
    f"{code_for.get('plan-2026-05-23-009', 'n/a')}).",
    "",
]
lines += [f"- `{entity}`" for entity in entities]
lines += [
    "",
    "## People and paths",
    "",
    "- `jannovak` becomes `alexmorgan` (decision D3) in owners, assignees and deciders.",
    "- Paths `modules/<module>/...` become `workspace/<module>/...`; `modules/mission-control/...` becomes `mission-control/...`.",
    "- Text stays in its original language; step T3 translates it.",
]
(REVIEW / "parity-report.md").write_text("\n".join(lines) + "\n")
print(f"plans {len(report_plans)}, tasks {len(report_tasks)}, issues {len(kept_issues)}, dropped entities {len(entities)}")
