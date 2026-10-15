import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { devNull, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const validatorDirectory = dirname(fileURLToPath(import.meta.url));
const possibleAppCodeRoot = resolve(validatorDirectory, "../../..");
const appV3PackagePath = join(possibleAppCodeRoot, "app/v3/package.json");
const isBundledAppCodeValidator =
  validatorDirectory ===
    join(possibleAppCodeRoot, "templates/organization-data/scripts") &&
  existsSync(appV3PackagePath);
// Each reviewed first-parent app-code commit carries its own path authority.
// Reading the manifest from the recorded commit makes rename trust temporal,
// while avoiding upstream commit anchors that would break Organization forks.
const pinnedValidatorPathManifestPath =
  "config/trusted-pinned-validator-paths.json";
const pinnedValidatorPathManifestSchema =
  "companiesascode.mission_control.pinned_validator_paths.v1";
// Immutable evidence written before the fork-local manifest landing cannot be
// rewritten. Its compatibility authority is deliberately limited to the one
// validator path that existed before the manifest contract.
const legacyPreManifestPinnedValidatorPath =
  "templates/organization-data/scripts/validate-mission-control-data.mjs";
// Launchpad installs only app/v3 dependencies. The pinned app-code copy must
// resolve from that package; a standalone data-repo copy falls back to its
// own package/node_modules.
const runtimeRequire = isBundledAppCodeValidator
  ? createRequire(appV3PackagePath)
  : createRequire(import.meta.url);
const AjvModule = runtimeRequire("ajv/dist/2020.js");
const Ajv2020 = AjvModule.default ?? AjvModule;
const { parse: parseYaml, parseDocument, visit } = runtimeRequire("yaml");

// The validator is invoked by the current Principal on their own machine.
// Resolve Git through the ordinary PATH on macOS, Linux and Windows.
const trustedGitExecutable = "git";
const gitLongPathArguments = process.platform === "win32"
  ? ["-c", "core.longpaths=true"]
  : [];
const root = process.cwd();
const requiredJsonArrays = [
  "data/mission-control/ISSUES.open.json",
  "data/mission-control/ISSUES.resolved.json",
  "data/mission-control/TODO.tasks.json",
  "data/mission-control/DONE.tasks.json",
];
const taskParityFields = [
  "title",
  "summary",
  "priority",
  "priority_rank",
  "assignee",
  "priority_decider",
  "priority_reason",
  "tags",
  "acceptance_criteria",
  "risk_notes",
  "blocked_by",
];

const missionControlConfigFile =
  "data/mission-control/mission-control.config.json";
const requiredFiles = ["AGENTS.md", "repository-db.yaml"];
const failures = [];
const gitNullDevice = process.platform === "win32" ? "NUL" : devNull;

const unauthenticatedLocalTestRequested = process.argv.includes(
  "--allow-unauthenticated-local-test",
);
const unbornBootstrapRequested = process.argv.includes(
  "--allow-unborn-bootstrap",
);
const pinnedAppCodeRequested = process.argv.includes(
  "--pinned-app-code",
);
let allowUnauthenticatedLocalTest = false;
if (pinnedAppCodeRequested) {
  const credentialOrInjectionEnvironment = Object.keys(process.env)
    .filter(
      (key) => {
        const upperKey = key.toUpperCase();
        return [
          "SSH_AUTH_SOCK",
          "SSH_AGENT_PID",
          "GPG_AGENT_INFO",
          "GNUPGHOME",
          "NODE_OPTIONS",
          "NODE_PATH",
          "BUN_OPTIONS",
          "LD_PRELOAD",
          "DYLD_INSERT_LIBRARIES",
          "DYLD_LIBRARY_PATH",
          "GIT_ASKPASS",
          "SSH_ASKPASS",
        ].includes(upperKey) ||
          upperKey === "GIT_CONFIG_COUNT" ||
          /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(upperKey);
      },
    )
    .sort();
  if (credentialOrInjectionEnvironment.length > 0) {
    failures.push(
      `pinned validator received forbidden credential/code-injection environment: ${credentialOrInjectionEnvironment.join(", ")}`,
    );
  }
}
const plansDirectory = "data/mission-control/plans";
const roadmapsDirectory = "data/mission-control/roadmaps";
const planSchemaFile = "schemas/mission-control-plan.schema.json";
const roadmapSchemaFile = "schemas/mission-control-roadmap.schema.json";
const pendingChangesetsDirectory = "data/mission-control/changesets/pending";
const publishedChangesetsDirectory = "data/mission-control/changesets/published";
const supersededChangesetsDirectory = "data/mission-control/changesets/superseded";
const writerAuditSchemaFile =
  "schemas/mission-control-writer-audit.schema.json";
const writerProvenanceSchemaFile =
  "schemas/mission-control-writer-provenance.schema.json";
const localPublishSchemaFile =
  "schemas/mission-control-local-publish.schema.json";
const requiredDirectories = [
  plansDirectory,
  roadmapsDirectory,
  pendingChangesetsDirectory,
  publishedChangesetsDirectory,
  supersededChangesetsDirectory,
];

function parseJson(file) {
  const path = join(root, file);
  if (!existsSync(path)) {
    failures.push(`missing ${file}`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    failures.push(`${file}: invalid JSON: ${error.message}`);
    return null;
  }
}

function listJsonFiles(directory) {
  const base = join(root, directory);
  if (!existsSync(base)) return [];
  const files = [];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...listJsonFiles(relative));
    else if (entry.isFile() && entry.name.endsWith(".json")) files.push(relative);
  }
  return files.sort();
}

function listYamlFiles(directory) {
  const base = join(root, directory);
  if (!existsSync(base)) return [];
  const files = [];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    const relative = `${directory}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      failures.push(`${relative}: YAML source tree must not contain symlinks`);
    } else if (entry.isDirectory()) files.push(...listYamlFiles(relative));
    else if (entry.isFile() && (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml"))) {
      files.push(relative);
    } else if (entry.isFile() && /\.(?:yaml|yml)$/i.test(entry.name)) {
      failures.push(`${relative}: YAML extension must be lowercase .yaml or .yml`);
    }
  }
  return files.sort();
}

function parsePlanYaml(file) {
  try {
    const plan = parseYaml(readFileSync(join(root, file), "utf8"));
    if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
      failures.push(`${file}: YAML plan must be a mapping`);
      return null;
    }
    return plan;
  } catch (error) {
    failures.push(`${file}: invalid YAML: ${error.message}`);
    return null;
  }
}

function compileJsonSchema(schemaFile) {
  const schema = parseJson(schemaFile);
  try {
    return new Ajv2020({ allErrors: true, strict: false }).compile(schema);
  } catch (error) {
    failures.push(`${schemaFile}: cannot compile JSON schema: ${error.message}`);
    return null;
  }
}

function compilePlanSchema() {
  return compileJsonSchema(planSchemaFile);
}

function parseRoadmapYaml(file) {
  try {
    const source = readFileSync(join(root, file), "utf8");
    const roadmap = parseYaml(source);
    if (!roadmap || typeof roadmap !== "object" || Array.isArray(roadmap)) {
      failures.push(`${file}: YAML roadmap must be a mapping`);
      return null;
    }
    return { roadmap, source };
  } catch (error) {
    failures.push(`${file}: invalid YAML: ${error.message}`);
    return null;
  }
}

function compileRoadmapSchema(schemaFile) {
  return compileJsonSchema(schemaFile);
}

function compileWriterAuditSchema() {
  return compileJsonSchema(writerAuditSchemaFile);
}

function compileWriterProvenanceSchema() {
  return compileJsonSchema(writerProvenanceSchemaFile);
}

function compileLocalPublishSchema() {
  return compileJsonSchema(localPublishSchemaFile);
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseYamlMapping(file) {
  const path = join(root, file);
  if (!existsSync(path)) {
    failures.push(`missing ${file}`);
    return null;
  }
  try {
    const value = parseYaml(readFileSync(path, "utf8"));
    if (!isObject(value)) {
      failures.push(`${file}: must be a YAML mapping`);
      return null;
    }
    return value;
  } catch (error) {
    failures.push(`${file}: invalid YAML: ${error.message}`);
    return null;
  }
}

const windowsDeviceNamePattern = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const printableAsciiPathPattern = /^[\x20-\x7e]+$/;

function isSafeRelativePath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    value.startsWith("/") ||
    !printableAsciiPathPattern.test(value) ||
    /[<>:"\\|?*\u0000-\u001f\u007f]/.test(value)
  ) {
    return false;
  }
  return value.split("/").every(
    (segment) =>
      segment.length > 0 &&
      segment !== "." &&
      segment !== ".." &&
      !segment.endsWith(".") &&
      !segment.endsWith(" ") &&
      !windowsDeviceNamePattern.test(segment),
  );
}

function isSafeMissionControlRepositoryPath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.startsWith("/") ||
    /[\\%?#\s\u0000-\u001f\u007f]/.test(value)
  ) {
    return false;
  }
  const segments = value.split("/");
  return (
    segments.length >= 2 &&
    segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..") &&
    segments.at(-1) === "mission-control-data.git"
  );
}

function isSafeMissionControlGitRemote(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    value.startsWith("-") ||
    /[\s\u0000-\u001f\u007f]/.test(value) ||
    value.includes("REPLACE_WITH_")
  ) {
    return false;
  }

  if (value.startsWith("https://") || value.startsWith("ssh://")) {
    try {
      const remote = new URL(value);
      if (
        !["https:", "ssh:"].includes(remote.protocol) ||
        !remote.hostname ||
        remote.password ||
        remote.search ||
        remote.hash ||
        (remote.protocol === "https:" && remote.username) ||
        !remote.pathname.startsWith("/") ||
        remote.pathname.startsWith("//")
      ) {
        return false;
      }
      return isSafeMissionControlRepositoryPath(remote.pathname.slice(1));
    } catch {
      return false;
    }
  }

  const scpLike = /^([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+):(.+)$/.exec(value);
  return Boolean(
    scpLike &&
      scpLike[2] &&
      !scpLike[2].startsWith(".") &&
      !scpLike[2].endsWith(".") &&
      isSafeMissionControlRepositoryPath(scpLike[3]),
  );
}

function sshRemoteHost(value) {
  if (typeof value !== "string") return null;
  const scpLike =
    /^[A-Za-z0-9._-]+@([A-Za-z0-9.-]+):/.exec(value);
  if (scpLike) return scpLike[1].toLowerCase();
  if (!value.startsWith("ssh://")) return null;
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function sshRemoteUser(value) {
  if (typeof value !== "string") return null;
  const scpLike =
    /^([A-Za-z0-9._-]+)@[A-Za-z0-9.-]+:/.exec(value);
  if (scpLike) return scpLike[1];
  if (!value.startsWith("ssh://")) return null;
  try {
    return decodeURIComponent(new URL(value).username);
  } catch {
    return null;
  }
}

function remoteUsesGitHubSsh(value) {
  return (
    sshRemoteUser(value) === "git" &&
    ["github.com", "ssh.github.com"].includes(sshRemoteHost(value))
  );
}

// Host of a credential-free HTTPS remote; a URL with username/password never
// carries the Principal identity and is rejected.
function httpsRemoteHost(value) {
  if (typeof value !== "string" || !value.startsWith("https://")) {
    return null;
  }
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password
    ) {
      return null;
    }
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function remoteUsesGitHubHttps(value) {
  return httpsRemoteHost(value) === "github.com";
}

// Phased roster model (decision 0102): the recorded provider audit scope
// decides which approval role lane is active.
function approvalRolesMatchRosterScope(roles, rosterScope) {
  if (!Array.isArray(roles)) return false;
  if (rosterScope === "organization-members") {
    return roles.length === 1 && roles[0] === "member";
  }
  return (
    rosterScope === "admin-steward" &&
    roles.length === 2 &&
    roles.includes("admin") &&
    roles.includes("steward")
  );
}

function repositoryIdFromMissionControlRemote(value) {
  if (!isSafeMissionControlGitRemote(value)) return null;
  let host;
  let path;
  const scpLike =
    /^([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+):(.+)$/.exec(value);
  if (scpLike) {
    host = scpLike[2];
    path = scpLike[3];
  } else {
    try {
      const remote = new URL(value);
      host = remote.hostname;
      path = remote.pathname.replace(/^\/+/, "");
    } catch {
      return null;
    }
  }
  const segments = path.split("/").filter(Boolean);
  if (host.toLowerCase() === "github.com" && segments.length !== 2) {
    return null;
  }
  if (segments.length < 2) return null;
  const owner = segments.at(-2);
  const repository = segments.at(-1).replace(/\.git$/, "");
  if (
    !/^[A-Za-z0-9_.-]+$/.test(owner) ||
    repository !== "mission-control-data"
  ) {
    return null;
  }
  return `${owner}/${repository}`;
}

function validateRepositoryDbControlPlane(repositoryDbConfig) {
  if (!repositoryDbConfig) return;
  const allowedKeys = new Set([
    "schema_version",
    "app",
    "data_repo",
    "schema",
    "layout",
    "generated_manifest",
    "validate",
  ]);
  for (const key of Object.keys(repositoryDbConfig)) {
    if (!allowedKeys.has(key)) {
      failures.push(`repository-db.yaml: unexpected top-level key ${key}`);
    }
  }
  if (repositoryDbConfig.schema_version !== "repository-db.config.v1") {
    failures.push("repository-db.yaml: schema_version must be repository-db.config.v1");
  }
  if (repositoryDbConfig.app !== "mission-control") {
    failures.push("repository-db.yaml: app must be mission-control");
  }

  const dataRepo = repositoryDbConfig.data_repo;
  if (!isObject(dataRepo)) {
    failures.push("repository-db.yaml: data_repo must be a mapping");
  } else {
    const remote = dataRepo.remote;
    if (!isSafeMissionControlGitRemote(remote)) {
      failures.push(
        "repository-db.yaml: data_repo.remote must be a concrete credential-free Organization-owned HTTPS or SSH mission-control-data Git remote",
      );
    }
    if (dataRepo.branch !== "v3") {
      failures.push("repository-db.yaml: data_repo.branch must be v3");
    }
  }

  const schema = repositoryDbConfig.schema;
  if (!isObject(schema)) {
    failures.push("repository-db.yaml: schema must be a mapping");
  } else {
    if (schema.name !== "mission-control-data") {
      failures.push("repository-db.yaml: schema.name must be mission-control-data");
    }
    if (schema.version !== "3.0.0-alpha.0") {
      failures.push("repository-db.yaml: schema.version must be 3.0.0-alpha.0");
    }
  }

  const layout = repositoryDbConfig.layout;
  if (!isObject(layout)) {
    failures.push("repository-db.yaml: layout must be a mapping");
  } else {
    for (const [key, expected] of Object.entries({
      data: "data",
      generated: "generated",
      scripts: "scripts",
    })) {
      if (layout[key] !== expected) {
        failures.push(`repository-db.yaml: layout.${key} must be ${expected}`);
      }
    }
  }

  if (!Array.isArray(repositoryDbConfig.generated_manifest)) {
    failures.push("repository-db.yaml: generated_manifest must be a list");
  } else {
    for (const [index, entry] of repositoryDbConfig.generated_manifest.entries()) {
      if (!isObject(entry)) {
        failures.push(`repository-db.yaml: generated_manifest[${index}] must be a mapping`);
      } else if (!isSafeRelativePath(entry.path)) {
        failures.push(`repository-db.yaml: generated_manifest[${index}].path must be repo-relative`);
      }
    }
  }

  if (
    !Array.isArray(repositoryDbConfig.validate) ||
    repositoryDbConfig.validate.some(
      (entry) => typeof entry !== "string" || entry.trim() !== entry || entry.length === 0,
    ) ||
    !repositoryDbConfig.validate.includes("node scripts/validate-mission-control-data.mjs")
  ) {
    failures.push(
      "repository-db.yaml: validate must include node scripts/validate-mission-control-data.mjs",
    );
  }
}

function parseIsoDateTimeNanoseconds(value) {
  if (typeof value !== "string") return null;
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,9}))?(Z|[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00))$/,
  );
  if (!match) return null;
  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    fractionText = "",
    timezoneText,
  ] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const calendarDate = new Date(0);
  calendarDate.setUTCFullYear(year, month - 1, day);
  calendarDate.setUTCHours(hour, minute, second, 0);
  if (
    calendarDate.getUTCFullYear() === year &&
    calendarDate.getUTCMonth() === month - 1 &&
    calendarDate.getUTCDate() === day &&
    calendarDate.getUTCHours() === hour &&
    calendarDate.getUTCMinutes() === minute &&
    calendarDate.getUTCSeconds() === second
  ) {
    let offsetMinutes = 0;
    if (timezoneText !== "Z") {
      const sign = timezoneText[0] === "+" ? 1 : -1;
      const [offsetHours, offsetMinutePart] = timezoneText.slice(1).split(":").map(Number);
      offsetMinutes = sign * (offsetHours * 60 + offsetMinutePart);
    }
    const utcMilliseconds = calendarDate.getTime() - offsetMinutes * 60_000;
    const fractionalNanoseconds = BigInt(fractionText.padEnd(9, "0") || "0");
    return BigInt(utcMilliseconds) * 1_000_000n + fractionalNanoseconds;
  }
  return null;
}

function isContainedRepoPath(value) {
  if (typeof value !== "string" || value.length === 0 || isAbsolute(value)) return false;
  const resolved = resolve(root, value);
  const fromRoot = relative(root, resolved);
  return (
    fromRoot !== ".." &&
    !fromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(fromRoot)
  );
}

function canonicalManifestPath(value) {
  if (typeof value !== "string" || value === "" || posix.isAbsolute(value)) return null;
  const canonical = posix.normalize(value.replaceAll("\\", "/"));
  if (canonical === "." || canonical === ".." || canonical.startsWith("../")) return null;
  return canonical;
}

function allowsMissingDeclaredPlanningTarget(workspaceRoot, todoTasksPath) {
  try {
    const manifest = JSON.parse(
      readFileSync(join(workspaceRoot, "modules.manifest.json"), "utf8"),
    );
    const modules = Array.isArray(manifest.modules) ? manifest.modules : null;
    const moduleSlots = Array.isArray(manifest.module_slots) ? manifest.module_slots : null;
    if (modules && moduleSlots) return false;
    const slots = modules ?? moduleSlots;
    if (!slots) return false;
    const targetPath = canonicalManifestPath(todoTasksPath);
    if (!targetPath || posix.basename(targetPath) !== "TODO.tasks.json") return false;
    const targetParent = posix.dirname(targetPath);
    const matches = slots.filter(
      (slot) => canonicalManifestPath(slot?.path) === targetParent,
    );
    if (matches.length !== 1) return false;
    const slot = matches[0];
    const status = String(slot.status ?? "").toLowerCase();
    const materialization = String(slot.materialization ?? "").toLowerCase();
    if (
      ["planned", "planned_slot"].includes(status) ||
      ["planned", "planned_slot"].includes(materialization)
    ) {
      return true;
    }
    const access = String(slot.default_access ?? "").toLowerCase();
    if (["role_based", "restricted"].includes(access)) return true;
    const hasRepositoryLocator = [
      slot.git?.url,
      slot.repository_db?.repo,
      slot.repository_db?.url,
    ].some((value) => typeof value === "string" && value.trim() !== "");
    return !hasRepositoryLocator;
  } catch (error) {
    if (process.env.MISSION_CONTROL_DEBUG_GIT === "1") {
      console.error(error);
    }
    return false;
  }
}

function allowsMissingLegacyPlanningTarget(
  missionControlConfig,
  workspaceRoot,
  todoTasksPath,
) {
  if (todoTasksPath.startsWith("data/mission-control/")) return false;
  const manifestAllowsMissing = allowsMissingDeclaredPlanningTarget(
    workspaceRoot,
    todoTasksPath,
  );
  return missionControlConfig?.data_mode === "repository-db"
    && (manifestAllowsMissing || todoTasksPath.startsWith("modules/"));
}

function validatePlanRuntimeInvariants(file, plan) {
  const hasProposedTasks =
    Array.isArray(plan.proposed_tasks) && plan.proposed_tasks.length > 0;
  const hasPlanningTarget = plan.planning_target !== undefined;
  if (hasProposedTasks && !isObject(plan.planning_target)) {
    failures.push(`${file}: planning_target is required when proposed_tasks is non-empty`);
  }
  if (hasPlanningTarget && !hasProposedTasks) {
    failures.push(`${file}: proposed_tasks must be non-empty when planning_target is present`);
  }

  if (
    isObject(plan.planning_target) &&
    typeof plan.planning_target.todo_tasks_path === "string"
  ) {
    const todoTasksPath = plan.planning_target.todo_tasks_path;
    const explicitWorkspaceRoot = process.env.MISSION_CONTROL_WORKSPACE_ROOT;
    const todoPathRoot = todoTasksPath.startsWith("data/mission-control/")
      ? root
      : explicitWorkspaceRoot
        ? resolve(explicitWorkspaceRoot)
        : null;
    if (!isSafeRelativePath(todoTasksPath)) {
      failures.push(
        `${file}: planning_target.todo_tasks_path must be a portable relative path`,
      );
    } else if (!todoPathRoot) {
      failures.push(
        `${file}: planning_target.todo_tasks_path requires MISSION_CONTROL_WORKSPACE_ROOT`,
      );
    } else if (
      todoPathRoot &&
      !existsSync(resolve(todoPathRoot, todoTasksPath)) &&
      (todoTasksPath.startsWith("data/mission-control/") ||
        !allowsMissingLegacyPlanningTarget(config, todoPathRoot, todoTasksPath))
    ) {
      failures.push(
        `${file}: planning_target.todo_tasks_path does not exist: ${todoTasksPath}`,
      );
    }
  }

  const placeholderPatterns = [
    /^Doplnit (kontext|aktuální problém|cílový stav|nejbližší proveditelný scope|co zůstává mimo scope|ověřitelná acceptance criteria|minimální ověření|kurátorský)\b/i,
    /^doplnit (kontext|aktuální problém|cílový stav|rozsah|scope|acceptance|ověření|validaci)\b/i,
  ];
  const checkPlaceholder = (path, value) => {
    if (
      typeof value === "string" &&
      placeholderPatterns.some((pattern) => pattern.test(value.trim()))
    ) {
      failures.push(`${file}: ${path} must not contain placeholder text`);
    }
  };
  checkPlaceholder("context", plan.context);
  checkPlaceholder("current_problem", plan.current_problem);
  checkPlaceholder("target_state", plan.target_state);
  for (const [index, value] of (
    Array.isArray(plan.scope?.in) ? plan.scope.in : []
  ).entries()) {
    checkPlaceholder(`scope.in.${index}`, value);
  }
  for (const [index, value] of (
    Array.isArray(plan.scope?.out) ? plan.scope.out : []
  ).entries()) {
    checkPlaceholder(`scope.out.${index}`, value);
  }
  for (const [index, value] of (
    Array.isArray(plan.acceptance_criteria) ? plan.acceptance_criteria : []
  ).entries()) {
    checkPlaceholder(`acceptance_criteria.${index}`, value);
  }
  for (const [index, value] of (
    Array.isArray(plan.validation) ? plan.validation : []
  ).entries()) {
    checkPlaceholder(`validation.${index}`, value);
  }

  if (
    typeof plan.created_at === "string" &&
    /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(plan.created_at)
  ) {
    const [year, month] = plan.created_at.split("-");
    const expectedDirectory = `${plansDirectory}/${year}/${month}`;
    const actualDirectory = dirname(file).split(sep).join("/");
    if (actualDirectory !== expectedDirectory) {
      failures.push(
        `${file}: plan must stay in ${expectedDirectory}/ according to created_at`,
      );
    }
  }
}

function validatePlan(file, planPrefix, validateSchema) {
  const plan = parsePlanYaml(file);
  if (!plan) return null;
  if (validateSchema && !validateSchema(plan)) {
    for (const error of validateSchema.errors ?? []) {
      failures.push(
        `${file}: plan schema ${error.instancePath || "(root)"} ${error.message ?? "is invalid"}`,
      );
    }
  }
  validatePlanRuntimeInvariants(file, plan);
  const devCode = plan.dev_code;
  const id = plan.id;
  const devCodePattern = new RegExp(`^${planPrefix}-[0-9]{4}$`);
  if (typeof devCode === "string" && !devCodePattern.test(devCode)) {
    failures.push(`${file}: dev_code must match configured plan_prefix (${planPrefix}-dddd)`);
  }
  if (typeof devCode === "string" && typeof id === "string" && id !== `mcplan-${devCode.toLowerCase()}`) {
    failures.push(`${file}: id must equal mcplan-${devCode.toLowerCase()} for dev_code ${devCode}`);
  }
  const clickupCustomId = plan.legacy_sources?.clickup?.custom_id;
  if (
    typeof clickupCustomId === "string" &&
    !devCodePattern.test(clickupCustomId)
  ) {
    failures.push(
      `${file}: legacy_sources.clickup.custom_id must match configured plan_prefix (${planPrefix}-dddd)`,
    );
  }
  if (typeof devCode === "string" && !basename(file).startsWith(`${devCode}-`)) {
    failures.push(`${file}: filename must start with ${devCode}-`);
  }
  return plan;
}

function validateUniquePlanIdentity(file, plan, seenDevCodes, seenIds) {
  for (const [field, seen] of [
    ["dev_code", seenDevCodes],
    ["id", seenIds],
  ]) {
    const value = plan[field];
    if (typeof value !== "string") continue;
    const previous = seen.get(value);
    if (previous) {
      failures.push(`${file}: duplicate ${field} ${value} (also in ${previous})`);
    } else {
      seen.set(value, file);
    }
  }
}

function validateRoadmapReferenceList(file, label, values, existingIds, noun) {
  if (!Array.isArray(values)) return;
  for (const [index, value] of values.entries()) {
    if (typeof value === "string" && !existingIds.has(value)) {
      failures.push(`${file}: ${label}[${index}] references missing ${noun} ${value}`);
    }
  }
}

function collectRecordIds(records) {
  const ids = new Set();
  if (!Array.isArray(records)) return ids;
  for (const record of records) {
    if (isObject(record) && typeof record.id === "string") ids.add(record.id);
  }
  return ids;
}

function validateTaskLedgerInvariants(config, plans, todo, done) {
  if (
    config?.validation?.invariants_enforced !== true ||
    typeof config.plan_prefix !== "string"
  ) return;

  const tasks = [
    ...todo.map((task) => ({ ...task, ledger_path: "TODO.tasks.json" })),
    ...done.map((task) => ({ ...task, ledger_path: "DONE.tasks.json" })),
  ];
  const taskLocations = new Map();
  for (const task of tasks) {
    if (!isObject(task) || typeof task.id !== "string" || task.id === "") continue;
    const locations = taskLocations.get(task.id) ?? [];
    locations.push(task.ledger_path);
    taskLocations.set(task.id, locations);
  }
  for (const [taskId, locations] of taskLocations) {
    if (locations.length > 1) {
      failures.push(`duplicate task id ${taskId}: ${locations.join(", ")}`);
    }
  }

  const taskIds = new Set(taskLocations.keys());
  const plansByPath = new Map(plans.map(({ file, plan }) => [file, plan]));
  const escapedPrefix = config.plan_prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const canonicalPlanPath = new RegExp(
    `^data/mission-control/plans/[0-9]{4}/[0-9]{2}/${escapedPrefix}-[0-9]{4}-.+\\.ya?ml$`,
  );

  for (const task of tasks) {
    if (!isObject(task) || typeof task.id !== "string") continue;
    for (const blocker of Array.isArray(task.blocked_by) ? task.blocked_by : []) {
      if (typeof blocker === "string" && !taskIds.has(blocker)) {
        failures.push(`${task.id}: blocked_by target does not exist: ${blocker}`);
      }
    }
    if (!isObject(task.planning) || task.planning.source !== "mission-control") continue;
    const planPath = task.planning.path;
    if (typeof planPath !== "string" || !canonicalPlanPath.test(planPath)) {
      failures.push(
        `${task.id}: planning.path must use data/mission-control/plans/YYYY/MM/${config.plan_prefix}-XXXX-*.yaml`,
      );
      continue;
    }
    const plan = plansByPath.get(planPath);
    if (!plan) {
      failures.push(`${task.id}: planning.path does not resolve: ${planPath}`);
      continue;
    }
    if (task.planning.plan_id !== plan.id) {
      failures.push(
        `${task.id}: planning.plan_id ${task.planning.plan_id} does not match ${plan.id}`,
      );
    }
    if (
      task.dev_code !== plan.dev_code ||
      (task.planning.dev_code !== undefined &&
        task.planning.dev_code !== plan.dev_code)
    ) {
      failures.push(
        `${task.id}: planning DEV identity does not match ${plan.dev_code}`,
      );
    }
  }

  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const blueprintLocations = new Map();
  const blueprints = plans.flatMap(({ file, plan }) =>
    (Array.isArray(plan.proposed_tasks) ? plan.proposed_tasks : []).map((task) => ({
      ...task,
      plan,
      plan_path: file,
    })),
  );
  for (const blueprint of blueprints) {
    if (typeof blueprint.id !== "string" || blueprint.id === "") continue;
    const locations = blueprintLocations.get(blueprint.id) ?? [];
    locations.push(`${blueprint.plan_path}#${blueprint.id}`);
    blueprintLocations.set(blueprint.id, locations);
  }
  for (const [taskId, locations] of blueprintLocations) {
    if (locations.length > 1) {
      failures.push(`duplicate proposed task id ${taskId}: ${locations.join(", ")}`);
    }
  }

  if (config.validation.materialized_plan_task_parity_required !== true) return;
  for (const blueprint of blueprints) {
    if (typeof blueprint.id !== "string" || !taskById.has(blueprint.id)) continue;
    const task = taskById.get(blueprint.id);
    if (!isObject(task.planning) || task.planning.source !== "mission-control") {
      failures.push(
        `${blueprint.id}: materialized plan task must keep mission-control planning provenance (${blueprint.plan_path})`,
      );
      continue;
    }
    for (const field of taskParityFields) {
      if (blueprint[field] === undefined) continue;
      if (
        field === "tags" &&
        Array.isArray(blueprint.tags) &&
        Array.isArray(task.tags) &&
        blueprint.tags.every((tag) => task.tags.includes(tag))
      ) continue;
      if (JSON.stringify(blueprint[field]) !== JSON.stringify(task[field])) {
        failures.push(
          `${blueprint.id}: plan/TODO parity drift in ${field} (${blueprint.plan_path})`,
        );
      }
    }
  }
}

function gitEnvironment({ forceEmptyGrafts = true } = {}) {
  const environment = { ...process.env };
  const blockedNames = new Set([
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_CONFIG",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_NOSYSTEM",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_SYSTEM",
    "GIT_DIR",
    "GIT_GRAFT_FILE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_PREFIX",
    "GIT_REPLACE_REF_BASE",
    "GIT_WORK_TREE",
  ]);
  for (const key of Object.keys(environment)) {
    const upperKey = key.toUpperCase();
    if (
      blockedNames.has(upperKey) ||
      upperKey === "GIT_CONFIG_COUNT" ||
      /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(upperKey)
    ) {
      delete environment[key];
    }
  }
  environment.GIT_CONFIG_GLOBAL = gitNullDevice;
  environment.GIT_CONFIG_SYSTEM = gitNullDevice;
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_LITERAL_PATHSPECS = "1";
  environment.GIT_NO_REPLACE_OBJECTS = "1";
  if (forceEmptyGrafts) {
    environment.GIT_GRAFT_FILE = gitNullDevice;
  }
  environment.LANG = "C";
  environment.LC_ALL = "C";
  return environment;
}

function trustedGitOutput(args) {
  return trustedGitOutputAt(root, args);
}

function trustedGitOutputAt(repositoryRoot, args, options = {}) {
  return execFileSync(
    trustedGitExecutable,
    [
      "--no-replace-objects",
      ...gitLongPathArguments,
      "-C",
      repositoryRoot,
      ...args,
    ],
    {
      encoding: "utf8",
      env: gitEnvironment(options),
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15000,
    },
  );
}

function exactGitRepositoryAvailable() {
  try {
    const repositoryRoot = trustedGitOutput([
      "rev-parse",
      "--show-toplevel",
    ]).trim();
    return sameRealPath(repositoryRoot, root);
  } catch {
    return false;
  }
}

function changesetHasWriterAuditEvidence(value) {
  return Boolean(
    value?.creation_authorization !== undefined ||
      value?.approval?.runtime_authorization !== undefined ||
      value?.runtime_authorization !== undefined ||
      value?.supersession?.runtime_authorization !== undefined,
  );
}

function assertNoGitHistoryReplacementMetadataAt(
  repositoryRoot,
  errorMessage,
) {
  const gitOutput = (args) => trustedGitOutputAt(repositoryRoot, args);
  const metadataGitOutput = (args) =>
    trustedGitOutputAt(repositoryRoot, args, { forceEmptyGrafts: false });
  const replacementReferences = gitOutput([
    "for-each-ref",
    "--format=%(refname)",
    "refs/replace",
  ])
    .split(/\s+/)
    .filter(Boolean);
  const replacementPath = resolve(
    repositoryRoot,
    gitOutput([
      "rev-parse",
      "--git-path",
      "refs/replace",
    ]).trim(),
  );
  let looseReplacementEntries = false;
  if (existsSync(replacementPath)) {
    const replacementInfo = lstatSync(replacementPath);
    looseReplacementEntries =
      replacementInfo.isSymbolicLink() ||
      !replacementInfo.isDirectory() ||
      readdirSync(replacementPath).length > 0;
  }
  const graftsPath = resolve(
    repositoryRoot,
    metadataGitOutput([
      "rev-parse",
      "--git-path",
      "info/grafts",
    ]).trim(),
  );
  if (
    replacementReferences.length > 0 ||
    looseReplacementEntries ||
    existsSync(graftsPath)
  ) {
    throw new Error(errorMessage);
  }
}

function assertNoGitHistoryReplacementMetadata() {
  assertNoGitHistoryReplacementMetadataAt(
    root,
    "Git replacement refs or grafts are present; authenticated writer audit history requires the canonical commit graph",
  );
}

function proveUnbornGitRepository() {
  try {
    const symbolicHead = trustedGitOutput([
      "symbolic-ref",
      "--quiet",
      "HEAD",
    ]).trim();
    if (!symbolicHead.startsWith("refs/heads/")) {
      return false;
    }
    trustedGitOutput(["check-ref-format", symbolicHead]);
    const references = trustedGitOutput([
      "for-each-ref",
      "--format=%(refname)",
    ])
      .split(/\s+/)
      .filter(Boolean);
    if (references.length > 0) return false;
    const reflogEntries = trustedGitOutput([
      "reflog",
      "show",
      "--all",
      "--format=%H",
    ])
      .split(/\s+/)
      .filter(Boolean);
    if (reflogEntries.length > 0) return false;
    const objectTypes = trustedGitOutput([
      "cat-file",
      "--batch-all-objects",
      "--batch-check=%(objecttype)",
    ])
      .split(/\s+/)
      .filter(Boolean);
    // A never-committed repository may contain staged blob objects. Any
    // commit, tree or tag proves prior initialized history even if all live
    // refs were later deleted.
    return objectTypes.every((type) => type === "blob");
  } catch {
    return false;
  }
}

function loadHistoricalChangesets() {
  const recordsById = new Map();
  const touchedReferencesById = new Map();
  if (!exactGitRepositoryAvailable()) {
    return {
      available: false,
      fresh: false,
      head: null,
      reason: "exact Git repository is unavailable",
      recordsById,
      touchedReferencesById,
    };
  }

  try {
    assertNoGitHistoryReplacementMetadata();
  } catch (error) {
    failures.push(
      `authenticated writer audit history replacement metadata check failed: ${error.message}`,
    );
    return {
      available: false,
      fresh: false,
      head: null,
      reason: "Git replacement refs or grafts are present",
      recordsById,
      touchedReferencesById,
    };
  }

  let head;
  try {
    if (
      trustedGitOutput([
        "rev-parse",
        "--is-shallow-repository",
      ]).trim() === "true"
    ) {
      failures.push(
        "authenticated writer audit history requires a non-shallow data repository",
      );
      return {
        available: false,
        fresh: false,
        head: null,
        reason: "data repository is shallow",
        recordsById,
        touchedReferencesById,
      };
    }
    head = trustedGitOutput([
      "rev-parse",
      "--verify",
      "HEAD",
    ]).trim();
  } catch {
    const fresh = proveUnbornGitRepository();
    return {
      available: false,
      fresh,
      head: null,
      reason: fresh
        ? "data repository has no initial commit"
        : "data repository HEAD inspection failed",
      recordsById,
      touchedReferencesById,
    };
  }

  let references;
  try {
    references = trustedGitOutput([
      "rev-list",
      "--full-history",
      "--topo-order",
      "HEAD",
      "--",
      pendingChangesetsDirectory,
      publishedChangesetsDirectory,
      supersededChangesetsDirectory,
    ])
      .split(/\s+/)
      .filter(Boolean);
  } catch (error) {
    failures.push(
      `authenticated writer audit history inspection failed: ${error.message}`,
    );
    return {
      available: false,
      fresh: false,
      head,
      reason: "Git history traversal failed",
      recordsById,
      touchedReferencesById,
    };
  }
  const canonicalPathPattern =
    /^data\/mission-control\/changesets\/(?:pending|published|superseded)\/([a-z0-9][a-z0-9-]{0,127})\.json$/;
  try {
    for (const reference of references) {
      const paths = [
        ...new Set(
          trustedGitOutput([
            "diff-tree",
            "--root",
            "--no-commit-id",
            "--no-renames",
            "--name-only",
            "-r",
            "-m",
            "-z",
            reference,
            "--",
            pendingChangesetsDirectory,
            publishedChangesetsDirectory,
            supersededChangesetsDirectory,
          ])
            .split("\0")
            .filter(Boolean),
        ),
      ];
      for (const path of paths) {
        const pathMatch = canonicalPathPattern.exec(path);
        if (!pathMatch) continue;
        const touchedReferences =
          touchedReferencesById.get(pathMatch[1]) ?? new Set();
        touchedReferences.add(reference);
        touchedReferencesById.set(
          pathMatch[1],
          touchedReferences,
        );
        let rawValue;
        try {
          rawValue = trustedGitOutput(["show", `${reference}:${path}`]);
        } catch {
          // A deleted or renamed-from path has no blob in this snapshot. Its
          // prior version is loaded from the earlier commit that introduced
          // or last changed that exact path.
          continue;
        }
        const value = JSON.parse(rawValue);
        if (
          !value ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          value.id !== pathMatch[1]
        ) {
          throw new Error(`${reference}:${path} is not a canonical changeset`);
        }
        const records = recordsById.get(value.id) ?? [];
        records.push({ reference, path, value });
        recordsById.set(value.id, records);
      }
    }
  } catch (error) {
    failures.push(
      `authenticated writer audit history inspection failed: ${error.message}`,
    );
    return {
      available: false,
      fresh: false,
      head,
      reason: "changeset history parsing failed",
      recordsById: new Map(),
      touchedReferencesById: new Map(),
    };
  }
  return {
    available: true,
    fresh: false,
    head,
    reason: null,
    recordsById,
    touchedReferencesById,
  };
}

function emptyHistoricalChangesets() {
  return {
    available: true,
    fresh: false,
    head: null,
    reason: null,
    recordsById: new Map(),
    touchedReferencesById: new Map(),
  };
}

const changesetHistoryRoot = "data/mission-control/changesets";

function writerModeAtReference(reference) {
  try {
    const historicalConfig = JSON.parse(
      trustedGitOutput(["show", `${reference}:${missionControlConfigFile}`]),
    );
    return historicalConfig?.publish_policy?.writer_mode ??
      "authenticated-capability-v1";
  } catch {
    return null;
  }
}

function changedChangesetPathsAtCommit(reference) {
  return [
    ...new Set(
      trustedGitOutput([
        "diff-tree",
        "--root",
        "--no-commit-id",
        "--no-renames",
        "--name-only",
        "-z",
        "-r",
        "-m",
        reference,
        "--",
        changesetHistoryRoot,
      ])
        .split("\0")
        .filter(Boolean),
    ),
  ];
}

function localChangesetWorktreePaths() {
  const changed = trustedGitOutput([
    "diff",
    "--name-only",
    "-z",
    "HEAD",
    "--",
    changesetHistoryRoot,
  ])
    .split("\0")
    .filter(Boolean);
  const untracked = trustedGitOutput([
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    changesetHistoryRoot,
  ])
    .split("\0")
    .filter(Boolean);
  return [...new Set([...changed, ...untracked])];
}

function exactCommitExists(reference) {
  try {
    trustedGitOutput(["cat-file", "-e", `${reference}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function changesetValidationBase(head) {
  const eventBefore = process.env.GITHUB_EVENT_BEFORE;
  if (
    typeof eventBefore === "string" &&
    /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(eventBefore) &&
    !/^0+$/.test(eventBefore) &&
    exactCommitExists(eventBefore)
  ) {
    return eventBefore;
  }
  if (exactCommitExists("refs/remotes/origin/v3")) {
    try {
      return trustedGitOutput([
        "merge-base",
        head,
        "refs/remotes/origin/v3",
      ]).trim();
    } catch {
      // Fall through to the immediate parent for a standalone local check.
    }
  }
  return exactCommitExists(`${head}^`) ? `${head}^` : null;
}

function nativeGitWriterMode(mode) {
  return ["local-principal-v1", "github-app-workspace-v1"].includes(mode);
}

function transitionMayAddOnlyKeepFiles(parentMode, currentMode, paths) {
  return (
    !nativeGitWriterMode(parentMode) &&
    nativeGitWriterMode(currentMode) &&
    paths.every((path) => path.endsWith("/.gitkeep"))
  );
}

function assertNativeGitWriterChangesetHistoryFrozen() {
  if (!exactGitRepositoryAvailable()) return;
  let head;
  try {
    head = trustedGitOutput(["rev-parse", "--verify", "HEAD"]).trim();
  } catch {
    return;
  }

  const base = changesetValidationBase(head);
  if (base) {
    const commits = trustedGitOutput([
      "rev-list",
      "--reverse",
      "--topo-order",
      "--full-history",
      `${base}..${head}`,
      "--", changesetHistoryRoot, missionControlConfigFile,
    ])
      .split(/\s+/)
      .filter(Boolean);
    // Freeze begins with the native-writer transition, not retrospectively
    // over legitimate legacy changesets. Once begun it cannot be disabled by
    // briefly switching policy back. Inspect only audit/config commits so a
    // long data-only lag does not require one Git process per plan update.
    const nativeHistoryStarts = nativeGitWriterMode(writerModeAtReference(base)) ? [base] : [];
    for (const commit of commits) {
      const currentMode = writerModeAtReference(commit);
      const parent = `${commit}^1`;
      const parentMode = writerModeAtReference(parent);
      let startedBeforeCommit = nativeHistoryStarts.some((start) => {
        try {
          trustedGitOutput(["merge-base", "--is-ancestor", start, commit]);
          return true;
        } catch {
          return false;
        }
      });
      if (!startedBeforeCommit && nativeGitWriterMode(parentMode)) {
        nativeHistoryStarts.push(parent);
        startedBeforeCommit = true;
      }
      if (!startedBeforeCommit) {
        if (!nativeGitWriterMode(currentMode)) continue;
        nativeHistoryStarts.push(commit);
      }
      const paths = changedChangesetPathsAtCommit(commit);
      if (paths.length === 0) continue;
      if (
        !startedBeforeCommit && transitionMayAddOnlyKeepFiles(
          parentMode,
          currentMode,
          paths,
        )
      ) {
        continue;
      }
      failures.push(
        `${commit}: native Git writer profiles freeze ${changesetHistoryRoot}; changed ${paths.join(", ")}`,
      );
    }
  }

  const worktreePaths = localChangesetWorktreePaths();
  if (worktreePaths.length === 0) return;
  if (
    transitionMayAddOnlyKeepFiles(
      writerModeAtReference(head),
      configuredWriterMode,
      worktreePaths,
    )
  ) {
    return;
  }
  failures.push(
    `native Git writer profiles freeze ${changesetHistoryRoot}; working tree changed ${worktreePaths.join(", ")}`,
  );
}

function validateOpaqueChangesetHistoryDirectory(directory, normalizedPaths) {
  const absoluteDirectory = join(root, directory);
  if (!existsSync(absoluteDirectory)) return;
  for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    const normalizedPath = path.normalize("NFC").toLowerCase();
    if (normalizedPaths.has(normalizedPath)) {
      failures.push(`${path}: case or Unicode-normalization collision in legacy changeset history`);
      continue;
    }
    normalizedPaths.add(normalizedPath);
    if (!isSafeRelativePath(path)) {
      failures.push(`${path}: legacy changeset history path is not portable`);
    }
    if (entry.isSymbolicLink()) {
      failures.push(`${path}: legacy changeset history must not contain symlinks`);
    } else if (entry.isDirectory()) {
      validateOpaqueChangesetHistoryDirectory(path, normalizedPaths);
    } else if (!entry.isFile()) {
      failures.push(`${path}: legacy changeset history must contain regular files only`);
    } else if (entry.name === ".gitkeep") {
      continue;
    } else if (!entry.name.endsWith(".json")) {
      failures.push(`${path}: legacy changeset history files must use .json`);
    } else {
      const raw = readFileSync(join(root, path), "utf8");
      try {
        JSON.parse(raw);
      } catch (error) {
        failures.push(`${path}: invalid historical JSON: ${error.message}`);
      }
      if (looksLikeCredentialValue(raw)) {
        failures.push(`${path}: legacy changeset history contains credential-like material`);
      }
    }
  }
}

const quarantineEntriesReferenceCache = new Map();

function quarantineEntriesAtReference(reference) {
  if (quarantineEntriesReferenceCache.has(reference)) {
    return quarantineEntriesReferenceCache.get(reference);
  }
  const treeEntry = trustedGitOutput([
    "ls-tree",
    "--full-tree",
    "-z",
    reference,
    "--",
    missionControlConfigFile,
  ]);
  if (treeEntry === "") {
    quarantineEntriesReferenceCache.set(reference, []);
    return [];
  }
  const entries = treeEntry.split("\0").filter(Boolean);
  if (
    entries.length !== 1 ||
    !/^(?:100644|100755) blob [0-9a-f]{40}(?:[0-9a-f]{24})?\t/.test(
      entries[0],
    ) ||
    entries[0].split("\t", 2)[1] !== missionControlConfigFile
  ) {
    throw new Error(
      `${reference}:${missionControlConfigFile} is not one canonical Git blob`,
    );
  }
  const historicalConfig = JSON.parse(
    trustedGitOutput([
      "show",
      `${reference}:${missionControlConfigFile}`,
    ]),
  );
  if (!isObject(historicalConfig)) {
    throw new Error(
      `${reference}:${missionControlConfigFile} is not a JSON object`,
    );
  }
  const quarantine =
    historicalConfig.publish_policy?.legacy_changeset_quarantine;
  if (quarantine === undefined) return [];
  if (!Array.isArray(quarantine)) {
    throw new Error(
      `${reference}:${missionControlConfigFile} legacy_changeset_quarantine is not a list`,
    );
  }
  quarantineEntriesReferenceCache.set(reference, quarantine);
  return quarantine;
}

function referenceHasExactQuarantineEntry(reference, expectedEntry) {
  const matchingId = quarantineEntriesAtReference(reference).filter(
    (entry) => isObject(entry) && entry.id === expectedEntry.id,
  );
  if (matchingId.length > 1) {
    throw new Error(
      `${reference}:${missionControlConfigFile} duplicates quarantine id ${expectedEntry.id}`,
    );
  }
  return (
    matchingId.length === 1 &&
    canonicalJson(matchingId[0]) === canonicalJson(expectedEntry)
  );
}

function canonicalHistoricalPersistentQuarantineEntry(entry, label) {
  if (
    !isObject(entry) ||
    ![
      "retain",
      "grandfather-authenticated",
      "grandfather-supersession-scope",
    ].includes(entry.terminal_action)
  ) {
    return null;
  }
  const commonShapeIsValid =
    typeof entry.id === "string" &&
    /^[a-z0-9][a-z0-9-]{0,127}$/.test(entry.id) &&
    typeof entry.immutable_payload_digest_sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(entry.immutable_payload_digest_sha256) &&
    typeof entry.record_digest_sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(entry.record_digest_sha256);
  if (entry.terminal_action === "retain") {
    const allowedKeys = new Set([
      "id",
      "immutable_payload_digest_sha256",
      "terminal_action",
      "terminal_status",
      "record_digest_sha256",
    ]);
    if (
      !commonShapeIsValid ||
      Object.keys(entry).some((key) => !allowedKeys.has(key)) ||
      !["published", "superseded"].includes(entry.terminal_status)
    ) {
      throw new Error(`${label} is not a canonical retain quarantine entry`);
    }
    return Object.freeze({ ...entry });
  }
  if (entry.terminal_action === "grandfather-supersession-scope") {
    const allowedKeys = new Set([
      "id",
      "immutable_payload_digest_sha256",
      "terminal_action",
      "record_digest_sha256",
      "provenance_digest_sha256",
    ]);
    if (
      !commonShapeIsValid ||
      Object.keys(entry).some((key) => !allowedKeys.has(key)) ||
      typeof entry.provenance_digest_sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(entry.provenance_digest_sha256)
    ) {
      throw new Error(
        `${label} is not a canonical grandfather-supersession-scope quarantine entry`,
      );
    }
    return Object.freeze({ ...entry });
  }
  const allowedKeys = new Set([
    "id",
    "immutable_payload_digest_sha256",
    "terminal_action",
    "authenticated_status",
    "record_digest_sha256",
    "provenance_digest_sha256",
  ]);
  if (
    !commonShapeIsValid ||
    Object.keys(entry).some((key) => !allowedKeys.has(key)) ||
    !["approved", "published", "superseded"].includes(
      entry.authenticated_status,
    ) ||
    typeof entry.provenance_digest_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(entry.provenance_digest_sha256)
  ) {
    throw new Error(
      `${label} is not a canonical grandfather-authenticated quarantine entry`,
    );
  }
  return Object.freeze({ ...entry });
}

function loadCommittedPersistentQuarantineEntries(historicalChangesets) {
  const retained = new Map();
  if (!historicalChangesets.available) return retained;
  try {
    const references = trustedGitOutput([
      "rev-list",
      "--full-history",
      "--topo-order",
      "HEAD",
      "--",
      missionControlConfigFile,
    ])
      .split(/\s+/)
      .filter(Boolean);
    for (const reference of references) {
      const seenIds = new Set();
      for (const [index, candidate] of
        quarantineEntriesAtReference(reference).entries()) {
        if (isObject(candidate) && typeof candidate.id === "string") {
          if (seenIds.has(candidate.id)) {
            throw new Error(
              `${reference}:${missionControlConfigFile} duplicates quarantine id ${candidate.id}`,
            );
          }
          seenIds.add(candidate.id);
        }
        const entry = canonicalHistoricalPersistentQuarantineEntry(
          candidate,
          `${reference}:${missionControlConfigFile} legacy_changeset_quarantine[${index}]`,
        );
        if (entry === null) continue;
        const previous = retained.get(entry.id);
        if (
          previous !== undefined &&
          canonicalJson(previous) !== canonicalJson(entry)
        ) {
          throw new Error(
            `committed ${entry.terminal_action} quarantine entry ${entry.id} changed across Git history`,
          );
        }
        retained.set(entry.id, entry);
      }
    }
  } catch (error) {
    failures.push(
      `committed persistent quarantine history inspection failed: ${error.message}`,
    );
    return new Map();
  }
  return retained;
}

function loadLegacyQuarantineHistory(quarantine, historicalChangesets) {
  const result = new Map();
  if (quarantine.size === 0) return result;
  if (!historicalChangesets.available || historicalChangesets.head === null) {
    for (const id of quarantine.keys()) {
      result.set(id, {
        available: false,
        committedAtHead: false,
        introductions: [],
        predecessors: [],
      });
    }
    return result;
  }
  try {
    const configReferences = trustedGitOutput([
      "rev-list",
      "--full-history",
      "--topo-order",
      "HEAD",
      "--",
      missionControlConfigFile,
    ])
      .split(/\s+/)
      .filter(Boolean);
    for (const [id, entry] of quarantine) {
      const committedAtHead = referenceHasExactQuarantineEntry(
        historicalChangesets.head,
        entry,
      );
      const introductions = [];
      const predecessors = new Set();
      if (committedAtHead) {
        for (const reference of configReferences) {
          if (!referenceHasExactQuarantineEntry(reference, entry)) continue;
          const revision = trustedGitOutput([
            "rev-list",
            "--parents",
            "-n",
            "1",
            reference,
          ])
            .split(/\s+/)
            .filter(Boolean);
          if (revision[0] !== reference) {
            throw new Error(
              `cannot resolve quarantine history parents for ${reference}`,
            );
          }
          const parents = revision.slice(1);
          const inheritedFromParent = parents.some((parent) =>
            referenceHasExactQuarantineEntry(parent, entry),
          );
          if (!inheritedFromParent) {
            introductions.push(reference);
            for (const parent of parents) predecessors.add(parent);
          }
        }
        if (introductions.length === 0) {
          throw new Error(
            `cannot prove introduction commit for quarantine id ${id}`,
          );
        }
      }
      result.set(id, {
        available: true,
        committedAtHead,
        introductions,
        predecessors: committedAtHead
          ? [...predecessors]
          : [historicalChangesets.head],
      });
    }
  } catch (error) {
    failures.push(
      `legacy changeset quarantine history inspection failed: ${error.message}`,
    );
    for (const id of quarantine.keys()) {
      result.set(id, {
        available: false,
        committedAtHead: false,
        introductions: [],
        predecessors: [],
      });
    }
  }
  return result;
}

let reachableCommitParentsCache = null;
const reachableAncestryCache = new Map();

function reachableCommitParents() {
  if (reachableCommitParentsCache !== null) {
    return reachableCommitParentsCache;
  }
  const graph = new Map();
  const objectIdPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
  for (const line of trustedGitOutput([
    "rev-list",
    "--parents",
    "--topo-order",
    "HEAD",
  ]).split("\n")) {
    if (line === "") continue;
    const [reference, ...parents] = line.split(/\s+/);
    if (
      !objectIdPattern.test(reference) ||
      parents.some((parent) => !objectIdPattern.test(parent))
    ) {
      throw new Error("reachable Git commit graph is malformed");
    }
    graph.set(reference, parents);
  }
  reachableCommitParentsCache = graph;
  return graph;
}

function referenceDescendsFromOrEquals(reference, ancestor) {
  if (reference === ancestor) return true;
  const cacheKey = `${reference}:${ancestor}`;
  if (reachableAncestryCache.has(cacheKey)) {
    return reachableAncestryCache.get(cacheKey);
  }
  const graph = reachableCommitParents();
  const pending = [reference];
  const visited = new Set();
  let found = false;
  while (pending.length > 0 && !found) {
    const candidate = pending.pop();
    if (visited.has(candidate)) continue;
    visited.add(candidate);
    for (const parent of graph.get(candidate) ?? []) {
      if (parent === ancestor) {
        found = true;
        break;
      }
      pending.push(parent);
    }
  }
  reachableAncestryCache.set(cacheKey, found);
  return found;
}

function isStrictGitAncestor(ancestor, descendant) {
  return (
    ancestor !== descendant &&
    referenceDescendsFromOrEquals(descendant, ancestor)
  );
}

function revisionParents(reference) {
  const parents = reachableCommitParents().get(reference);
  if (parents === undefined) {
    throw new Error(`cannot resolve parents for ${reference}`);
  }
  return parents;
}

function ancestryPathReferences(ancestor, descendant) {
  if (ancestor === descendant) return [ancestor];
  if (!isStrictGitAncestor(ancestor, descendant)) return [];
  const descendants = trustedGitOutput([
    "rev-list",
    "--ancestry-path",
    "--topo-order",
    `${ancestor}..${descendant}`,
  ])
    .split(/\s+/)
    .filter(Boolean);
  if (!descendants.includes(descendant)) {
    throw new Error(
      `cannot prove ancestry path from ${ancestor} to ${descendant}`,
    );
  }
  return [ancestor, ...descendants];
}

const changesetSnapshotCache = new Map();

function changesetAtReference(reference, changesetId) {
  const cacheKey = `${reference}:${changesetId}`;
  if (changesetSnapshotCache.has(cacheKey)) {
    return changesetSnapshotCache.get(cacheKey);
  }
  const matches = [];
  for (const directory of [
    pendingChangesetsDirectory,
    publishedChangesetsDirectory,
    supersededChangesetsDirectory,
  ]) {
    const path = `${directory}/${changesetId}.json`;
    try {
      const rawValue = trustedGitOutput(["show", `${reference}:${path}`]);
      const value = JSON.parse(rawValue);
      if (!isObject(value) || value.id !== changesetId) {
        throw new Error(
          `${reference}:${path} is not a canonical changeset`,
        );
      }
      matches.push({ reference, path, value });
    } catch (error) {
      if (error instanceof SyntaxError) throw error;
      const treeEntry = trustedGitOutput([
        "ls-tree",
        "--full-tree",
        "-z",
        reference,
        "--",
        path,
      ]);
      if (treeEntry !== "") throw error;
    }
  }
  if (matches.length > 1) {
    throw new Error(
      `${reference} duplicates changeset ${changesetId} across audit states`,
    );
  }
  const result = matches[0] ?? null;
  changesetSnapshotCache.set(cacheKey, result);
  return result;
}

function historicalRecordMatchesQuarantine(value, entry) {
  if (
    jsonDigest(immutableChangesetPayload(value)) !==
      entry.immutable_payload_digest_sha256
  ) {
    return false;
  }
  if (entry.terminal_action === "supersede") {
    return (
      value.writer_audit_provenance === undefined &&
      !changesetHasWriterAuditEvidence(value) &&
      ["pending", "approved"].includes(value.status)
    );
  }
  if (entry.terminal_action === "retain") {
    return (
      value.writer_audit_provenance === undefined &&
      !changesetHasWriterAuditEvidence(value) &&
      value.status === entry.terminal_status &&
      jsonDigest(value) === entry.record_digest_sha256
    );
  }
  if (entry.terminal_action === "grandfather-supersession-scope") {
    return (
      value.status === "superseded" &&
      value.writer_audit_provenance?.mode === "authenticated" &&
      changesetHasWriterAuditEvidence(value) &&
      jsonDigest(value) === entry.record_digest_sha256 &&
      jsonDigest(value.writer_audit_provenance) ===
        entry.provenance_digest_sha256
    );
  }
  return (
    entry.terminal_action === "grandfather-authenticated" &&
    value.writer_audit_provenance?.mode === "legacy-transition" &&
    changesetHasWriterAuditEvidence(value) &&
    value.status === entry.authenticated_status &&
    jsonDigest(value) === entry.record_digest_sha256 &&
    jsonDigest(value.writer_audit_provenance) ===
      entry.provenance_digest_sha256
  );
}

function quarantinePredecessorRecords(entry) {
  const history = configuredLegacyQuarantineHistory.get(entry.id);
  if (!history?.available || history.predecessors.length === 0) return null;
  try {
    return history.predecessors.map((reference) =>
      changesetAtReference(reference, entry.id),
    );
  } catch (error) {
    failures.push(
      `legacy changeset quarantine predecessor inspection failed for ${entry.id}: ${error.message}`,
    );
    return null;
  }
}

function quarantineHasExactPredecessorRecord(entry, currentValue) {
  const records = quarantinePredecessorRecords(entry);
  return (
    records !== null &&
    records.length > 0 &&
    records.every(
      (record) =>
        record !== null &&
        historicalRecordMatchesQuarantine(record.value, entry),
    ) &&
    supersedePredecessorHistoryIsContinuous(entry, currentValue)
  );
}

const supersedePredecessorContinuityCache = new Map();
const changesetIntroductionCache = new Map();

function allChangesetIntroductions(changesetId) {
  if (!changesetIntroductionCache.has(changesetId)) {
    const candidateReferences = new Set(
      (
        historicalChangesets.recordsById.get(changesetId) ?? []
      ).map(({ reference: candidateReference }) => candidateReference),
    );
    const introductions = [];
    for (const candidateReference of candidateReferences) {
      if (
        changesetAtReference(candidateReference, changesetId) === null
      ) {
        continue;
      }
      const inheritedFromParent = revisionParents(
        candidateReference,
      ).some(
        (parent) =>
          changesetAtReference(parent, changesetId) !== null,
      );
      if (!inheritedFromParent) {
        introductions.push(candidateReference);
      }
    }
    changesetIntroductionCache.set(changesetId, introductions);
  }
  return changesetIntroductionCache.get(changesetId);
}

function changesetIntroductionsBefore(reference, changesetId) {
  return allChangesetIntroductions(changesetId)
    .filter(
      (introduction) =>
        introduction === reference ||
        isStrictGitAncestor(introduction, reference),
    );
}

function authenticatedLegacySupersessionMatchesCurrent(
  value,
  entry,
  currentValue,
) {
  return (
    currentValue !== undefined &&
    value.status === "superseded" &&
    value.writer_audit_provenance?.mode === "legacy-transition" &&
    changesetHasWriterAuditEvidence(value) &&
    jsonDigest(immutableChangesetPayload(value)) ===
      entry.immutable_payload_digest_sha256 &&
    canonicalJson(value) === canonicalJson(currentValue)
  );
}

function supersedePredecessorHistoryIsContinuous(entry, currentValue) {
  if (entry.terminal_action !== "supersede") return true;
  const cacheKey = canonicalJson([
    entry,
    currentValue === undefined ? null : jsonDigest(currentValue),
  ]);
  if (supersedePredecessorContinuityCache.has(cacheKey)) {
    return supersedePredecessorContinuityCache.get(cacheKey);
  }
  const history = configuredLegacyQuarantineHistory.get(entry.id);
  if (!history?.available || history.predecessors.length === 0) {
    supersedePredecessorContinuityCache.set(cacheKey, false);
    return false;
  }
  try {
    if (historicalChangesets.head === null) {
      supersedePredecessorContinuityCache.set(cacheKey, false);
      return false;
    }
    const introductions = new Set(
      changesetIntroductionsBefore(
        historicalChangesets.head,
        entry.id,
      ),
    );
    if (introductions.size !== 1) {
      supersedePredecessorContinuityCache.set(cacheKey, false);
      return false;
    }
    const [recordIntroduction] = introductions;
    const predecessorHistoryIsContinuous = history.predecessors.every(
      (predecessor) => {
        const references = ancestryPathReferences(
          recordIntroduction,
          predecessor,
        );
        return (
          references.length > 0 &&
          references.every((reference) => {
            const record = changesetAtReference(reference, entry.id);
            return (
              record !== null &&
              historicalRecordMatchesQuarantine(record.value, entry)
            );
          })
        );
      },
    );
    if (
      !predecessorHistoryIsContinuous ||
      !history.committedAtHead ||
      history.introductions.length !== 1
    ) {
      supersedePredecessorContinuityCache.set(cacheKey, false);
      return false;
    }

    const [quarantineIntroduction] = history.introductions;
    if (
      !isStrictGitAncestor(
        recordIntroduction,
        quarantineIntroduction,
      )
    ) {
      supersedePredecessorContinuityCache.set(cacheKey, false);
      return false;
    }
    const references = ancestryPathReferences(
      recordIntroduction,
      historicalChangesets.head,
    );
    if (references.length === 0) {
      supersedePredecessorContinuityCache.set(cacheKey, false);
      return false;
    }

    const phaseByReference = new Map();
    for (const reference of references) {
      const isQuarantinedReference =
        referenceDescendsFromOrEquals(
          reference,
          quarantineIntroduction,
        );
      if (
        isQuarantinedReference &&
        !referenceHasExactQuarantineEntry(reference, entry)
      ) {
        supersedePredecessorContinuityCache.set(cacheKey, false);
        return false;
      }
      const record = changesetAtReference(reference, entry.id);
      if (
        record !== null &&
        historicalRecordMatchesQuarantine(record.value, entry)
      ) {
        if (isQuarantinedReference) {
          phaseByReference.set(reference, "active");
        }
        continue;
      }
      if (
        isQuarantinedReference &&
        record !== null &&
        authenticatedLegacySupersessionMatchesCurrent(
          record.value,
          entry,
          currentValue,
        )
      ) {
        phaseByReference.set(reference, "terminal");
        continue;
      }
      supersedePredecessorContinuityCache.set(cacheKey, false);
      return false;
    }

    const terminalIntroductions = new Set();
    for (const reference of references) {
      const phase = phaseByReference.get(reference);
      if (phase === undefined) continue;
      const parentsInsideCorridor = revisionParents(reference).filter(
        (parent) =>
          referenceDescendsFromOrEquals(
            parent,
            quarantineIntroduction,
          ),
      );
      if (
        phase === "active" &&
        parentsInsideCorridor.some(
          (parent) => phaseByReference.get(parent) === "terminal",
        )
      ) {
        supersedePredecessorContinuityCache.set(cacheKey, false);
        return false;
      }
      if (
        phase === "terminal" &&
        !parentsInsideCorridor.some(
          (parent) => phaseByReference.get(parent) === "terminal",
        )
      ) {
        terminalIntroductions.add(reference);
      }
    }
    const continuous = terminalIntroductions.size <= 1;
    supersedePredecessorContinuityCache.set(cacheKey, continuous);
    return continuous;
  } catch (error) {
    failures.push(
      `legacy supersede quarantine continuity inspection failed for ${entry.id}: ${error.message}`,
    );
    supersedePredecessorContinuityCache.set(cacheKey, false);
    return false;
  }
}

function persistentQuarantineHistoryIsContinuous(entry) {
  if (
    ![
      "retain",
      "grandfather-authenticated",
      "grandfather-supersession-scope",
    ].includes(entry.terminal_action)
  ) {
    return true;
  }
  const history = configuredLegacyQuarantineHistory.get(entry.id);
  if (
    !history?.available ||
    !history.committedAtHead ||
    history.introductions.length !== 1 ||
    historicalChangesets.head === null
  ) {
    return false;
  }
  try {
    const exactRecordIntroductions = new Set();
    for (const reference of new Set(
      (
        historicalChangesets.recordsById.get(entry.id) ?? []
      ).map(({ reference: recordReference }) => recordReference),
    )) {
      const record = changesetAtReference(reference, entry.id);
      if (
        record === null ||
        !historicalRecordMatchesQuarantine(record.value, entry)
      ) {
        continue;
      }
      const inheritedExactRecord = revisionParents(reference).some(
        (parent) => {
          const parentRecord = changesetAtReference(parent, entry.id);
          return (
            parentRecord !== null &&
            historicalRecordMatchesQuarantine(
              parentRecord.value,
              entry,
            )
          );
        },
      );
      if (!inheritedExactRecord) {
        exactRecordIntroductions.add(reference);
      }
    }
    if (exactRecordIntroductions.size !== 1) return false;
    const [recordIntroduction] = exactRecordIntroductions;
    const [quarantineIntroduction] = history.introductions;
    if (
      !isStrictGitAncestor(
        recordIntroduction,
        quarantineIntroduction,
      )
    ) {
      return false;
    }
    const recordReferences = ancestryPathReferences(
      recordIntroduction,
      historicalChangesets.head,
    );
    const quarantineReferences = ancestryPathReferences(
      quarantineIntroduction,
      historicalChangesets.head,
    );
    return (
      recordReferences.length > 0 &&
      recordReferences.every((reference) => {
        const record = changesetAtReference(reference, entry.id);
        return (
          record !== null &&
          historicalRecordMatchesQuarantine(record.value, entry)
        );
      }) &&
      quarantineReferences.length > 0 &&
      quarantineReferences.every((reference) =>
        referenceHasExactQuarantineEntry(reference, entry),
      )
    );
  } catch (error) {
    failures.push(
      `persistent quarantine continuity inspection failed for ${entry.id}: ${error.message}`,
    );
    return false;
  }
}

function grandfatherIntroductionFreezesAuthenticatedRecord(entry) {
  if (entry.terminal_action !== "grandfather-authenticated") return true;
  const history = configuredLegacyQuarantineHistory.get(entry.id);
  if (
    !history?.available ||
    !history.committedAtHead ||
    history.introductions.length === 0
  ) {
    return false;
  }
  try {
    return history.introductions.every((reference) => {
      const record = changesetAtReference(reference, entry.id);
      return (
        record !== null &&
        historicalRecordMatchesQuarantine(record.value, entry)
      );
    });
  } catch (error) {
    failures.push(
      `authenticated legacy grandfather introduction inspection failed for ${entry.id}: ${error.message}`,
    );
    return false;
  }
}

function grandfatherHasOriginalLegacyHistory(entry) {
  if (entry.terminal_action !== "grandfather-authenticated") return true;
  try {
    const records =
      historicalChangesets.recordsById.get(entry.id) ?? [];
    const provenanceRecords = records.filter(
      ({ value }) =>
        value.writer_audit_provenance?.mode ===
          "legacy-transition" &&
        jsonDigest(value.writer_audit_provenance) ===
          entry.provenance_digest_sha256 &&
        jsonDigest(immutableChangesetPayload(value)) ===
          entry.immutable_payload_digest_sha256,
    );
    const introductions = [];
    for (const provenanceRecord of provenanceRecords) {
      const revision = trustedGitOutput([
        "rev-list",
        "--parents",
        "-n",
        "1",
        provenanceRecord.reference,
      ])
        .split(/\s+/)
        .filter(Boolean);
      if (
        revision[0] !== provenanceRecord.reference ||
        revision.length < 2
      ) {
        return false;
      }
      const parents = revision.slice(1).map((parent) => ({
        reference: parent,
        record: changesetAtReference(parent, entry.id),
      }));
      const inheritedPinnedProvenance = parents.some(
        ({ record }) =>
          record?.value.writer_audit_provenance?.mode ===
            "legacy-transition" &&
          jsonDigest(record.value.writer_audit_provenance) ===
            entry.provenance_digest_sha256,
      );
      if (!inheritedPinnedProvenance) {
        introductions.push({
          value: provenanceRecord.value,
          parents,
        });
      }
    }
    return (
      introductions.length > 0 &&
      introductions.every(({ value, parents }) => {
        const firstAuthenticatedPhase =
          value.writer_audit_provenance
            ?.first_authenticated_phase;
        const allowedPredecessorStatuses = {
          approval: ["pending"],
          publication: ["approved"],
          supersession: ["pending", "approved"],
        }[firstAuthenticatedPhase] ?? [];
        return parents.every(({ record: predecessor }) => {
          return (
            predecessor !== null &&
            predecessor.value.writer_audit_provenance === undefined &&
            !changesetHasWriterAuditEvidence(predecessor.value) &&
            allowedPredecessorStatuses.includes(
              predecessor.value.status,
            ) &&
            jsonDigest(
              immutableChangesetPayload(predecessor.value),
            ) === entry.immutable_payload_digest_sha256
          );
        });
      })
    );
  } catch (error) {
    failures.push(
      `authenticated legacy grandfather predecessor inspection failed for ${entry.id}: ${error.message}`,
    );
    return false;
  }
}

function activeQuarantinedRecordMatchesPredecessor(value, entry) {
  const records = quarantinePredecessorRecords(entry);
  return (
    records !== null &&
    records.length > 0 &&
    records.every(
      (record) =>
        record !== null &&
        canonicalJson(record.value) === canonicalJson(value),
    )
  );
}

function quarantinePredatesAuthenticatedTransition(value, entry) {
  const history = configuredLegacyQuarantineHistory.get(entry.id);
  if (
    !history?.available ||
    !history.committedAtHead ||
    history.introductions.length === 0
  ) {
    return false;
  }
  try {
    const committedTransitions = (
      historicalChangesets.recordsById.get(value.id) ?? []
    ).filter(
      ({ value: historicalValue }) =>
        historicalValue.writer_audit_provenance?.mode ===
          "legacy-transition" &&
        jsonDigest(immutableChangesetPayload(historicalValue)) ===
          entry.immutable_payload_digest_sha256,
    );
    if (committedTransitions.length === 0) {
      return history.introductions.every(
        (introduction) =>
          introduction === historicalChangesets.head ||
          isStrictGitAncestor(
            introduction,
            historicalChangesets.head,
          ),
      );
    }
    return committedTransitions.every(({ reference }) =>
      history.introductions.every((introduction) =>
        isStrictGitAncestor(introduction, reference),
      ),
    );
  } catch (error) {
    failures.push(
      `legacy changeset quarantine transition-order inspection failed for ${entry.id}: ${error.message}`,
    );
    return false;
  }
}

function isGitTrackedPath(path) {
  try {
    const repositoryRoot = execFileSync(
      trustedGitExecutable,
      [...gitLongPathArguments, "-C", root, "rev-parse", "--show-toplevel"],
      {
        encoding: "utf8",
        env: gitEnvironment(),
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    if (!sameRealPath(repositoryRoot, root)) return false;
    const stageEntries = execFileSync(
      trustedGitExecutable,
      [
        ...gitLongPathArguments,
        "-C",
        root,
        "ls-files",
        "--cached",
        "--stage",
        "--error-unmatch",
        "-z",
        "--",
        path,
      ],
      {
        encoding: "utf8",
        env: gitEnvironment(),
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).split("\0").filter(Boolean);
    // Parse the stable stage record independently from platform-sensitive
    // `ls-files -v` tags, then inspect the exact index flags below.
    const stageEntry = stageEntries.length === 1
      ? stageEntries[0].match(/^[0-9]{6} ([0-9a-f]+) 0\t/u)
      : null;
    if (!stageEntry) return false;
    const visibilityEntries = execFileSync(
      trustedGitExecutable,
      [
        ...gitLongPathArguments,
        "-C",
        root,
        "ls-files",
        "--cached",
        "-v",
        "--error-unmatch",
        "-z",
        "--",
        path,
      ],
      {
        encoding: "utf8",
        env: gitEnvironment(),
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).split("\0").filter(Boolean);
    // `-v` is the stable porcelain for the two index visibility bits: H is a
    // normal cached entry, lowercase h is assume-unchanged and S is
    // skip-worktree. Keep this separate from `--stage`; their combined output
    // shape differs across supported Git builds.
    if (visibilityEntries.length !== 1 || visibilityEntries[0] !== `H ${path}`) {
      return false;
    }
    const emptyBlob = execFileSync(
      trustedGitExecutable,
      [...gitLongPathArguments, "-C", root, "hash-object", "--stdin"],
      {
        encoding: "utf8",
        env: gitEnvironment(),
        input: "",
        stdio: ["pipe", "pipe", "ignore"],
      },
    ).trim();
    // Intent-to-add is the only remaining hidden state and uses the empty blob
    // placeholder. Avoid `--debug` for ordinary entries because its transient
    // in-memory flags are not a cross-platform interface.
    if (stageEntry[1] !== emptyBlob) return true;
    const debugOutput = execFileSync(
      trustedGitExecutable,
      [
        ...gitLongPathArguments,
        "-C",
        root,
        "ls-files",
        "--debug",
        "--error-unmatch",
        "--",
        path,
      ],
      {
        encoding: "utf8",
        env: gitEnvironment(),
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const flagMatches = [...debugOutput.matchAll(/\bflags:\s+([0-9a-f]+)\b/giu)];
    if (flagMatches.length !== 1) return false;
    const flags = Number.parseInt(flagMatches[0][1], 16);
    return (flags & 0x20000000) === 0;
  } catch {
    return false;
  }
}

function sameRealPath(left, right) {
  // Windows file identifiers can exceed Number.MAX_SAFE_INTEGER. Keep them
  // as bigint so distinct directories cannot collapse to the same rounded
  // inode while an 8.3 alias of the same directory still compares equal.
  const leftStat = statSync(left, { bigint: true });
  const rightStat = statSync(right, { bigint: true });
  if (
    leftStat.dev === rightStat.dev
    && leftStat.ino !== 0n
    && leftStat.ino === rightStat.ino
  ) {
    return true;
  }
  const canonicalRealPath = realpathSync.native ?? realpathSync;
  const leftRealPath = canonicalRealPath(left);
  const rightRealPath = canonicalRealPath(right);
  return process.platform === "win32"
    ? leftRealPath.toLowerCase() === rightRealPath.toLowerCase()
    : leftRealPath === rightRealPath;
}

function isValidCalendarDate(value) {
  if (typeof value !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) {
    return false;
  }
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function looksLikeCredentialValue(candidate) {
  const value = candidate.trim();
  return (
    /^(?:basic|bearer)\s+\S+/i.test(value) ||
    /(?:^|[^a-z0-9])(?:proxy-)?authorization["']?\s*[:=]\s*["']?(?:basic|bearer)\s+\S+/i.test(
      value,
    ) ||
    /(?:^|[^a-z0-9])(?:gh[pousr]_|github_pat_|sk-|xox[baprs]-|ya29\.)[a-z0-9_-]{6,}/i.test(
      value,
    ) ||
    /(?:^|[^A-Z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?:$|[^A-Z0-9])/.test(value) ||
    /(?:^|[^A-Za-z0-9])AIza[A-Za-z0-9_-]{20,}(?:$|[^A-Za-z0-9_-])/.test(value) ||
    /(?:^|[^A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}(?:$|[^A-Za-z0-9_-])/.test(
      value,
    ) ||
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)
  );
}

function isCredentialParameterName(key) {
  const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    ["auth", "jwt", "session", "sessionid", "sid", "sig"].includes(normalizedKey) ||
    /(?:accessid|accesskey|apikey|authorization|credential|password|passwd|privatekey|secret|signature|token)/.test(
      normalizedKey,
    )
  );
}

const maxCredentialDecodePasses = 12;

function decodedCredentialCandidates(candidate) {
  const candidates = [];
  let current = candidate;
  for (let depth = 0; depth <= maxCredentialDecodePasses; depth += 1) {
    if (!candidates.includes(current)) candidates.push(current);
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) return { candidates, truncated: false };
      current = decoded;
    } catch {
      return { candidates, truncated: true };
    }
  }
  return { candidates, truncated: true };
}

function containsCredentialParameterSyntax(candidate) {
  const parameterPattern = /(?:^|[?&#;])([^=?&#;]+)=/g;
  const serializedFieldPattern =
    /(?:^|[?&#;,{\[])\s*(?:\\?["'])?([^"'\\:=?&#;,\[\]{}]+?)(?:\\?["'])?\s*:/g;
  return [parameterPattern, serializedFieldPattern].some((pattern) =>
    [...candidate.matchAll(pattern)].some((match) =>
      isCredentialParameterName(match[1]),
    ),
  );
}

function parseNestedHttpUrl(candidate) {
  if (!/^(?:https?:\/\/|[/?#])/i.test(candidate)) return null;
  try {
    const nestedUrl = new URL(candidate, "https://credential-scan.invalid/");
    return ["http:", "https:"].includes(nestedUrl.protocol) ? nestedUrl : null;
  } catch {
    return null;
  }
}

function hasCredentialMaterialInCandidate(candidate, depth) {
  if (
    looksLikeCredentialValue(candidate) ||
    containsCredentialParameterSyntax(candidate) ||
    (candidate.includes("=") &&
      hasCredentialLikeParameters(new URLSearchParams(candidate), depth))
  ) {
    return true;
  }
  const nestedUrl = parseNestedHttpUrl(candidate);
  return Boolean(
    nestedUrl &&
      (depth >= 3 || hasCredentialMaterialInUrl(nestedUrl, depth + 1)),
  );
}

function hasCredentialLikeParameters(parameters, depth) {
  for (const [key, parameterValue] of parameters.entries()) {
    const decodedKey = decodedCredentialCandidates(key);
    if (
      decodedKey.truncated ||
      decodedKey.candidates.some(isCredentialParameterName)
    ) {
      return true;
    }
    const decoded = decodedCredentialCandidates(parameterValue);
    if (decoded.truncated) return true;
    for (const candidate of decoded.candidates) {
      if (hasCredentialMaterialInCandidate(candidate, depth)) return true;
    }
  }
  return false;
}

function hasCredentialMaterialInUrl(url, depth) {
  const fragment = decodedCredentialCandidates(url.hash.slice(1));
  const decodedPathComponents = url.pathname
    .split("/")
    .filter(Boolean)
    .map((component) => decodedCredentialCandidates(component));
  const hostnameCandidates = decodedCredentialCandidates(url.hostname);
  return (
    Boolean(url.username || url.password) ||
    hostnameCandidates.truncated ||
    hostnameCandidates.candidates.some(looksLikeCredentialValue) ||
    hasCredentialLikeParameters(url.searchParams, depth) ||
    decodedPathComponents.some(
      (component) =>
        component.truncated ||
        component.candidates.some((candidate) =>
          hasCredentialMaterialInCandidate(candidate, depth),
        ),
    ) ||
    fragment.truncated ||
    fragment.candidates.some((candidate) =>
      hasCredentialMaterialInCandidate(candidate, depth),
    )
  );
}

function isExternalHttpUrl(value) {
  if (typeof value !== "string") return false;
  const rawCandidates = decodedCredentialCandidates(value);
  if (
    rawCandidates.truncated ||
    rawCandidates.candidates.some(looksLikeCredentialValue)
  ) {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      Boolean(url.hostname) &&
      !hasCredentialMaterialInUrl(url, 0)
    );
  } catch {
    return false;
  }
}

function yamlBlockScalarLineIndexes(source) {
  const ranges = [];
  const document = parseDocument(source);
  visit(document, {
    Scalar(_key, node) {
      if (
        ["BLOCK_LITERAL", "BLOCK_FOLDED"].includes(node.type) &&
        Array.isArray(node.range)
      ) {
        ranges.push([node.range[0], node.range[2] ?? node.range[1]]);
      }
    },
  });
  const indexes = new Set();
  let offset = 0;
  for (const [lineIndex, line] of source.split(/\r?\n/).entries()) {
    if (ranges.some(([start, end]) => offset >= start && offset < end)) {
      indexes.add(lineIndex);
    }
    offset += line.length;
    if (source.startsWith("\r\n", offset)) offset += 2;
    else if (source[offset] === "\n") offset += 1;
  }
  return indexes;
}

function validateNoUnquotedRoadmapHashScalars(file, source) {
  const blockScalarLineIndexes = yamlBlockScalarLineIndexes(source);
  for (const [lineIndex, line] of source.split(/\r?\n/).entries()) {
    if (blockScalarLineIndexes.has(lineIndex)) continue;
    const match = line.match(/^\s*(?:-\s*)?label:\s*(.*)$/);
    if (!match) continue;
    const rawValue = match[1];
    const trimmedValue = rawValue.trimStart();
    if (
      trimmedValue.length === 0 ||
      trimmedValue.startsWith("\"") ||
      trimmedValue.startsWith("'") ||
      trimmedValue.startsWith(">") ||
      trimmedValue.startsWith("|")
    ) {
      continue;
    }
    let commentHashIndex = -1;
    for (let index = 1; index < rawValue.length; index += 1) {
      if (
        rawValue[index] === "#" &&
        /\s/.test(rawValue[index - 1]) &&
        rawValue.slice(0, index).trim().length > 0
      ) {
        commentHashIndex = index;
        break;
      }
    }
    if (commentHashIndex !== -1) {
      failures.push(
        `${file}: line ${lineIndex + 1} label contains an unquoted # and YAML discards the rest as a comment`,
      );
    }
  }
}

function validateRoadmapEvidencePaths(file, steps) {
  if (!Array.isArray(steps)) return;
  const realRoot = realpathSync(root);
  for (const [stepIndex, step] of steps.entries()) {
    if (!isObject(step) || !Array.isArray(step.evidence_refs)) continue;
    for (const [evidenceIndex, evidence] of step.evidence_refs.entries()) {
      if (!isObject(evidence) || typeof evidence.path !== "string") continue;
      const label = `steps[${stepIndex}].evidence_refs[${evidenceIndex}].path`;
      if (!isSafeRelativePath(evidence.path) || !isContainedRepoPath(evidence.path)) {
        failures.push(`${file}: ${label} must be a portable repo-relative path inside the data repository`);
        continue;
      }
      const evidencePath = resolve(root, evidence.path);
      const normalizedPath = relative(root, evidencePath).split(sep).join("/");
      if (normalizedPath.split("/")[0]?.toLowerCase() === ".git") {
        failures.push(`${file}: ${label} must not point into Git repository metadata`);
        continue;
      }
      if (!existsSync(evidencePath)) {
        failures.push(`${file}: ${label} does not exist: ${evidence.path}`);
        continue;
      }
      if (!lstatSync(evidencePath).isFile()) {
        failures.push(`${file}: ${label} must point to a file: ${evidence.path}`);
        continue;
      }
      const fromRoot = relative(realRoot, realpathSync(evidencePath));
      if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
        failures.push(`${file}: ${label} must stay inside the data repository`);
      } else if (!isGitTrackedPath(normalizedPath)) {
        failures.push(
          `${file}: ${label} must point to a Git-tracked or staged file: ${evidence.path}`,
        );
      }
    }
  }
}

function isPortableRoadmapLinkPath(value) {
  if (!isSafeRelativePath(value) || !isContainedRepoPath(value)) return false;
  const resolvedPath = resolve(root, value);
  const normalizedPath = relative(root, resolvedPath).split(sep).join("/");
  if (normalizedPath.split("/")[0]?.toLowerCase() === ".git") return false;
  const realRoot = realpathSync(root);
  let currentPath = root;
  const segments = normalizedPath.split("/");
  for (const [index, segment] of segments.entries()) {
    currentPath = join(currentPath, segment);
    let stats;
    try {
      stats = lstatSync(currentPath);
    } catch (error) {
      return error?.code === "ENOENT";
    }
    if (stats.isSymbolicLink()) return false;
    if (index < segments.length - 1 && !stats.isDirectory()) return false;
    const fromRoot = relative(realRoot, realpathSync(currentPath));
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      return false;
    }
  }
  return true;
}

function validateRoadmapLinks(file, links) {
  if (!Array.isArray(links)) return;
  for (const [linkIndex, link] of links.entries()) {
    if (!isObject(link)) continue;
    if (
      typeof link.path === "string" &&
      !isPortableRoadmapLinkPath(link.path)
    ) {
      failures.push(
        `${file}: links[${linkIndex}].path must be a portable repo-relative path inside the data repository`,
      );
    }
    if (
      typeof link.url === "string" &&
      !isExternalHttpUrl(link.url)
    ) {
      failures.push(
        `${file}: links[${linkIndex}].url must be a credential-free external http(s) URL`,
      );
    }
  }
}

function validateRoadmapTrimmedStrings(file, roadmap) {
  const validateValue = (value, label) => {
    if (typeof value === "string" && value.trim() === "") {
      failures.push(`${file}: ${label} must contain a non-whitespace character`);
    }
  };
  for (const field of ["title", "owner", "summary"]) {
    validateValue(roadmap[field], field);
  }
  if (isObject(roadmap.agent_lane)) {
    for (const field of ["reviewers", "execution_agents"]) {
      if (!Array.isArray(roadmap.agent_lane[field])) continue;
      roadmap.agent_lane[field].forEach((value, index) =>
        validateValue(value, `agent_lane.${field}[${index}]`),
      );
    }
    validateValue(
      roadmap.agent_lane.escalation_policy,
      "agent_lane.escalation_policy",
    );
  }
  if (Array.isArray(roadmap.priorities)) {
    roadmap.priorities.forEach((priority, index) => {
      if (isObject(priority)) {
        validateValue(priority.title, `priorities[${index}].title`);
      }
    });
  }
  if (Array.isArray(roadmap.steps)) {
    roadmap.steps.forEach((step, stepIndex) => {
      if (!isObject(step)) return;
      validateValue(step.title, `steps[${stepIndex}].title`);
      if (Array.isArray(step.acceptance_criteria)) {
        step.acceptance_criteria.forEach((value, criterionIndex) =>
          validateValue(
            value,
            `steps[${stepIndex}].acceptance_criteria[${criterionIndex}]`,
          ),
        );
      }
      if (Array.isArray(step.evidence_refs)) {
        step.evidence_refs.forEach((evidence, evidenceIndex) => {
          if (isObject(evidence)) {
            validateValue(
              evidence.label,
              `steps[${stepIndex}].evidence_refs[${evidenceIndex}].label`,
            );
          }
        });
      }
    });
  }
  if (Array.isArray(roadmap.links)) {
    roadmap.links.forEach((link, index) => {
      if (isObject(link)) validateValue(link.label, `links[${index}].label`);
    });
  }
}

function validateRoadmap(
  file,
  validateSchema,
  {
    existingPlanCodes,
    existingTaskIds,
    existingIssueIds,
    seenRoadmapCodes,
    seenRoadmapIds,
  },
) {
  const parsed = parseRoadmapYaml(file);
  if (!parsed) return;
  const { roadmap, source } = parsed;
  validateNoUnquotedRoadmapHashScalars(file, source);
  if (validateSchema && !validateSchema(roadmap)) {
    for (const error of validateSchema.errors ?? []) {
      failures.push(
        `${file}: roadmap schema ${error.instancePath || "(root)"} ${error.message ?? "is invalid"}`,
      );
    }
  }
  validateRoadmapTrimmedStrings(file, roadmap);

  const roadmapCode = roadmap.roadmap_code;
  const roadmapId = roadmap.id;
  if (
    typeof roadmapCode === "string" &&
    typeof roadmapId === "string" &&
    roadmapId !== `mcroadmap-${roadmapCode.toLowerCase()}`
  ) {
    failures.push(`${file}: id must equal mcroadmap-${roadmapCode.toLowerCase()} for roadmap_code ${roadmapCode}`);
  }
  if (typeof roadmapCode === "string" && !basename(file).startsWith(`${roadmapCode}-`)) {
    failures.push(`${file}: filename must start with ${roadmapCode}-`);
  }
  for (const [field, value, seen] of [
    ["roadmap_code", roadmapCode, seenRoadmapCodes],
    ["id", roadmapId, seenRoadmapIds],
  ]) {
    if (typeof value !== "string") continue;
    const previous = seen.get(value);
    if (previous) {
      failures.push(`${file}: duplicate ${field} ${value} (also in ${previous})`);
    } else {
      seen.set(value, file);
    }
  }

  if (typeof roadmap.source_plan === "string" && !existingPlanCodes.has(roadmap.source_plan)) {
    failures.push(`${file}: source_plan references missing plan ${roadmap.source_plan}`);
  }
  for (const field of ["created_at", "updated_at"]) {
    if (typeof roadmap[field] === "string" && !isValidCalendarDate(roadmap[field])) {
      failures.push(`${file}: ${field} must be a real YYYY-MM-DD calendar date`);
    }
  }
  validateRoadmapLinks(file, roadmap.links);

  const priorityIds = new Set();
  if (Array.isArray(roadmap.priorities)) {
    for (const [index, priority] of roadmap.priorities.entries()) {
      if (!isObject(priority) || typeof priority.id !== "string") continue;
      if (priorityIds.has(priority.id)) {
        failures.push(`${file}: duplicate priorities[${index}].id ${priority.id}`);
      }
      priorityIds.add(priority.id);
    }
  }

  const stepIds = new Set();
  if (Array.isArray(roadmap.steps)) {
    for (const [index, step] of roadmap.steps.entries()) {
      if (!isObject(step)) continue;
      if (typeof step.id === "string") {
        if (stepIds.has(step.id)) {
          failures.push(`${file}: duplicate steps[${index}].id ${step.id}`);
        }
        stepIds.add(step.id);
      }
      validateRoadmapReferenceList(
        file,
        `steps[${index}].priority_refs`,
        step.priority_refs,
        priorityIds,
        "roadmap priority",
      );
      validateRoadmapReferenceList(
        file,
        `steps[${index}].plan_refs`,
        step.plan_refs,
        existingPlanCodes,
        "plan",
      );
      validateRoadmapReferenceList(
        file,
        `steps[${index}].todo_refs`,
        step.todo_refs,
        existingTaskIds,
        "TODO/DONE item",
      );
      validateRoadmapReferenceList(
        file,
        `steps[${index}].issue_refs`,
        step.issue_refs,
        existingIssueIds,
        "open/resolved issue",
      );
      if (Array.isArray(step.evidence_refs)) {
        for (const [evidenceIndex, evidence] of step.evidence_refs.entries()) {
          if (
            isObject(evidence) &&
            typeof evidence.url === "string" &&
            !isExternalHttpUrl(evidence.url)
          ) {
            failures.push(
              `${file}: steps[${index}].evidence_refs[${evidenceIndex}].url must be a credential-free external http(s) URL`,
            );
          }
        }
      }
    }
  }
  validateRoadmapEvidencePaths(file, roadmap.steps);
}

function isSafeConfiguredDirectory(directory, label) {
  const absolutePath = resolve(root, directory);
  if (!existsSync(absolutePath)) return false;
  const fromLexicalRoot = relative(root, absolutePath);
  let currentPath = root;
  for (const segment of fromLexicalRoot.split(sep)) {
    currentPath = join(currentPath, segment);
    if (lstatSync(currentPath).isSymbolicLink()) {
      failures.push(`${label} must be a real directory inside the data repository`);
      return false;
    }
  }
  const stats = lstatSync(absolutePath);
  const rootRealPath = realpathSync(root);
  const directoryRealPath = realpathSync(absolutePath);
  const fromRoot = relative(rootRealPath, directoryRealPath);
  if (
    stats.isSymbolicLink() ||
    !stats.isDirectory() ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    failures.push(`${label} must be a real directory inside the data repository`);
    return false;
  }
  return true;
}

function isTerminalAuditOperationTarget(path) {
  const normalizedPath = path.toLowerCase();
  const controlPlaneFiles = new Set([
    "repository-db.yaml",
    "data/mission-control/mission-control.config.json",
  ]);
  if (controlPlaneFiles.has(normalizedPath)) return false;
  for (const directory of [
    "data/mission-control/changesets/pending",
    "data/mission-control/changesets/published",
    "data/mission-control/changesets/superseded",
  ]) {
    if (normalizedPath === directory || normalizedPath.startsWith(`${directory}/`)) return false;
  }
  return true;
}

function isConfiguredMissionControlWriteTarget(path) {
  if (!isTerminalAuditOperationTarget(path)) return false;
  const directories = [
    config?.plans_dir,
    config?.roadmaps_dir,
    config?.reports_dir,
    config?.import_reviews_dir,
  ].filter((entry) => typeof entry === "string" && entry.length > 0);
  if (
    directories.some(
      (directory) => path === directory || path.startsWith(`${directory.replace(/\/+$/, "")}/`),
    )
  ) {
    return true;
  }
  return [
    config?.issues_open_path,
    config?.issues_resolved_path,
    config?.todo_tasks_path,
    config?.done_tasks_path,
  ].includes(path);
}

function isHistoricalMissionControlDataTarget(path) {
  const dataLayout = repositoryDbConfig?.layout?.data;
  if (typeof dataLayout !== "string" || dataLayout.length === 0) return false;
  const missionControlDataRoot = `${dataLayout.replace(/\/+$/, "")}/mission-control`;
  return path === missionControlDataRoot || path.startsWith(`${missionControlDataRoot}/`);
}

const pinnedApplicationEvidenceCache = new Map();
const pinnedValidatorPathManifestCache = new Map();
let currentPinnedValidatorCheckout = undefined;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function appCodeBlobAtCommit(commit, path) {
  const entry = trustedGitOutputAt(possibleAppCodeRoot, [
    "ls-tree",
    "--full-tree",
    "-z",
    commit,
    "--",
    path,
  ]);
  const entries = entry.split("\0").filter(Boolean);
  if (entries.length !== 1) return null;
  const match = /^(100644|100755) blob ([0-9a-f]{40}(?:[0-9a-f]{24})?)\t(.+)$/.exec(
    entries[0],
  );
  if (!match || match[3] !== path) return null;
  return {
    mode: match[1],
    object: match[2],
    content: trustedGitOutputAt(possibleAppCodeRoot, [
      "show",
      `${commit}:${path}`,
    ]),
  };
}

function isCanonicalPinnedValidatorPath(value) {
  const prefix = "templates/organization-data/scripts/";
  if (
    typeof value !== "string" ||
    value.length > 240 ||
    !value.startsWith(prefix) ||
    !value.endsWith(".mjs")
  ) {
    return false;
  }
  const relativePath = value.slice(prefix.length);
  return (
    relativePath.length > ".mjs".length &&
    relativePath
      .split("/")
      .every((segment) => /^[a-z0-9][a-z0-9._-]*$/.test(segment))
  );
}

function pinnedValidatorPathsAtCommit(commit, label) {
  if (pinnedValidatorPathManifestCache.has(commit)) {
    return pinnedValidatorPathManifestCache.get(commit);
  }
  const manifestBlob = appCodeBlobAtCommit(
    commit,
    pinnedValidatorPathManifestPath,
  );
  if (manifestBlob === null) {
    throw new Error(
      `${label} does not contain the pinned validator path manifest`,
    );
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestBlob.content);
  } catch (error) {
    throw new Error(
      `${label} pinned validator path manifest is invalid JSON: ${error.message}`,
    );
  }
  const manifestKeys =
    manifest && typeof manifest === "object" && !Array.isArray(manifest)
      ? Object.keys(manifest).sort()
      : [];
  if (
    manifestKeys.length !== 2 ||
    manifestKeys[0] !== "schema_version" ||
    manifestKeys[1] !== "trusted_validator_paths" ||
    manifest.schema_version !== pinnedValidatorPathManifestSchema ||
    !Array.isArray(manifest.trusted_validator_paths) ||
    manifest.trusted_validator_paths.length === 0 ||
    manifest.trusted_validator_paths.length > 16 ||
    manifest.trusted_validator_paths.some(
      (path) => !isCanonicalPinnedValidatorPath(path),
    ) ||
    new Set(manifest.trusted_validator_paths).size !==
      manifest.trusted_validator_paths.length
  ) {
    throw new Error(
      `${label} pinned validator path manifest violates its exact contract`,
    );
  }
  const trustedPaths = new Set(manifest.trusted_validator_paths);
  pinnedValidatorPathManifestCache.set(commit, trustedPaths);
  return trustedPaths;
}

function inspectCurrentPinnedValidatorCheckout() {
  if (currentPinnedValidatorCheckout !== undefined) {
    return currentPinnedValidatorCheckout;
  }
  if (!pinnedAppCodeRequested || !isBundledAppCodeValidator) {
    currentPinnedValidatorCheckout = {
      ok: false,
      reason:
        "authenticated audit requires the bundled --pinned-app-code validator",
    };
    return currentPinnedValidatorCheckout;
  }
  try {
    const repositoryRoot = trustedGitOutputAt(possibleAppCodeRoot, [
      "rev-parse",
      "--show-toplevel",
    ]).trim();
    if (!sameRealPath(repositoryRoot, possibleAppCodeRoot)) {
      throw new Error("validator is not inside the exact app-code repository root");
    }
    assertNoGitHistoryReplacementMetadataAt(
      possibleAppCodeRoot,
      "app-code Git replacement refs or grafts are present; pinned application evidence requires the canonical commit graph",
    );
    if (
      trustedGitOutputAt(possibleAppCodeRoot, [
        "rev-parse",
        "--is-shallow-repository",
      ]).trim() === "true"
    ) {
      throw new Error(
        "pinned app-code history requires a non-shallow repository",
      );
    }
    const head = trustedGitOutputAt(possibleAppCodeRoot, [
      "rev-parse",
      "--verify",
      "HEAD",
    ]).trim();
    const validatorPath = relative(
      possibleAppCodeRoot,
      fileURLToPath(import.meta.url),
    )
      .split(sep)
      .join("/");
    const committed = appCodeBlobAtCommit(head, validatorPath);
    if (committed === null) {
      throw new Error("current validator is not one canonical app-code blob");
    }
    const currentDigest = sha256(
      readFileSync(fileURLToPath(import.meta.url)),
    );
    const committedDigest = sha256(committed.content);
    if (currentDigest !== committedDigest) {
      throw new Error(
        "current validator digest does not match the pinned app-code HEAD blob",
      );
    }
    const trustedPaths = pinnedValidatorPathsAtCommit(
      head,
      "current app-code HEAD",
    );
    if (!trustedPaths.has(validatorPath)) {
      throw new Error(
        "current validator path is not trusted by the app-code HEAD manifest",
      );
    }
    const firstParentCommits = new Set(
      trustedGitOutputAt(possibleAppCodeRoot, [
        "rev-list",
        "--first-parent",
        head,
      ])
        .trim()
        .split(/\r?\n/),
    );
    const firstParentCommitIndexes = new Map(
      [...firstParentCommits].map((commit, index) => [commit, index]),
    );
    const manifestIntroductionCommits = trustedGitOutputAt(
      possibleAppCodeRoot,
      [
        "log",
        "--format=%H",
        "--first-parent",
        "--diff-filter=A",
        head,
        "--",
        pinnedValidatorPathManifestPath,
      ],
    )
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
    if (manifestIntroductionCommits.length !== 1) {
      throw new Error(
        "pinned validator path manifest must have one continuous first-parent introduction",
      );
    }
    const manifestIntroductionIndex = firstParentCommitIndexes.get(
      manifestIntroductionCommits[0],
    );
    if (manifestIntroductionIndex === undefined) {
      throw new Error(
        "pinned validator path manifest introduction is outside first-parent history",
      );
    }
    currentPinnedValidatorCheckout = {
      ok: true,
      head,
      validatorPath,
      currentDigest,
      firstParentCommitIndexes,
      manifestIntroductionIndex,
    };
  } catch (error) {
    currentPinnedValidatorCheckout = {
      ok: false,
      reason: error.message,
    };
  }
  return currentPinnedValidatorCheckout;
}

function validatePinnedApplicationEvidence(application, label) {
  const current = inspectCurrentPinnedValidatorCheckout();
  if (!current.ok) {
    failures.push(`${label}: application pinned app-code verification failed: ${current.reason}`);
    return false;
  }
  const expectedDataRepository = repositoryIdFromMissionControlRemote(
    repositoryDbConfig?.data_repo?.remote,
  );
  const expectedOwner = expectedDataRepository?.split("/")[0] ?? null;
  const expectedApplicationRepository = expectedOwner
    ? `${expectedOwner}/mission-control`
    : null;
  if (application.repository !== expectedApplicationRepository) {
    failures.push(
      `${label}: application.repository must match pinned app-code repository ${expectedApplicationRepository ?? "<unavailable>"}`,
    );
    return false;
  }
  const cacheKey = JSON.stringify(application);
  if (pinnedApplicationEvidenceCache.has(cacheKey)) {
    const cached = pinnedApplicationEvidenceCache.get(cacheKey);
    if (!cached.ok) failures.push(`${label}: ${cached.reason}`);
    return cached.ok;
  }
  try {
    const applicationObjectType = trustedGitOutputAt(possibleAppCodeRoot, [
      "cat-file",
      "-t",
      application.commit,
    ]).trim();
    if (applicationObjectType !== "commit") {
      throw new Error(
        "application.commit must identify an exact commit object",
      );
    }
    trustedGitOutputAt(possibleAppCodeRoot, [
      "merge-base",
      "--is-ancestor",
      application.commit,
      current.head,
    ]);
    const applicationHistoryIndex = current.firstParentCommitIndexes.get(
      application.commit,
    );
    if (applicationHistoryIndex === undefined) {
      throw new Error(
        "application.commit must belong to the trusted pinned app-code first-parent history",
      );
    }
    const historicalManifest = appCodeBlobAtCommit(
      application.commit,
      pinnedValidatorPathManifestPath,
    );
    if (historicalManifest === null) {
      if (applicationHistoryIndex <= current.manifestIntroductionIndex) {
        throw new Error(
          "application.commit is missing the pinned validator path manifest after its introduction",
        );
      }
      if (
        application.validator_path !== legacyPreManifestPinnedValidatorPath
      ) {
        throw new Error(
          "application.validator_path is not covered by the reviewed pre-manifest compatibility authority",
        );
      }
    } else {
      const trustedPaths = pinnedValidatorPathsAtCommit(
        application.commit,
        "application.commit",
      );
      if (!trustedPaths.has(application.validator_path)) {
        throw new Error(
          "application.validator_path is not trusted by its recorded app-code commit",
        );
      }
    }
    const tree = trustedGitOutputAt(possibleAppCodeRoot, [
      "rev-parse",
      "--verify",
      `${application.commit}^{tree}`,
    ]).trim();
    if (tree !== application.control_plane_tree_sha) {
      throw new Error(
        "application.control_plane_tree_sha does not match the pinned app-code commit root tree",
      );
    }
    const validator = appCodeBlobAtCommit(
      application.commit,
      application.validator_path,
    );
    if (validator === null) {
      throw new Error(
        "application.commit does not contain the pinned app-code validator blob",
      );
    }
    if (sha256(validator.content) !== application.validator_digest_sha256) {
      throw new Error(
        "application.validator_digest_sha256 does not match the pinned app-code validator blob",
      );
    }
    pinnedApplicationEvidenceCache.set(cacheKey, { ok: true });
    return true;
  } catch (error) {
    const reason = error.message.includes("application.")
      ? error.message
      : `application.commit is not a trusted pinned app-code ancestor: ${error.message}`;
    pinnedApplicationEvidenceCache.set(cacheKey, { ok: false, reason });
    failures.push(`${label}: ${reason}`);
    return false;
  }
}

function validateWriterAuditEvidence(
  evidence,
  label,
  { actor, role = null, allowedRoles = null, eventAt, operationPaths },
) {
  if (!validateWriterAuditSchema) {
    failures.push(`${label}: writer audit schema is unavailable`);
    return false;
  }
  if (!validateWriterAuditSchema(evidence)) {
    for (const error of validateWriterAuditSchema.errors ?? []) {
      failures.push(
        `${label}: writer audit schema ${error.instancePath || "(root)"} ${error.message ?? "is invalid"}`,
      );
    }
    return false;
  }

  const applicationEvidenceIsValid = validatePinnedApplicationEvidence(
    evidence.application,
    label,
  );
  const authorization = evidence.authorization_source;
  const principal = evidence.principal;
  const scope = evidence.scope;
  const credential = evidence.credential;
  const roster = authorization.roster;
  for (const [field, principalId] of [
    ["principal.id", principal.id],
    ["credential.custodian", credential.custodian],
    ["authorization_source.approved_by", authorization.approved_by],
  ]) {
    if (!roster.includes(principalId)) {
      failures.push(`${label}: ${field} must belong to authorization_source.roster`);
    }
  }
  if (principal.id !== actor) {
    failures.push(`${label}: principal.id must equal lifecycle actor ${actor}`);
  }
  if (role !== null && principal.role !== role) {
    failures.push(`${label}: principal.role must equal lifecycle role ${role}`);
  }
  if (allowedRoles && !allowedRoles.includes(principal.role)) {
    failures.push(
      `${label}: principal.role must be one of ${allowedRoles.join(", ")}`,
    );
  }

  const approvedAt = parseIsoDateTimeNanoseconds(authorization.approved_at);
  const notBefore = parseIsoDateTimeNanoseconds(
    authorization.authorization_not_before,
  );
  const expiresAt = parseIsoDateTimeNanoseconds(authorization.expires_at);
  const stagedAt = parseIsoDateTimeNanoseconds(credential.staged_at);
  const stagingDeadline = parseIsoDateTimeNanoseconds(
    credential.staging_deadline,
  );
  const transactionCapturedAt = parseIsoDateTimeNanoseconds(
    evidence.transaction.captured_at,
  );
  const lifecycleAt = parseIsoDateTimeNanoseconds(eventAt);
  if (
    approvedAt === null ||
    notBefore === null ||
    expiresAt === null ||
    approvedAt > notBefore ||
    notBefore >= expiresAt
  ) {
    failures.push(
      `${label}: approved_at <= authorization_not_before < expires_at is required`,
    );
  }
  if (
    stagedAt === null ||
    stagingDeadline === null ||
    stagedAt >= stagingDeadline ||
    (notBefore !== null && notBefore >= stagingDeadline)
  ) {
    failures.push(
      `${label}: staged_at and authorization_not_before must precede staging_deadline`,
    );
  }
  if (
    lifecycleAt === null ||
    notBefore === null ||
    expiresAt === null ||
    lifecycleAt < notBefore ||
    lifecycleAt >= expiresAt
  ) {
    failures.push(
      `${label}: lifecycle timestamp must stay inside the authorization window`,
    );
  }
  if (
    transactionCapturedAt === null ||
    notBefore === null ||
    expiresAt === null ||
    transactionCapturedAt < notBefore ||
    transactionCapturedAt >= expiresAt ||
    (lifecycleAt !== null && transactionCapturedAt > lifecycleAt)
  ) {
    failures.push(
      `${label}: transaction capture must stay inside the authorization window and not follow the lifecycle event`,
    );
  }

  if (scope.data_branch !== repositoryDbConfig?.data_repo?.branch) {
    failures.push(
      `${label}: scope.data_branch must match repository-db.yaml data_repo.branch`,
    );
  }
  const configuredRepository = repositoryIdFromMissionControlRemote(
    repositoryDbConfig?.data_repo?.remote,
  );
  if (!configuredRepository) {
    failures.push(
      `${label}: repository-db.yaml data_repo.remote cannot be bound to a repository identity`,
    );
  } else if (scope.data_repository !== configuredRepository) {
    failures.push(
      `${label}: scope.data_repository must match repository-db.yaml data_repo.remote (${configuredRepository})`,
    );
  }
  if (
    !config?.publish_policy?.credential_authority?.allowed_writer_ids?.includes(
      scope.writer_id,
    )
  ) {
    failures.push(
      `${label}: scope.writer_id must be allowed by credential authority policy`,
    );
  }
  if (!["admin", "steward"].includes(credential.custody_role)) {
    failures.push(`${label}: credential custody must be admin or steward`);
  }
  const policyPaths =
    config?.publish_policy?.credential_authority?.path_allowlist ?? [];
  for (const pattern of scope.path_allowlist) {
    if (
      !policyPaths.some((policyPattern) =>
        policyPatternContains(policyPattern, pattern),
      )
    ) {
      failures.push(
        `${label}: scope.path_allowlist exceeds credential authority policy at ${pattern}`,
      );
    }
    const base = policyPatternBase(pattern);
    if (!base || !isHistoricalMissionControlDataTarget(base)) {
      failures.push(
        `${label}: scope.path_allowlist must stay inside Mission Control data`,
      );
    }
  }
  for (const operationPath of operationPaths) {
    if (
      !scope.path_allowlist.some((pattern) =>
        policyPatternContains(pattern, operationPath),
      )
    ) {
      failures.push(
        `${label}: scope.path_allowlist does not cover operation ${operationPath}`,
      );
    }
  }
  return applicationEvidenceIsValid;
}

const writerLifecyclePhaseOrder = new Map([
  ["creation", 0],
  ["approval", 1],
  ["publication", 2],
  ["supersession", 2],
]);

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function jsonDigest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function immutableChangesetPayload(value) {
  return {
    schema_version: value.schema_version,
    id: value.id,
    summary: value.summary,
    created_at: value.created_at,
    created_by: value.created_by,
    operations: value.operations,
  };
}

function writerLifecyclePhases(value) {
  return [
    {
      name: "creation",
      occurred: true,
      evidence: value.creation_authorization,
      eventAt: value.created_at,
    },
    {
      name: "approval",
      occurred: value.approval !== undefined,
      evidence: value.approval?.runtime_authorization,
      eventAt: value.approval?.approved_at,
    },
    {
      name: "publication",
      occurred: value.status === "published",
      evidence: value.runtime_authorization,
      eventAt: value.published_at,
    },
    {
      name: "supersession",
      occurred: value.status === "superseded",
      evidence: value.supersession?.runtime_authorization,
      eventAt: value.supersession?.superseded_at,
    },
  ];
}

function provenanceIdentity(value) {
  if (!isObject(value)) return null;
  return JSON.stringify([
    value.schema_version,
    value.mode,
    value.changeset_id,
    value.first_authenticated_phase,
    value.authorization_id,
    value.authorization_source_commit,
    value.authorization_source_blob,
    value.first_authorization_digest_sha256,
    value.changeset_payload_digest_sha256,
    value.recorded_at,
  ]);
}

function validateWriterAuditProvenance(value, file) {
  const provenance = value.writer_audit_provenance;
  const hasEvidence = changesetHasWriterAuditEvidence(value);
  if (provenance === undefined) {
    if (hasEvidence) {
      failures.push(
        `${file}: authenticated lifecycle evidence requires immutable writer_audit_provenance`,
      );
    }
    return;
  }
  if (!validateWriterProvenanceSchema) {
    failures.push(`${file}: writer provenance schema is unavailable`);
    return;
  }
  if (!validateWriterProvenanceSchema(provenance)) {
    for (const error of validateWriterProvenanceSchema.errors ?? []) {
      failures.push(
        `${file}: writer_audit_provenance schema ${error.instancePath || "(root)"} ${error.message ?? "is invalid"}`,
      );
    }
    return;
  }
  if (provenance.changeset_id !== value.id) {
    failures.push(
      `${file}: writer_audit_provenance.changeset_id must equal changeset id ${value.id}`,
    );
  }

  const phases = writerLifecyclePhases(value);
  const firstPhase = phases.find(
    (phase) => phase.name === provenance.first_authenticated_phase,
  );
  if (!firstPhase?.occurred) {
    failures.push(
      `${file}: writer_audit_provenance.first_authenticated_phase must be present in the changeset lifecycle`,
    );
    return;
  }
  const firstPhaseOrder = writerLifecyclePhaseOrder.get(firstPhase.name);
  for (const phase of phases.filter((candidate) => candidate.occurred)) {
    const phaseOrder = writerLifecyclePhaseOrder.get(phase.name);
    const requiresEvidence =
      provenance.mode === "authenticated" || phaseOrder >= firstPhaseOrder;
    if (requiresEvidence && phase.evidence === undefined) {
      failures.push(
        `${file}: authenticated lifecycle from ${firstPhase.name} requires ${phase.name} runtime authorization`,
      );
    } else if (!requiresEvidence && phase.evidence !== undefined) {
      failures.push(
        `${file}: writer_audit_provenance cannot label existing ${phase.name} evidence as pre-authenticated legacy history`,
      );
    }
  }

  const firstEvidence = firstPhase.evidence;
  if (firstEvidence !== undefined) {
    for (const [field, actual, expected, source] of [
      [
        "authorization_id",
        provenance.authorization_id,
        firstEvidence.authorization_id,
        `first authenticated ${firstPhase.name} evidence`,
      ],
      [
        "authorization_source_commit",
        provenance.authorization_source_commit,
        firstEvidence.authorization_source?.commit,
        `first authenticated ${firstPhase.name} evidence`,
      ],
      [
        "authorization_source_blob",
        provenance.authorization_source_blob,
        firstEvidence.authorization_source?.blob,
        `first authenticated ${firstPhase.name} evidence`,
      ],
      [
        "first_authorization_digest_sha256",
        provenance.first_authorization_digest_sha256,
        jsonDigest(firstEvidence),
        `first authenticated ${firstPhase.name} evidence`,
      ],
      [
        "changeset_payload_digest_sha256",
        provenance.changeset_payload_digest_sha256,
        jsonDigest(immutableChangesetPayload(value)),
        "immutable changeset payload",
      ],
      [
        "recorded_at",
        provenance.recorded_at,
        firstPhase.eventAt,
        `first authenticated ${firstPhase.name} evidence`,
      ],
    ]) {
      if (actual !== expected) {
        failures.push(
          `${file}: writer_audit_provenance.${field} must equal ${source}`,
        );
      }
    }
  }

  if (provenance.mode === "legacy-transition") {
    const quarantineEntry =
      configuredLegacyChangesetQuarantine.get(value.id);
    const isExactSupersedeMigration =
      quarantineEntry?.terminal_action === "supersede" &&
      quarantineEntry?.immutable_payload_digest_sha256 ===
        provenance.changeset_payload_digest_sha256;
    const isExactAuthenticatedGrandfather =
      quarantineEntry?.terminal_action ===
        "grandfather-authenticated" &&
      quarantineEntry?.immutable_payload_digest_sha256 ===
        provenance.changeset_payload_digest_sha256 &&
      value.status === quarantineEntry?.authenticated_status &&
      jsonDigest(value) === quarantineEntry?.record_digest_sha256 &&
      quarantineEntry?.provenance_digest_sha256 ===
        jsonDigest(provenance);
    if (
      !isExactSupersedeMigration &&
      !isExactAuthenticatedGrandfather
    ) {
      failures.push(
        `${file}: legacy-transition requires an exact supersede or grandfather-authenticated publish_policy.legacy_changeset_quarantine entry`,
      );
    }
    const provenLegacyRecord =
      quarantineEntry !== undefined &&
      quarantineHasExactPredecessorRecord(quarantineEntry, value) &&
      grandfatherIntroductionFreezesAuthenticatedRecord(
        quarantineEntry,
      ) &&
      grandfatherHasOriginalLegacyHistory(quarantineEntry);
    if (!historicalChangesets.available || !provenLegacyRecord) {
      failures.push(
        `${file}: legacy-transition provenance requires the same legacy changeset in trusted Git history strictly before its quarantine entry`,
      );
    }
  }
}

function terminalAdminApprovalHasHistoricalApprovedState(value) {
  if (
    !["published", "superseded"].includes(value.status) ||
    !isObject(value.approval) ||
    historicalChangesets.head === null
  ) {
    return false;
  }
  try {
    return (historicalChangesets.recordsById.get(value.id) ?? []).some(
      ({ reference, value: historicalValue }) =>
        historicalValue.status === "approved" &&
        canonicalJson(historicalValue.approval) ===
          canonicalJson(value.approval) &&
        (reference === historicalChangesets.head ||
          isStrictGitAncestor(reference, historicalChangesets.head)),
    );
  } catch (error) {
    failures.push(
      `terminal admin approval history inspection failed for ${value.id}: ${error.message}`,
    );
    return false;
  }
}

function hasGrandfatheredPreManifestSupersessionScope(value) {
  const entry = configuredLegacyChangesetQuarantine.get(value?.id);
  const committedEntry = committedPersistentQuarantineEntries.get(
    value?.id,
  );
  if (
    entry?.terminal_action !== "grandfather-supersession-scope" ||
    committedEntry === undefined ||
    canonicalJson(entry) !== canonicalJson(committedEntry) ||
    !historicalRecordMatchesQuarantine(value, entry) ||
    !persistentQuarantineHistoryIsContinuous(entry)
  ) {
    return false;
  }
  const application = value?.supersession?.runtime_authorization?.application;
  if (!isObject(application)) return false;
  const current = inspectCurrentPinnedValidatorCheckout();
  if (!current.ok) return false;
  const applicationHistoryIndex = current.firstParentCommitIndexes.get(
    application.commit,
  );
  if (
    applicationHistoryIndex === undefined ||
    applicationHistoryIndex <= current.manifestIntroductionIndex ||
    application.validator_path !== legacyPreManifestPinnedValidatorPath
  ) {
    return false;
  }
  try {
    if (
      appCodeBlobAtCommit(
        application.commit,
        pinnedValidatorPathManifestPath,
      ) !== null
    ) {
      return false;
    }
  } catch {
    return false;
  }
  return true;
}

function normalizedProviderAuditInstant(value) {
  return parseIsoDateTimeNanoseconds(value) === null
    ? null
    : new Date(value).toISOString();
}

function localPrincipalControlPlaneMatches(
  configValue,
  repositoryConfigValue,
  localPublish,
) {
  const policy = configValue?.publish_policy;
  const roles = policy?.approval_roles;
  const audit = policy?.local_principal?.provider_access_audit;
  const remote = repositoryConfigValue?.data_repo?.remote;
  const branch = repositoryConfigValue?.data_repo?.branch;
  const githubRemote =
    remoteUsesGitHubSsh(remote) ||
    remoteUsesGitHubHttps(remote) ||
    (allowUnauthenticatedLocalTest &&
      (sshRemoteHost(remote) === "localhost" ||
        httpsRemoteHost(remote) === "localhost"));
  return (
    policy?.writer_mode === "local-principal-v1" &&
    approvalRolesMatchRosterScope(roles, audit?.roster_scope) &&
    policy.credential_authority === undefined &&
    audit?.status === "confirmed" &&
    audit.repository === remote &&
    audit.branch === branch &&
    githubRemote &&
    normalizedProviderAuditInstant(audit.checked_at) !== null &&
    normalizedProviderAuditInstant(audit.checked_at) ===
      normalizedProviderAuditInstant(
        localPublish?.provider_access_audit?.checked_at,
      ) &&
    typeof audit.checked_by === "string" &&
    audit.checked_by.trim() !== "" &&
    audit.checked_by.trim() ===
      localPublish?.provider_access_audit?.checked_by
  );
}

function localPrincipalControlPlaneAtReferenceMatches(
  reference,
  localPublish,
) {
  try {
    const historicalConfig = JSON.parse(
      trustedGitOutput([
        "show",
        `${reference}:${missionControlConfigFile}`,
      ]),
    );
    const historicalRepositoryConfig = parseYaml(
      trustedGitOutput(["show", `${reference}:repository-db.yaml`]),
    );
    return localPrincipalControlPlaneMatches(
      historicalConfig,
      historicalRepositoryConfig,
      localPublish,
    );
  } catch {
    return false;
  }
}

function exactChangedPathsBetween(parent, reference) {
  return [
    ...new Set(
      trustedGitOutput([
        "diff",
        "--name-only",
        "--no-renames",
        "-z",
        parent,
        reference,
        "--",
      ])
        .split("\0")
        .filter(Boolean),
    ),
  ].sort();
}

function localPublishOperationContentsMatchReference(
  value,
  reference,
) {
  try {
    return value.operations.every(
      (operation) =>
        typeof operation?.path === "string" &&
        typeof operation?.content === "string" &&
        trustedGitOutput([
          "show",
          `${reference}:${operation.path}`,
        ]) === operation.content,
    );
  } catch {
    return false;
  }
}

function localPublishIntroductionEvidenceIsValid(
  value,
  file,
  operationPaths,
) {
  try {
    const introductions = allChangesetIntroductions(value.id);
    if (introductions.length !== 1) return false;
    const [introduction] = introductions;
    const parents = revisionParents(introduction);
    if (
      parents.length !== 1 ||
      parents[0] !== value.local_publish.base_commit ||
      !localPrincipalControlPlaneAtReferenceMatches(
        parents[0],
        value.local_publish,
      )
    ) {
      return false;
    }
    const record = changesetAtReference(introduction, value.id);
    if (
      record === null ||
      record.path !== file ||
      canonicalJson(record.value) !== canonicalJson(value)
    ) {
      return false;
    }
    const expectedPaths = [...new Set([...operationPaths, file])].sort();
    return (
      canonicalJson(
        exactChangedPathsBetween(parents[0], introduction),
      ) === canonicalJson(expectedPaths) &&
      localPublishOperationContentsMatchReference(
        value,
        introduction,
      )
    );
  } catch {
    return false;
  }
}

function stagedLocalPublishEvidenceIsValid(
  value,
  file,
  operationPaths,
) {
  try {
    if (
      historicalChangesets.head === null ||
      historicalChangesets.head !== value.local_publish.base_commit ||
      !localPrincipalControlPlaneMatches(
        config,
        repositoryDbConfig,
        value.local_publish,
      )
    ) {
      return false;
    }
    const stagedPaths = [
      ...new Set(
        trustedGitOutput([
          "diff",
          "--cached",
          "--name-only",
          "--no-renames",
          "-z",
          historicalChangesets.head,
          "--",
        ])
          .split("\0")
          .filter(Boolean),
      ),
    ].sort();
    const expectedPaths = [...new Set([...operationPaths, file])].sort();
    if (canonicalJson(stagedPaths) !== canonicalJson(expectedPaths)) {
      return false;
    }
    const stagedRecord = JSON.parse(
      trustedGitOutput(["show", `:${file}`]),
    );
    return (
      canonicalJson(stagedRecord) === canonicalJson(value) &&
      localPublishOperationContentsMatchReference(value, "")
    );
  } catch {
    return false;
  }
}

function localPrincipalPublishEvidenceIsValid(
  value,
  file,
  operationPaths,
) {
  const introductions = allChangesetIntroductions(value.id);
  if (introductions.length > 0) {
    return localPublishIntroductionEvidenceIsValid(
      value,
      file,
      operationPaths,
    );
  }
  return stagedLocalPublishEvidenceIsValid(
    value,
    file,
    operationPaths,
  );
}

function validateChangeset(file, expectedStatuses, seenIds) {
  const allowedStatuses = Array.isArray(expectedStatuses) ? expectedStatuses : [expectedStatuses];
  const value = parseJson(file);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    failures.push(`${file}: changeset must be a JSON object`);
    return null;
  }
  const filenameId = basename(file, ".json");
  if (typeof value.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(value.id)) {
    failures.push(`${file}: id must use lowercase letters, numbers and hyphens only`);
  } else {
    if (value.id !== filenameId) {
      failures.push(`${file}: id must equal filename basename ${filenameId}`);
    }
    const previous = seenIds.get(value.id);
    if (previous) {
      failures.push(`${file}: duplicate changeset id ${value.id} (also in ${previous})`);
    } else {
      seenIds.set(value.id, file);
    }
  }
  if (value.schema_version !== "companiesascode.mission_control.changeset.v1") {
    failures.push(`${file}: schema_version must be companiesascode.mission_control.changeset.v1`);
  }
  if (!allowedStatuses.includes(value.status)) failures.push(`${file}: status must be one of ${allowedStatuses.join(", ")}`);
  const createdAt = parseIsoDateTimeNanoseconds(value.created_at);
  if (createdAt === null) {
    failures.push(`${file}: created_at must be an ISO date-time`);
  }
  if (typeof value.created_by !== "string" || value.created_by.trim() === "") {
    failures.push(`${file}: created_by must be a non-empty string`);
  }
  const hasWriterAudit =
    changesetHasWriterAuditEvidence(value) ||
    value.writer_audit_provenance !== undefined;
  const isLocalPrincipalPublish =
    value.local_publish?.schema_version ===
      "companiesascode.mission_control.local_publish.v1" &&
    value.local_publish?.writer_mode === "local-principal-v1";
  const immutablePayloadDigest = jsonDigest(immutableChangesetPayload(value));
  const recordDigest = jsonDigest(value);
  const quarantineEntry =
    typeof value.id === "string"
      ? configuredLegacyChangesetQuarantine.get(value.id)
      : undefined;
  const isExactLegacyPayload =
    quarantineEntry?.immutable_payload_digest_sha256 ===
    immutablePayloadDigest;
  const isExactSupersedeLegacy =
    isExactLegacyPayload &&
    quarantineEntry?.terminal_action === "supersede";
  const isExactRetainedLegacyTerminal =
    isExactLegacyPayload &&
    quarantineEntry?.terminal_action === "retain" &&
    value.status === quarantineEntry.terminal_status &&
    recordDigest === quarantineEntry.record_digest_sha256 &&
    !hasWriterAudit;
  const isExactAuthenticatedGrandfather =
    isExactLegacyPayload &&
    quarantineEntry?.terminal_action ===
      "grandfather-authenticated" &&
    value.writer_audit_provenance?.mode === "legacy-transition" &&
    hasWriterAudit &&
    value.status === quarantineEntry.authenticated_status &&
    recordDigest === quarantineEntry.record_digest_sha256 &&
    jsonDigest(value.writer_audit_provenance) ===
      quarantineEntry.provenance_digest_sha256;
  const isAuthenticatedLegacySupersession =
    isExactSupersedeLegacy &&
    value.status === "superseded" &&
    value.writer_audit_provenance?.mode === "legacy-transition";
  const isExactLegacyQuarantine =
    isExactSupersedeLegacy ||
    isExactRetainedLegacyTerminal ||
    isExactAuthenticatedGrandfather;
  if (quarantineEntry && !isExactLegacyPayload) {
    failures.push(
      `${file}: immutable payload does not match publish_policy.legacy_changeset_quarantine for ${value.id}`,
    );
  }
  if (
    isExactLegacyPayload &&
    quarantineEntry.terminal_action === "retain" &&
    !isExactRetainedLegacyTerminal
  ) {
    failures.push(
      `${file}: retained legacy changeset ${value.id} must remain the exact frozen unauthenticated ${quarantineEntry.terminal_status} record`,
    );
  }
  if (
    isExactSupersedeLegacy &&
    ["pending", "approved"].includes(value.status) &&
    !hasWriterAudit &&
    !activeQuarantinedRecordMatchesPredecessor(value, quarantineEntry)
  ) {
    failures.push(
      `${file}: active quarantined legacy changeset ${value.id} must remain record-equivalent to its immediate pre-quarantine Git snapshot until authenticated supersession`,
    );
  }
  if (
    isAuthenticatedLegacySupersession &&
    !quarantinePredatesAuthenticatedTransition(value, quarantineEntry)
  ) {
    failures.push(
      `${file}: authenticated legacy supersession requires its committed quarantine introduction to strictly predate the transition`,
    );
  }
  const operationPaths = [];
  if (!Array.isArray(value.operations) || value.operations.length === 0) {
    failures.push(`${file}: operations must be a non-empty array`);
  } else if (
    !isExactRetainedLegacyTerminal &&
    !isExactAuthenticatedGrandfather &&
    !isAuthenticatedLegacySupersession &&
    (value.status !== "superseded" || hasWriterAudit)
  ) {
    for (const [index, operation] of value.operations.entries()) {
      if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
        failures.push(`${file}: operations[${index}] must be an object`);
        continue;
      }
      if (operation.action !== "write_file") {
        failures.push(`${file}: operations[${index}].action must be write_file`);
      }
      if (!isSafeRelativePath(operation.path) || !isContainedRepoPath(operation.path)) {
        failures.push(
          `${file}: operations[${index}].path must be a portable path inside the repository`,
        );
      } else {
        const operationPath = relative(root, resolve(root, operation.path)).split(sep).join("/");
        operationPaths.push(operationPath);
        if (
          !isTerminalAuditOperationTarget(operationPath) ||
          (["published", "superseded"].includes(value.status) &&
            !isHistoricalMissionControlDataTarget(operationPath)) ||
          (!["published", "superseded"].includes(value.status) &&
            !isConfiguredMissionControlWriteTarget(operationPath))
        ) {
          failures.push(
            `${file}: operations[${index}].path is not an allowed Mission Control data path`,
          );
        }
        if (
          !["published", "superseded"].includes(value.status) &&
          !configuredProtectedPaths.some((pattern) =>
            policyPatternContains(pattern, operationPath),
          )
        ) {
          failures.push(
            `${file}: operations[${index}].path is not covered by publish_policy.protected_paths`,
          );
        }
      }
      if (typeof operation.content !== "string") {
        failures.push(`${file}: operations[${index}].content must be a string`);
      }
    }
  }
  if (isExactSupersedeLegacy && value.status === "published") {
    failures.push(
      `${file}: quarantined legacy changeset ${value.id} may only be superseded, never published`,
    );
  }
  if (
    isExactSupersedeLegacy &&
    value.status !== "superseded" &&
    (value.writer_audit_provenance !== undefined ||
      changesetHasWriterAuditEvidence(value))
  ) {
    failures.push(
      `${file}: quarantined legacy changeset ${value.id} may only enter an authenticated superseded state`,
    );
  }
  if (
    isExactSupersedeLegacy &&
    value.status === "superseded" &&
    value.writer_audit_provenance?.mode !== "legacy-transition"
  ) {
    failures.push(
      `${file}: quarantined legacy changeset supersession requires authenticated legacy-transition provenance`,
    );
  }
  const localPrincipalEvidenceValid =
    isLocalPrincipalPublish &&
    localPrincipalPublishEvidenceIsValid(
      value,
      file,
      operationPaths,
    );
  if (isLocalPrincipalPublish && !localPrincipalEvidenceValid) {
    failures.push(
      `${file}: local Principal evidence requires a confirmed local-principal-v1 control plane and an exact staged or introducing commit whose parent, diff and contents match the approved draft`,
    );
  }
  if (
    value.creation_authorization === undefined &&
    !allowUnauthenticatedLocalTest &&
    !localPrincipalEvidenceValid
  ) {
    if (value.writer_audit_provenance?.mode === "legacy-transition") {
      if (
        !isExactSupersedeLegacy &&
        !isExactAuthenticatedGrandfather
      ) {
        failures.push(
          `${file}: legacy-transition is allowed only for an exact supersede or grandfather-authenticated publish_policy.legacy_changeset_quarantine entry`,
        );
      }
    } else if (!isExactLegacyQuarantine) {
      failures.push(
        `${file}: changeset creation requires authenticated creation_authorization; legacy records require an exact history-backed quarantine entry`,
      );
    }
  }
  if (value.creation_authorization !== undefined) {
    validateWriterAuditEvidence(
      value.creation_authorization,
      `${file}: creation_authorization`,
      {
        actor: value.created_by,
        eventAt: value.created_at,
        operationPaths,
      },
    );
  }
  if (["approved", "published"].includes(value.status) && !value.approval) {
    failures.push(`${file}: ${value.status} changeset requires approval metadata`);
  }
  if (value.status === "pending" && value.approval !== undefined) {
    failures.push(`${file}: pending changeset must not contain approval metadata`);
  }
  let approvedAt = null;
  if (value.approval !== undefined) {
    const approval = value.approval;
    if (!approval || typeof approval !== "object" || Array.isArray(approval)) {
      failures.push(`${file}: approval must be an object`);
    } else {
      const parsedApprovedAt = parseIsoDateTimeNanoseconds(approval.approved_at);
      if (parsedApprovedAt === null) {
        failures.push(`${file}: approval.approved_at must be an ISO date-time`);
      } else {
        approvedAt = parsedApprovedAt;
        if (createdAt !== null && approvedAt < createdAt) {
          failures.push(`${file}: approval.approved_at must not precede created_at`);
        }
      }
      if (typeof approval.approved_by !== "string" || approval.approved_by.trim() === "") {
        failures.push(`${file}: approval.approved_by must be a non-empty string`);
      }
      const stableApprovalRoles = isLocalPrincipalPublish
        ? ["provider-authorized"]
        : ["admin", "steward"];
      if (!stableApprovalRoles.includes(approval.role)) {
        failures.push(`${file}: approval.role must be admin or steward`);
      } else if (
        !isLocalPrincipalPublish &&
        approval.role === "admin" &&
        approval.approved_by !== config?.organization_admin &&
        !isExactLegacyQuarantine &&
        !terminalAdminApprovalHasHistoricalApprovedState(value)
      ) {
        failures.push(
          `${file}: approval.approved_by for role admin must equal configured organization_admin`,
        );
      } else if (
        value.status === "approved" &&
        !(
          Array.isArray(config?.publish_policy?.approval_roles)
            ? config.publish_policy.approval_roles
            : ["admin", "steward", "member"]
        ).includes(approval.role)
      ) {
        failures.push(
          `${file}: active approval.role must be allowed by publish_policy.approval_roles`,
        );
      }
      if (approval.comment !== undefined && typeof approval.comment !== "string") {
        failures.push(`${file}: approval.comment must be a string when provided`);
      }
      if (approval.runtime_authorization !== undefined) {
        validateWriterAuditEvidence(
          approval.runtime_authorization,
          `${file}: approval.runtime_authorization`,
          {
            actor: approval.approved_by,
            role: approval.role,
            eventAt: approval.approved_at,
            operationPaths,
          },
        );
      }
    }
  }
  if (value.status === "published") {
    const publishedAt = parseIsoDateTimeNanoseconds(value.published_at);
    if (publishedAt === null) {
      failures.push(`${file}: published_at must be an ISO date-time`);
    } else {
      if (createdAt !== null && publishedAt < createdAt) {
        failures.push(`${file}: published_at must not precede created_at`);
      }
      if (approvedAt !== null && publishedAt < approvedAt) {
        failures.push(`${file}: published_at must not precede approval.approved_at`);
      }
    }
    if (typeof value.published_by !== "string" || value.published_by.trim() === "") {
      failures.push(`${file}: published_by must be a non-empty string`);
    }
    const authority = value.credential_authority;
    if (isLocalPrincipalPublish) {
      const localPublish = value.local_publish;
      if (!validateLocalPublishSchema) {
        failures.push(`${file}: local publish schema is unavailable`);
      } else if (!validateLocalPublishSchema(localPublish)) {
        for (const error of validateLocalPublishSchema.errors ?? []) {
          failures.push(
            `${file}: local_publish schema ${error.instancePath || "(root)"} ${error.message ?? "is invalid"}`,
          );
        }
      }
      const requestedAt = parseIsoDateTimeNanoseconds(
        localPublish.requested_at,
      );
      if (
        requestedAt === null ||
        localPublish.requested_at !== value.published_at ||
        localPublish.requested_at !== value.approval?.approved_at
      ) {
        failures.push(
          `${file}: local_publish.requested_at must equal approval and publication timestamps`,
        );
      }
      if (
        typeof localPublish.base_commit !== "string" ||
        !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(
          localPublish.base_commit,
        )
      ) {
        failures.push(
          `${file}: local_publish.base_commit must be a Git object id`,
        );
      }
      const changedPaths = [...operationPaths].sort();
      if (
        !Array.isArray(localPublish.changed_paths) ||
        canonicalJson(localPublish.changed_paths) !==
          canonicalJson(changedPaths)
      ) {
        failures.push(
          `${file}: local_publish.changed_paths must equal the sorted canonical operation paths`,
        );
      }
      const expectedDraftRevision = jsonDigest({
        schema_version:
          "companiesascode.mission_control.local_draft.v1",
        id: value.id,
        base_commit: localPublish.base_commit,
        summary: value.summary,
        operations: value.operations,
      });
      if (localPublish.draft_revision !== expectedDraftRevision) {
        failures.push(
          `${file}: local_publish.draft_revision does not bind the exact draft and base commit`,
        );
      }
      if (
        localPublish.validation_contract !==
        "mission-control-data-validator.v1"
      ) {
        failures.push(
          `${file}: local_publish.validation_contract must be mission-control-data-validator.v1`,
        );
      }
      if (
        !isObject(localPublish.provider_access_audit) ||
        parseIsoDateTimeNanoseconds(
          localPublish.provider_access_audit.checked_at,
        ) === null ||
        typeof localPublish.provider_access_audit.checked_by !==
          "string" ||
        localPublish.provider_access_audit.checked_by.trim() === ""
      ) {
        failures.push(
          `${file}: local_publish requires secret-free provider access audit evidence`,
        );
      }
      if (
        value.created_by !== value.published_by ||
        value.approval?.approved_by !== value.published_by ||
        localPublish.principal_id !== value.published_by ||
        value.approval?.role !== "provider-authorized"
      ) {
        failures.push(
          `${file}: local Principal create, approval, publish and provider-bound principal_id must be one identity`,
        );
      }
      if (
        authority !== undefined ||
        value.runtime_authorization !== undefined ||
        value.creation_authorization !== undefined ||
        value.writer_audit_provenance !== undefined
      ) {
        failures.push(
          `${file}: local Principal publish must not carry capability credential or runtime authorization fields`,
        );
      }
    } else if (!authority || typeof authority !== "object" || Array.isArray(authority)) {
      failures.push(`${file}: credential_authority must be an object`);
    } else {
      if (
        typeof authority.writer_id !== "string" ||
        authority.writer_id.trim() === "" ||
        authority.writer_id !== authority.writer_id.trim() ||
        authority.writer_id.startsWith("REPLACE_WITH_")
      ) {
        failures.push(`${file}: credential_authority.writer_id must be a concrete non-empty string`);
      }
      if (!["admin", "steward"].includes(authority.custody_role)) {
        failures.push(`${file}: credential_authority.custody_role must be admin or steward`);
      }
      if (
        typeof authority.branch !== "string" ||
        authority.branch.trim() === "" ||
        authority.branch !== authority.branch.trim() ||
        authority.branch.startsWith("REPLACE_WITH_")
      ) {
        failures.push(`${file}: credential_authority.branch must be a concrete non-empty string`);
      } else if (authority.branch !== repositoryDbConfig?.data_repo?.branch) {
        failures.push(
          `${file}: credential_authority.branch must match repository-db.yaml data_repo.branch`,
        );
      }
      const authorityPaths = validateRecordedAuthorityPathList(
        authority.path_allowlist,
        `${file}: credential_authority.path_allowlist`,
      );
      for (const [index, pattern] of authorityPaths.entries()) {
        const patternBase = policyPatternBase(pattern);
        if (!isHistoricalMissionControlDataTarget(patternBase)) {
          failures.push(
            `${file}: credential_authority.path_allowlist[${index}] must stay inside the Mission Control data boundary`,
          );
        }
      }
      for (const operationPath of operationPaths) {
        if (!authorityPaths.some((pattern) => policyPatternContains(pattern, operationPath))) {
          failures.push(
            `${file}: credential_authority.path_allowlist does not cover published operation ${operationPath}`,
          );
        }
      }
    }
    if (!isLocalPrincipalPublish && value.runtime_authorization !== undefined) {
      const validRuntimeAuthorization = validateWriterAuditEvidence(
        value.runtime_authorization,
        `${file}: runtime_authorization`,
        {
          actor: value.published_by,
          allowedRoles: ["admin", "steward"],
          eventAt: value.published_at,
          operationPaths,
        },
      );
      if (validRuntimeAuthorization && isObject(authority)) {
        if (
          value.runtime_authorization.scope.writer_id !== authority.writer_id ||
          value.runtime_authorization.scope.data_branch !== authority.branch ||
          value.runtime_authorization.credential.custody_role !==
            authority.custody_role ||
          JSON.stringify(value.runtime_authorization.scope.path_allowlist) !==
            JSON.stringify(authority.path_allowlist)
        ) {
          failures.push(
            `${file}: runtime_authorization scope and custody must equal credential_authority`,
          );
        }
      }
    }
  } else {
    for (const field of [
      "published_at",
      "published_by",
      "credential_authority",
      "runtime_authorization",
      "local_publish",
    ]) {
      if (value[field] !== undefined) {
        failures.push(`${file}: only a published changeset may contain ${field}`);
      }
    }
  }
  if (value.status === "superseded") {
    const supersession = value.supersession;
    if (!supersession || typeof supersession !== "object" || Array.isArray(supersession)) {
      failures.push(`${file}: superseded changeset requires supersession metadata`);
    } else {
      const supersededAt = parseIsoDateTimeNanoseconds(supersession.superseded_at);
      if (supersededAt === null) {
        failures.push(`${file}: supersession.superseded_at must be an ISO date-time`);
      } else {
        if (createdAt !== null && supersededAt < createdAt) {
          failures.push(`${file}: supersession.superseded_at must not precede created_at`);
        }
        if (approvedAt !== null && supersededAt < approvedAt) {
          failures.push(`${file}: supersession.superseded_at must not precede approval.approved_at`);
        }
      }
      if (typeof supersession.superseded_by !== "string" || supersession.superseded_by.trim() === "") {
        failures.push(`${file}: supersession.superseded_by must be a non-empty string`);
      }
      if (!["admin", "steward"].includes(supersession.role)) {
        failures.push(`${file}: supersession.role must be admin or steward`);
      }
      if (typeof supersession.reason !== "string" || supersession.reason.trim() === "") {
        failures.push(`${file}: supersession.reason must be a non-empty string`);
      }
      if (
        supersession.replacement_changeset_id !== null &&
        supersession.replacement_changeset_id !== undefined &&
        (typeof supersession.replacement_changeset_id !== "string" ||
          !/^[a-z0-9][a-z0-9-]{0,127}$/.test(supersession.replacement_changeset_id))
      ) {
        failures.push(`${file}: supersession.replacement_changeset_id must be null or a valid changeset id`);
      }
      if (supersession.runtime_authorization !== undefined) {
        const useHistoricalDomainScope =
          hasGrandfatheredPreManifestSupersessionScope(value);
        const supersessionAuditPaths =
          typeof value.id === "string"
            ? [
                `${pendingChangesetsDirectory}/${value.id}.json`,
                `${supersededChangesetsDirectory}/${value.id}.json`,
              ]
            : [];
        validateWriterAuditEvidence(
          supersession.runtime_authorization,
          `${file}: supersession.runtime_authorization`,
          {
            actor: supersession.superseded_by,
            role: supersession.role,
            eventAt: supersession.superseded_at,
            operationPaths: useHistoricalDomainScope
              ? operationPaths
              : supersessionAuditPaths,
          },
        );
      }
    }
  } else if (value.supersession !== undefined) {
    failures.push(`${file}: only a superseded changeset may contain supersession metadata`);
  }
  validateWriterAuditProvenance(value, file);
  return value;
}

function policyPatternBase(value) {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) return null;
  if (value.includes("REPLACE_WITH_")) return null;
  const base = value.endsWith("/**") ? value.slice(0, -3) : value;
  return isSafeRelativePath(base) ? base : null;
}

function isMissionControlPolicyPath(value) {
  const base = policyPatternBase(value);
  return base === "data/mission-control" || base?.startsWith("data/mission-control/");
}

function policyPatternContains(container, candidate) {
  const containerBase = policyPatternBase(container);
  const candidateBase = policyPatternBase(candidate);
  if (!containerBase || !candidateBase) return false;
  if (!container.endsWith("/**")) return container === candidate;
  return candidateBase === containerBase || candidateBase.startsWith(`${containerBase}/`);
}

function validatePolicyPathList(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    failures.push(`${label} must be a non-empty list`);
    return [];
  }
  const valid = [];
  for (const [index, pattern] of value.entries()) {
    if (!isMissionControlPolicyPath(pattern)) {
      failures.push(`${label}[${index}] must be a concrete safe path or /** pattern inside data/mission-control`);
      continue;
    }
    valid.push(pattern);
  }
  return valid;
}

function validateRecordedAuthorityPathList(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    failures.push(`${label} must be a non-empty list`);
    return [];
  }
  const valid = [];
  for (const [index, pattern] of value.entries()) {
    if (!policyPatternBase(pattern)) {
      failures.push(`${label}[${index}] must be a concrete safe repository path or /** pattern`);
      continue;
    }
    valid.push(pattern);
  }
  return valid;
}

function validateLegacyChangesetQuarantine(value, label) {
  const quarantine = new Map();
  if (!Array.isArray(value)) {
    failures.push(`${label} must be a list`);
    return quarantine;
  }
  for (const [index, entry] of value.entries()) {
    const entryLabel = `${label}[${index}]`;
    if (!isObject(entry)) {
      failures.push(`${entryLabel} must be an object`);
      continue;
    }
    const allowedKeys = new Set([
      "id",
      "immutable_payload_digest_sha256",
      "terminal_action",
      "terminal_status",
      "authenticated_status",
      "record_digest_sha256",
      "provenance_digest_sha256",
    ]);
    const unknownKeys = Object.keys(entry).filter(
      (key) => !allowedKeys.has(key),
    );
    if (unknownKeys.length > 0) {
      failures.push(
        `${entryLabel} has unsupported fields: ${unknownKeys.join(", ")}`,
      );
    }
    if (
      typeof entry.id !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,127}$/.test(entry.id)
    ) {
      failures.push(`${entryLabel}.id must be a canonical changeset id`);
      continue;
    }
    if (
      typeof entry.immutable_payload_digest_sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(entry.immutable_payload_digest_sha256)
    ) {
      failures.push(
        `${entryLabel}.immutable_payload_digest_sha256 must be a lowercase SHA-256 digest`,
      );
      continue;
    }
    if (
      ![
        "supersede",
        "retain",
        "grandfather-authenticated",
        "grandfather-supersession-scope",
      ].includes(entry.terminal_action)
    ) {
      failures.push(
        `${entryLabel}.terminal_action must be supersede, retain, grandfather-authenticated or grandfather-supersession-scope`,
      );
      continue;
    }
    if (entry.terminal_action === "supersede") {
      if (
        Object.hasOwn(entry, "terminal_status") ||
        Object.hasOwn(entry, "authenticated_status") ||
        Object.hasOwn(entry, "record_digest_sha256") ||
        Object.hasOwn(entry, "provenance_digest_sha256")
      ) {
        failures.push(
          `${entryLabel} supersede entries must not contain retained-record fields`,
        );
        continue;
      }
    } else if (entry.terminal_action === "retain") {
      if (
        Object.hasOwn(entry, "authenticated_status") ||
        Object.hasOwn(entry, "provenance_digest_sha256")
      ) {
        failures.push(
          `${entryLabel} retain entries must not contain authenticated grandfather fields`,
        );
        continue;
      }
      if (!["published", "superseded"].includes(entry.terminal_status)) {
        failures.push(
          `${entryLabel}.terminal_status must be published or superseded for retain`,
        );
        continue;
      }
      if (
        typeof entry.record_digest_sha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(entry.record_digest_sha256)
      ) {
        failures.push(
          `${entryLabel}.record_digest_sha256 must be a lowercase SHA-256 digest for retain`,
        );
        continue;
      }
    } else if (entry.terminal_action === "grandfather-authenticated") {
      if (Object.hasOwn(entry, "terminal_status")) {
        failures.push(
          `${entryLabel} grandfather-authenticated entries must not contain terminal_status`,
        );
        continue;
      }
      if (
        !["approved", "published", "superseded"].includes(
          entry.authenticated_status,
        )
      ) {
        failures.push(
          `${entryLabel}.authenticated_status must be approved, published or superseded for grandfather-authenticated`,
        );
        continue;
      }
      if (
        typeof entry.record_digest_sha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(entry.record_digest_sha256)
      ) {
        failures.push(
          `${entryLabel}.record_digest_sha256 must be a lowercase SHA-256 digest for grandfather-authenticated`,
        );
        continue;
      }
      if (
        typeof entry.provenance_digest_sha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(entry.provenance_digest_sha256)
      ) {
        failures.push(
          `${entryLabel}.provenance_digest_sha256 must be a lowercase SHA-256 digest for grandfather-authenticated`,
        );
        continue;
      }
    } else {
      if (
        Object.hasOwn(entry, "terminal_status") ||
        Object.hasOwn(entry, "authenticated_status")
      ) {
        failures.push(
          `${entryLabel} grandfather-supersession-scope entries must not contain status fields`,
        );
        continue;
      }
      if (
        typeof entry.record_digest_sha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(entry.record_digest_sha256)
      ) {
        failures.push(
          `${entryLabel}.record_digest_sha256 must be a lowercase SHA-256 digest for grandfather-supersession-scope`,
        );
        continue;
      }
      if (
        typeof entry.provenance_digest_sha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(entry.provenance_digest_sha256)
      ) {
        failures.push(
          `${entryLabel}.provenance_digest_sha256 must be a lowercase SHA-256 digest for grandfather-supersession-scope`,
        );
        continue;
      }
    }
    if (quarantine.has(entry.id)) {
      failures.push(`${entryLabel}.id duplicates ${entry.id}`);
      continue;
    }
    quarantine.set(entry.id, Object.freeze({ ...entry }));
  }
  return quarantine;
}

function isLocalTestFixtureRemote(value) {
  if (typeof value !== "string" || !value.startsWith("ssh://")) return false;
  try {
    const remote = new URL(value);
    // ssh://fixture@localhost/C:/... carries a leading slash before the
    // Windows drive letter; strip it so resolve() keeps the drive root.
    const remotePathname = decodeURIComponent(remote.pathname);
    const normalizedPath = resolve(
      process.platform === "win32" && /^\/[A-Za-z]:\//.test(remotePathname)
        ? remotePathname.slice(1)
        : remotePathname,
    );
    const temporaryRoot = resolve(tmpdir());
    return (
      remote.protocol === "ssh:" &&
      remote.username === "fixture" &&
      remote.hostname === "localhost" &&
      (normalizedPath === temporaryRoot ||
        normalizedPath.startsWith(`${temporaryRoot}${sep}`)) &&
      normalizedPath.endsWith(`${sep}mission-control-data.git`)
    );
  } catch {
    return false;
  }
}

const repositoryDbConfig = parseYamlMapping("repository-db.yaml");
validateRepositoryDbControlPlane(repositoryDbConfig);
if (unauthenticatedLocalTestRequested) {
  if (
    !process.argv.includes("--pinned-app-code") ||
    !isLocalTestFixtureRemote(repositoryDbConfig?.data_repo?.remote)
  ) {
    failures.push(
      "--allow-unauthenticated-local-test requires --pinned-app-code and an ssh://fixture@localhost remote inside the OS temp directory",
    );
  } else {
    allowUnauthenticatedLocalTest = true;
  }
}
const config = parseJson(missionControlConfigFile);
const configuredWriterMode =
  config?.publish_policy?.writer_mode ?? "authenticated-capability-v1";
const localPrincipalWriterMode = configuredWriterMode === "local-principal-v1";
const githubAppWorkspaceWriterMode =
  configuredWriterMode === "github-app-workspace-v1";
const nativeGitWriterConfigured = nativeGitWriterMode(configuredWriterMode);
const validatePlanSchema = compilePlanSchema();
const validateWriterAuditSchema = compileWriterAuditSchema();
const validateWriterProvenanceSchema = compileWriterProvenanceSchema();
const validateLocalPublishSchema = compileLocalPublishSchema();
const historicalChangesets = nativeGitWriterConfigured
  ? emptyHistoricalChangesets()
  : loadHistoricalChangesets();
const committedPersistentQuarantineEntries =
  nativeGitWriterConfigured
    ? new Map()
    : loadCommittedPersistentQuarantineEntries(historicalChangesets);
let configuredProtectedPaths = [];
let configuredLegacyChangesetQuarantine = new Map();
let configuredLegacyQuarantineHistory = new Map();
const validateRoadmapSchema =
  config?.roadmap_schema_path === roadmapSchemaFile
    ? compileRoadmapSchema(config.roadmap_schema_path)
    : null;
if (config && config.schema_version !== "companiesascode.mission_control.config.v1") {
  failures.push(
    "mission-control.config.json: schema_version must be companiesascode.mission_control.config.v1",
  );
}
if (config && config.data_mode !== "repository-db") {
  failures.push("mission-control.config.json: data_mode must be repository-db");
}
if (config) {
  if (typeof config.plan_prefix !== "string" || !/^[A-Z]{2,6}$/.test(config.plan_prefix)) {
    failures.push("mission-control.config.json: plan_prefix must be 2-6 uppercase letters");
  }
  const organizationAdmin =
    typeof config.organization_admin === "string" ? config.organization_admin.trim() : "";
  if (!organizationAdmin) {
    failures.push("mission-control.config.json: organization_admin must be a non-empty string");
  } else if (organizationAdmin.startsWith("REPLACE_WITH_")) {
    failures.push("mission-control.config.json: organization_admin placeholder must be replaced");
  } else if (organizationAdmin !== config.organization_admin) {
    failures.push("mission-control.config.json: organization_admin must not have surrounding whitespace");
  }
  if (Object.hasOwn(config, "workspace_admin")) {
    failures.push("mission-control.config.json: new data repos must use organization_admin, not legacy workspace_admin");
  }
  const expectedDataPaths = {
    repository_db_config_path: "repository-db.yaml",
    plans_dir: plansDirectory,
    roadmaps_dir: roadmapsDirectory,
    reports_dir: "data/mission-control/reports",
    import_reviews_dir: "data/mission-control/import-reviews",
    issues_open_path: "data/mission-control/ISSUES.open.json",
    issues_resolved_path: "data/mission-control/ISSUES.resolved.json",
    todo_tasks_path: "data/mission-control/TODO.tasks.json",
    done_tasks_path: "data/mission-control/DONE.tasks.json",
    schema_path: planSchemaFile,
    roadmap_schema_path: roadmapSchemaFile,
  };
  for (const [key, expected] of Object.entries(expectedDataPaths)) {
    if (config[key] !== expected) {
      failures.push(`mission-control.config.json: ${key} must be ${expected}`);
    }
  }
  const expectedChangesetDirectories = {
    pending_changesets_dir: "data/mission-control/changesets/pending",
    published_changesets_dir: "data/mission-control/changesets/published",
    superseded_changesets_dir: "data/mission-control/changesets/superseded",
  };
  for (const [key, expected] of Object.entries(expectedChangesetDirectories)) {
    if (config.publish_policy?.[key] !== expected) {
      failures.push(`mission-control.config.json: publish_policy.${key} must be ${expected}`);
    }
  }
  configuredLegacyChangesetQuarantine =
    validateLegacyChangesetQuarantine(
      config.publish_policy?.legacy_changeset_quarantine,
      "mission-control.config.json: publish_policy.legacy_changeset_quarantine",
    );
  configuredProtectedPaths = validatePolicyPathList(
    config.publish_policy?.protected_paths,
    "mission-control.config.json: publish_policy.protected_paths",
  );
  const approvalRoles = config.publish_policy?.approval_roles;
  if (
    approvalRoles !== undefined &&
    (
      !Array.isArray(approvalRoles) ||
      approvalRoles.length === 0 ||
      approvalRoles.some(
        (role) =>
          typeof role !== "string" ||
          !["admin", "steward", "member"].includes(role) ||
          role.trim() !== role,
      ) ||
      new Set(approvalRoles).size !== approvalRoles.length
    )
  ) {
    failures.push(
      "mission-control.config.json: publish_policy.approval_roles must be a unique non-empty subset of admin, steward and member",
    );
  }
  for (const [key, directory] of Object.entries(expectedChangesetDirectories)) {
    const representativeAuditPath = `${directory}/__policy-check__.json`;
    if (
      !configuredProtectedPaths.some((protectedPath) =>
        policyPatternContains(protectedPath, representativeAuditPath),
      )
    ) {
      failures.push(
        `mission-control.config.json: publish_policy.protected_paths must cover audit files under publish_policy.${key} (${directory})`,
      );
    }
  }
  if (
    ![
      "authenticated-capability-v1",
      "local-principal-v1",
      "github-app-workspace-v1",
    ].includes(configuredWriterMode)
  ) {
    failures.push(
      "mission-control.config.json: publish_policy.writer_mode must be authenticated-capability-v1, local-principal-v1 or github-app-workspace-v1",
    );
  }
  const authority = config.publish_policy?.credential_authority;
  if (configuredWriterMode === "local-principal-v1") {
    const configuredDataRemote = repositoryDbConfig?.data_repo?.remote;
    if (
      !remoteUsesGitHubSsh(configuredDataRemote) &&
      !remoteUsesGitHubHttps(configuredDataRemote) &&
      !(
        unauthenticatedLocalTestRequested &&
        (sshRemoteHost(configuredDataRemote) === "localhost" ||
          httpsRemoteHost(configuredDataRemote) === "localhost")
      )
    ) {
      failures.push(
        "mission-control.config.json: local-principal-v1 requires a github.com SSH or credential-free HTTPS data_repo.remote",
      );
    }
    // Older data repositories may retain approval_roles/local_principal audit
    // metadata for historical evidence. It is read-compatible only: neither
    // field authorizes nor blocks the default local writer.
    if (authority !== undefined) {
      failures.push(
        "mission-control.config.json: local-principal-v1 must not configure a parallel credential_authority",
      );
    }
    for (const retiredKey of ["approval_roles", "local_principal"]) {
      if (Object.hasOwn(config.publish_policy ?? {}, retiredKey)) {
        failures.push(
          `mission-control.config.json: local-principal-v1 must not configure retired publish_policy.${retiredKey}`,
        );
      }
    }
  } else if (githubAppWorkspaceWriterMode) {
    const configuredDataRemote = repositoryDbConfig?.data_repo?.remote;
    if (!remoteUsesGitHubHttps(configuredDataRemote)) {
      failures.push(
        "mission-control.config.json: github-app-workspace-v1 requires a credential-free https://github.com data_repo.remote",
      );
    }
    for (const forbiddenKey of [
      "credential_authority",
      "approval_roles",
      "local_principal",
    ]) {
      if (Object.hasOwn(config.publish_policy ?? {}, forbiddenKey)) {
        failures.push(
          `mission-control.config.json: github-app-workspace-v1 must not configure publish_policy.${forbiddenKey}`,
        );
      }
    }
  } else if (
    configuredWriterMode === "authenticated-capability-v1" &&
    (!authority || typeof authority !== "object" || Array.isArray(authority))
  ) {
    failures.push(
      "mission-control.config.json: authenticated-capability-v1 requires publish_policy.credential_authority mapping",
    );
  } else if (configuredWriterMode === "authenticated-capability-v1") {
    if (authority.required !== true) {
      failures.push(
        "mission-control.config.json: publish_policy.credential_authority.required must be true",
      );
    }
    const allowedWriterIds = authority.allowed_writer_ids;
    if (
      !Array.isArray(allowedWriterIds) ||
      allowedWriterIds.length === 0 ||
      allowedWriterIds.some(
        (writerId) =>
          typeof writerId !== "string" ||
          writerId.trim() === "" ||
          writerId !== writerId.trim() ||
          writerId.startsWith("REPLACE_WITH_") ||
          !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(writerId),
      ) ||
      new Set(allowedWriterIds).size !== allowedWriterIds.length
    ) {
      failures.push(
        "mission-control.config.json: publish_policy.credential_authority.allowed_writer_ids must be a unique non-empty list of concrete strings",
      );
    }
    if (authority.custody !== "admin-or-steward") {
      failures.push(
        "mission-control.config.json: publish_policy.credential_authority.custody must be admin-or-steward",
      );
    }
    if (
      typeof authority.branch !== "string" ||
      authority.branch.trim() === "" ||
      authority.branch !== authority.branch.trim() ||
      authority.branch.startsWith("REPLACE_WITH_")
    ) {
      failures.push(
        "mission-control.config.json: publish_policy.credential_authority.branch must be a concrete non-empty string",
      );
    } else if (authority.branch !== repositoryDbConfig?.data_repo?.branch) {
      failures.push(
        "mission-control.config.json: publish_policy.credential_authority.branch must match repository-db.yaml data_repo.branch",
      );
    }
    const authorityPaths = validatePolicyPathList(
      authority.path_allowlist,
      "mission-control.config.json: publish_policy.credential_authority.path_allowlist",
    );
    for (const protectedPath of configuredProtectedPaths) {
      if (
        !authorityPaths.some((authorityPath) =>
          policyPatternContains(authorityPath, protectedPath),
        )
      ) {
        failures.push(
          `mission-control.config.json: protected path ${protectedPath} must stay within publish_policy.credential_authority.path_allowlist`,
        );
      }
    }
  }
}
configuredLegacyQuarantineHistory = nativeGitWriterConfigured
  ? new Map()
  : loadLegacyQuarantineHistory(
      configuredLegacyChangesetQuarantine,
      historicalChangesets,
    );
for (const [changesetId, committedEntry] of
  committedPersistentQuarantineEntries) {
  const currentEntry =
    configuredLegacyChangesetQuarantine.get(changesetId);
  if (
    currentEntry === undefined ||
    canonicalJson(currentEntry) !== canonicalJson(committedEntry)
  ) {
    failures.push(
      committedEntry.terminal_action === "retain"
        ? `committed retain quarantine entry ${changesetId} and its terminal audit record must remain immutable`
        : committedEntry.terminal_action ===
            "grandfather-authenticated"
          ? `committed grandfather-authenticated quarantine entry ${changesetId} must remain immutable with its authenticated audit history`
          : `committed grandfather-supersession-scope quarantine entry ${changesetId} and its authenticated superseded audit record must remain immutable`,
    );
  } else if (!persistentQuarantineHistoryIsContinuous(committedEntry)) {
    failures.push(
      committedEntry.terminal_action === "retain"
        ? `committed retain quarantine entry ${changesetId} and its terminal audit record must remain immutable and continuous from introduction through HEAD`
        : committedEntry.terminal_action ===
            "grandfather-authenticated"
          ? `committed grandfather-authenticated quarantine entry ${changesetId} and its authenticated audit record must remain immutable and continuous from introduction through HEAD`
          : `committed grandfather-supersession-scope quarantine entry ${changesetId} and its authenticated superseded audit record must remain immutable and continuous from introduction through HEAD`,
    );
  }
}
const requiredJsonArrayValues = new Map();
for (const file of requiredJsonArrays) {
  const value = parseJson(file);
  if (value && !Array.isArray(value)) {
    failures.push(`${file}: must be a JSON array`);
  } else if (Array.isArray(value)) {
    requiredJsonArrayValues.set(file, value);
  }
}
const existingTaskIds = collectRecordIds([
  ...(requiredJsonArrayValues.get("data/mission-control/TODO.tasks.json") ?? []),
  ...(requiredJsonArrayValues.get("data/mission-control/DONE.tasks.json") ?? []),
]);
const existingIssueIds = collectRecordIds([
  ...(requiredJsonArrayValues.get("data/mission-control/ISSUES.open.json") ?? []),
  ...(requiredJsonArrayValues.get("data/mission-control/ISSUES.resolved.json") ?? []),
]);
const safeRequiredDirectories = new Set();
for (const directory of requiredDirectories) {
  const path = join(root, directory);
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    failures.push(`missing directory ${directory}`);
  } else if (isSafeConfiguredDirectory(directory, `directory ${directory}`)) {
    safeRequiredDirectories.add(directory);
  }
}
const existingPlanCodes = new Set();
const validatedPlans = [];
if (
  config &&
  typeof config.plan_prefix === "string" &&
  /^[A-Z]{2,6}$/.test(config.plan_prefix) &&
  safeRequiredDirectories.has(plansDirectory)
) {
  const seenDevCodes = new Map();
  const seenIds = new Map();
  for (const file of listYamlFiles(plansDirectory)) {
    if (file.endsWith(".yml")) {
      failures.push(`${file}: canonical plan extension must be .yaml`);
      continue;
    }
    const plan = validatePlan(file, config.plan_prefix, validatePlanSchema);
    if (plan) {
      validateUniquePlanIdentity(file, plan, seenDevCodes, seenIds);
      if (typeof plan.dev_code === "string") existingPlanCodes.add(plan.dev_code);
      validatedPlans.push({ file, plan });
    }
  }
}
validateTaskLedgerInvariants(
  config,
  validatedPlans,
  requiredJsonArrayValues.get("data/mission-control/TODO.tasks.json") ?? [],
  requiredJsonArrayValues.get("data/mission-control/DONE.tasks.json") ?? [],
);
if (
  config?.roadmaps_dir === roadmapsDirectory &&
  isSafeConfiguredDirectory(config.roadmaps_dir, "mission-control.config.json: roadmaps_dir")
) {
  const seenRoadmapCodes = new Map();
  const seenRoadmapIds = new Map();
  for (const file of listYamlFiles(config.roadmaps_dir)) {
    validateRoadmap(file, validateRoadmapSchema, {
      existingPlanCodes,
      existingTaskIds,
      existingIssueIds,
      seenRoadmapCodes,
      seenRoadmapIds,
    });
  }
}
for (const file of requiredFiles) {
  if (!existsSync(join(root, file))) failures.push(`missing ${file}`);
}

const seenChangesetIds = new Map();
const currentChangesetsById = new Map();
if (nativeGitWriterConfigured) {
  validateOpaqueChangesetHistoryDirectory(
    changesetHistoryRoot,
    new Set(),
  );
  assertNativeGitWriterChangesetHistoryFrozen();
} else if (safeRequiredDirectories.has(pendingChangesetsDirectory)) {
  for (const file of listJsonFiles(pendingChangesetsDirectory)) {
    const value = validateChangeset(
      file,
      ["pending", "approved"],
      seenChangesetIds,
    );
    if (typeof value?.id === "string") currentChangesetsById.set(value.id, value);
  }
}
if (!nativeGitWriterConfigured && safeRequiredDirectories.has(publishedChangesetsDirectory)) {
  for (const file of listJsonFiles(publishedChangesetsDirectory)) {
    const value = validateChangeset(file, "published", seenChangesetIds);
    if (typeof value?.id === "string") currentChangesetsById.set(value.id, value);
  }
}
const supersededChangesets = [];
if (!nativeGitWriterConfigured && safeRequiredDirectories.has(supersededChangesetsDirectory)) {
  for (const file of listJsonFiles(supersededChangesetsDirectory)) {
    const value = validateChangeset(file, "superseded", seenChangesetIds);
    if (value) {
      supersededChangesets.push({ file, value });
      if (typeof value.id === "string") currentChangesetsById.set(value.id, value);
    }
  }
}
const instantiatedDataRepository = isSafeMissionControlGitRemote(
  repositoryDbConfig?.data_repo?.remote,
);
const explicitUnbornBootstrap =
  unbornBootstrapRequested &&
  process.argv.includes("--pinned-app-code") &&
  proveUnbornGitRepository() &&
  instantiatedDataRepository &&
  currentChangesetsById.size === 0;
if (unbornBootstrapRequested && !explicitUnbornBootstrap) {
  failures.push(
    "--allow-unborn-bootstrap requires --pinned-app-code and is restricted to a proven never-committed instantiated data repository with no changeset audit records",
  );
}
if (
  !historicalChangesets.available &&
  instantiatedDataRepository &&
  !explicitUnbornBootstrap
) {
  failures.push(
    `authenticated writer audit history is unavailable (${historicalChangesets.reason}); instantiated data repositories require exact immutable Git history`,
  );
}
for (const [changesetId, quarantineEntry] of
  configuredLegacyChangesetQuarantine) {
  const current = currentChangesetsById.get(changesetId);
  if (!current) {
    failures.push(
      `publish_policy.legacy_changeset_quarantine references missing changeset ${changesetId}`,
    );
    continue;
  }
  if (
    jsonDigest(immutableChangesetPayload(current)) !==
    quarantineEntry.immutable_payload_digest_sha256
  ) {
    failures.push(
      `publish_policy.legacy_changeset_quarantine payload digest does not match ${changesetId}`,
    );
  }
  if (
    quarantineEntry.terminal_action === "retain" &&
    (current.status !== quarantineEntry.terminal_status ||
      jsonDigest(current) !== quarantineEntry.record_digest_sha256 ||
      current.writer_audit_provenance !== undefined ||
      changesetHasWriterAuditEvidence(current))
  ) {
    failures.push(
      `publish_policy.legacy_changeset_quarantine retain entry must freeze the exact unauthenticated ${quarantineEntry.terminal_status} record ${changesetId}`,
    );
  }
  if (
    quarantineEntry.terminal_action === "grandfather-authenticated" &&
    (current.status !== quarantineEntry.authenticated_status ||
      jsonDigest(current) !== quarantineEntry.record_digest_sha256 ||
      current.writer_audit_provenance?.mode !== "legacy-transition" ||
      !changesetHasWriterAuditEvidence(current) ||
      jsonDigest(current.writer_audit_provenance) !==
        quarantineEntry.provenance_digest_sha256)
  ) {
    failures.push(
      `publish_policy.legacy_changeset_quarantine grandfather-authenticated entry must preserve the exact pinned read-only legacy-transition record for ${changesetId}`,
    );
  }
  if (
    quarantineEntry.terminal_action ===
      "grandfather-supersession-scope" &&
    (current.status !== "superseded" ||
      jsonDigest(current) !== quarantineEntry.record_digest_sha256 ||
      current.writer_audit_provenance?.mode !== "authenticated" ||
      !changesetHasWriterAuditEvidence(current) ||
      jsonDigest(current.writer_audit_provenance) !==
        quarantineEntry.provenance_digest_sha256)
  ) {
    failures.push(
      `publish_policy.legacy_changeset_quarantine grandfather-supersession-scope entry must preserve the exact pinned read-only authenticated superseded record for ${changesetId}`,
    );
  }
  const historicalLegacyRecord =
    quarantineHasExactPredecessorRecord(quarantineEntry, current);
  if (!historicalChangesets.available || !historicalLegacyRecord) {
    const historyKind = [
      "grandfather-authenticated",
      "grandfather-supersession-scope",
    ].includes(quarantineEntry.terminal_action)
      ? "already-authenticated predecessor"
      : "pre-authenticated predecessor";
    failures.push(
      `publish_policy.legacy_changeset_quarantine requires exact ${historyKind} Git history strictly before the quarantine entry for ${changesetId}`,
    );
  }
  if (
    quarantineEntry.terminal_action === "grandfather-authenticated" &&
    !grandfatherIntroductionFreezesAuthenticatedRecord(
      quarantineEntry,
    )
  ) {
    failures.push(
      `publish_policy.legacy_changeset_quarantine grandfather-authenticated entry requires the exact already-authenticated record both before and at its introduction commit for ${changesetId}`,
    );
  }
  if (
    quarantineEntry.terminal_action === "grandfather-authenticated" &&
    !grandfatherHasOriginalLegacyHistory(quarantineEntry)
  ) {
    failures.push(
      `publish_policy.legacy_changeset_quarantine grandfather-authenticated entry requires the phase-compatible original pre-authenticated record in every immediate parent of its first pinned authenticated transition for ${changesetId}`,
    );
  }
}

function recordPathMatchesLifecycleStatus(record) {
  const expectedDirectory = {
    pending: pendingChangesetsDirectory,
    approved: pendingChangesetsDirectory,
    published: publishedChangesetsDirectory,
    superseded: supersededChangesetsDirectory,
  }[record.value.status];
  return (
    expectedDirectory !== undefined &&
    record.path === `${expectedDirectory}/${record.value.id}.json`
  );
}

function writerLifecycleAuditSubtree(value, phaseName) {
  if (phaseName === "creation") {
    return {
      created_at: value.created_at,
      created_by: value.created_by,
      creation_authorization: value.creation_authorization,
    };
  }
  if (phaseName === "approval") return value.approval;
  if (phaseName === "publication") {
    if (value.status !== "published") return undefined;
    return {
      published_at: value.published_at,
      published_by: value.published_by,
      credential_authority: value.credential_authority,
      runtime_authorization: value.runtime_authorization,
    };
  }
  if (phaseName === "supersession") {
    return value.status === "superseded"
      ? value.supersession
      : undefined;
  }
  return undefined;
}

function authenticatedLifecycleShapeIsStable(value) {
  const publicationFields = [
    "published_at",
    "published_by",
    "credential_authority",
    "runtime_authorization",
  ];
  if (!["pending", "approved", "published", "superseded"].includes(
    value.status,
  )) {
    return false;
  }
  const hasApproval = isObject(value.approval);
  if (
    (value.status === "pending" && value.approval !== undefined) ||
    (["approved", "published"].includes(value.status) &&
      !hasApproval)
  ) {
    return false;
  }
  if (
    value.status === "published"
      ? publicationFields.some(
          (field) => value[field] === undefined,
        )
      : publicationFields.some(
          (field) => value[field] !== undefined,
        )
  ) {
    return false;
  }
  if (
    value.status === "superseded"
      ? !isObject(value.supersession)
      : value.supersession !== undefined
  ) {
    return false;
  }

  const createdAt = parseIsoDateTimeNanoseconds(value.created_at);
  if (createdAt === null) return false;
  let approvedAt = null;
  if (hasApproval) {
    approvedAt = parseIsoDateTimeNanoseconds(
      value.approval.approved_at,
    );
    if (
      approvedAt === null ||
      approvedAt < createdAt ||
      typeof value.approval.approved_by !== "string" ||
      value.approval.approved_by.trim() === "" ||
      !["admin", "steward"].includes(value.approval.role) ||
      (value.approval.comment !== undefined &&
        typeof value.approval.comment !== "string")
    ) {
      return false;
    }
  }
  if (value.status === "published") {
    const publishedAt = parseIsoDateTimeNanoseconds(
      value.published_at,
    );
    if (
      publishedAt === null ||
      publishedAt < createdAt ||
      (approvedAt !== null && publishedAt < approvedAt) ||
      typeof value.published_by !== "string" ||
      value.published_by.trim() === "" ||
      !isObject(value.credential_authority) ||
      !isObject(value.runtime_authorization)
    ) {
      return false;
    }
  }
  if (value.status === "superseded") {
    const supersededAt = parseIsoDateTimeNanoseconds(
      value.supersession.superseded_at,
    );
    if (
      supersededAt === null ||
      supersededAt < createdAt ||
      (approvedAt !== null && supersededAt < approvedAt) ||
      typeof value.supersession.superseded_by !== "string" ||
      value.supersession.superseded_by.trim() === "" ||
      !["admin", "steward"].includes(value.supersession.role) ||
      typeof value.supersession.reason !== "string" ||
      value.supersession.reason.trim() === ""
    ) {
      return false;
    }
  }
  return true;
}

function authenticatedSnapshotIsSelfBound(value, current) {
  const provenance = value.writer_audit_provenance;
  if (
    !authenticatedLifecycleShapeIsStable(value) ||
    !isObject(provenance) ||
    !changesetHasWriterAuditEvidence(value) ||
    canonicalJson(provenance) !==
      canonicalJson(current.writer_audit_provenance) ||
    provenance.changeset_id !== value.id ||
    provenance.changeset_payload_digest_sha256 !==
      jsonDigest(immutableChangesetPayload(value))
  ) {
    return false;
  }
  const phases = writerLifecyclePhases(value);
  const firstPhase = phases.find(
    (phase) =>
      phase.name === provenance.first_authenticated_phase,
  );
  if (!firstPhase?.occurred || firstPhase.evidence === undefined) {
    return false;
  }
  if (
    provenance.authorization_id !==
      firstPhase.evidence.authorization_id ||
    provenance.authorization_source_commit !==
      firstPhase.evidence.authorization_source?.commit ||
    provenance.authorization_source_blob !==
      firstPhase.evidence.authorization_source?.blob ||
    provenance.first_authorization_digest_sha256 !==
      jsonDigest(firstPhase.evidence) ||
    provenance.recorded_at !== firstPhase.eventAt
  ) {
    return false;
  }
  const firstPhaseOrder = writerLifecyclePhaseOrder.get(firstPhase.name);
  if (firstPhaseOrder === undefined) return false;
  const currentPhases = new Map(
    writerLifecyclePhases(current).map((phase) => [
      phase.name,
      phase,
    ]),
  );
  return phases.every((phase) => {
    const phaseOrder = writerLifecyclePhaseOrder.get(phase.name);
    const requiresEvidence =
      phase.occurred &&
      phaseOrder !== undefined &&
      phaseOrder >= firstPhaseOrder;
    if (requiresEvidence !== (phase.evidence !== undefined)) {
      return false;
    }
    if (
      phase.occurred &&
      canonicalJson(
        writerLifecycleAuditSubtree(value, phase.name),
      ) !==
        canonicalJson(
          writerLifecycleAuditSubtree(current, phase.name),
        )
    ) {
      return false;
    }
    if (phase.evidence === undefined) return true;
    return (
      canonicalJson(phase.evidence) ===
      canonicalJson(currentPhases.get(phase.name)?.evidence)
    );
  });
}

function authenticatedLifecycleTransitionIsMonotonic(parent, child) {
  const allowedNextStatuses = {
    pending: new Set(["pending", "approved", "superseded"]),
    approved: new Set(["approved", "published", "superseded"]),
    published: new Set(["published"]),
    superseded: new Set(["superseded"]),
  };
  if (!allowedNextStatuses[parent.status]?.has(child.status)) {
    return false;
  }
  if (
    ["published", "superseded"].includes(parent.status) ||
    parent.status === child.status
  ) {
    return canonicalJson(parent) === canonicalJson(child);
  }
  if (
    jsonDigest(immutableChangesetPayload(parent)) !==
    jsonDigest(immutableChangesetPayload(child)) ||
    canonicalJson(parent.writer_audit_provenance) !==
      canonicalJson(child.writer_audit_provenance)
  ) {
    return false;
  }
  const childPhases = new Map(
    writerLifecyclePhases(child).map((phase) => [
      phase.name,
      phase,
    ]),
  );
  return writerLifecyclePhases(parent).every((phase) => {
    if (!phase.occurred && phase.evidence === undefined) return true;
    const childPhase = childPhases.get(phase.name);
    return (
      childPhase?.occurred === true &&
      canonicalJson(
        writerLifecycleAuditSubtree(parent, phase.name),
      ) ===
        canonicalJson(
          writerLifecycleAuditSubtree(child, phase.name),
        ) &&
      canonicalJson(childPhase.evidence) ===
        canonicalJson(phase.evidence)
    );
  });
}

function authenticatedHistoryIsContinuous(
  changesetId,
  authenticatedRecords,
  current,
) {
  if (
    historicalChangesets.head === null ||
    current.writer_audit_provenance === undefined
  ) {
    return false;
  }
  const recordIntroductions = new Set(
    allChangesetIntroductions(changesetId),
  );
  if (recordIntroductions.size !== 1) return false;
  const authenticatedReferences = new Set(
    authenticatedRecords.map(({ reference }) => reference),
  );
  const introductions = new Set();
  for (const reference of authenticatedReferences) {
    const inheritedFromParent = revisionParents(reference).some(
      (parent) => {
        const parentRecord = changesetAtReference(
          parent,
          changesetId,
        );
        return (
          parentRecord !== null &&
          (parentRecord.value.writer_audit_provenance !== undefined ||
            changesetHasWriterAuditEvidence(parentRecord.value))
        );
      },
    );
    if (!inheritedFromParent) introductions.add(reference);
  }
  if (introductions.size !== 1) return false;
  const [introduction] = introductions;
  const [recordIntroduction] = recordIntroductions;
  const provenanceMode = current.writer_audit_provenance.mode;
  if (
    (provenanceMode === "authenticated" &&
      introduction !== recordIntroduction) ||
    (provenanceMode === "legacy-transition" &&
      introduction === recordIntroduction) ||
    !["authenticated", "legacy-transition"].includes(provenanceMode)
  ) {
    return false;
  }
  const references = [
    ...new Set([
      introduction,
      historicalChangesets.head,
      ...(
        historicalChangesets.touchedReferencesById.get(changesetId) ??
        []
      ),
    ]),
  ];
  if (references.length === 0) return false;
  for (const reference of references) {
    const record = changesetAtReference(reference, changesetId);
    const authenticatedParents = revisionParents(reference)
      .map((parentReference) => ({
        parentReference,
        record: changesetAtReference(
          parentReference,
          changesetId,
        ),
      }))
      .filter(
        ({ record: parentRecord }) =>
          parentRecord !== null &&
          (parentRecord.value.writer_audit_provenance !== undefined ||
            changesetHasWriterAuditEvidence(parentRecord.value)),
      );
    const recordIsAuthenticated =
      record !== null &&
      (record.value.writer_audit_provenance !== undefined ||
        changesetHasWriterAuditEvidence(record.value));
    if (
      reference !== introduction &&
      !recordIsAuthenticated &&
      authenticatedParents.length === 0
    ) {
      continue;
    }
    if (
      record === null ||
      !recordPathMatchesLifecycleStatus(record) ||
      !authenticatedSnapshotIsSelfBound(record.value, current)
    ) {
      return false;
    }
    for (const { record: parentRecord } of authenticatedParents) {
      if (
        !recordPathMatchesLifecycleStatus(parentRecord) ||
        !authenticatedSnapshotIsSelfBound(
          parentRecord.value,
          current,
        ) ||
        !authenticatedLifecycleTransitionIsMonotonic(
          parentRecord.value,
          record.value,
        )
      ) {
        return false;
      }
    }
  }
  const headRecord = changesetAtReference(
    historicalChangesets.head,
    changesetId,
  );
  return (
    headRecord !== null &&
    authenticatedLifecycleTransitionIsMonotonic(
      headRecord.value,
      current,
    )
  );
}

if (historicalChangesets.available) {
  for (const [changesetId, records] of historicalChangesets.recordsById) {
    const authenticatedRecords = records.filter(
      ({ value }) =>
        value.writer_audit_provenance !== undefined ||
        changesetHasWriterAuditEvidence(value),
    );
    const current = currentChangesetsById.get(changesetId);
    if (authenticatedRecords.length === 0) {
      if (
        current?.writer_audit_provenance?.mode ===
          "authenticated" ||
        (current !== undefined &&
          changesetHasWriterAuditEvidence(current) &&
          current.writer_audit_provenance?.mode !==
            "legacy-transition")
      ) {
        failures.push(
          `authenticated changeset ${changesetId} cannot relabel a pre-existing unauthenticated Git record as a new authenticated creation`,
        );
      }
      continue;
    }
    if (!current) {
      failures.push(
        `authenticated changeset ${changesetId} must not be deleted from canonical audit history`,
      );
      continue;
    }
    if (current.writer_audit_provenance === undefined) {
      failures.push(
        `authenticated changeset ${changesetId} must retain writer_audit_provenance`,
      );
      continue;
    }
    const currentIdentity = provenanceIdentity(
      current.writer_audit_provenance,
    );
    if (
      !authenticatedHistoryIsContinuous(
        changesetId,
        authenticatedRecords,
        current,
      )
    ) {
      failures.push(
        `authenticated changeset ${changesetId} must remain continuously present on one canonical audit path with self-bound provenance and a monotonic lifecycle`,
      );
    }
    for (const { reference, path, value } of authenticatedRecords) {
      if (value.writer_audit_provenance === undefined) {
        failures.push(
          `${reference}:${path}: authenticated writer evidence predates immutable provenance and cannot be relabeled as legacy`,
        );
        continue;
      }
      if (
        provenanceIdentity(value.writer_audit_provenance) !== currentIdentity
      ) {
        failures.push(
          `authenticated changeset ${changesetId} must retain its original writer_audit_provenance`,
        );
      }
      const currentPhases = new Map(
        writerLifecyclePhases(current).map((phase) => [phase.name, phase]),
      );
      for (const historicalPhase of writerLifecyclePhases(value)) {
        if (historicalPhase.evidence === undefined) continue;
        const currentEvidence =
          currentPhases.get(historicalPhase.name)?.evidence;
        if (
          currentEvidence === undefined ||
          canonicalJson(currentEvidence) !==
            canonicalJson(historicalPhase.evidence)
        ) {
          failures.push(
            `authenticated changeset ${changesetId} must retain its ${historicalPhase.name} runtime authorization`,
          );
        }
      }
    }
  }

  for (const [changesetId, records] of historicalChangesets.recordsById) {
    const localRecords = records.filter(
      ({ value }) =>
        value.local_publish?.schema_version ===
          "companiesascode.mission_control.local_publish.v1" &&
        value.local_publish?.writer_mode === "local-principal-v1",
    );
    const current = currentChangesetsById.get(changesetId);
    if (localRecords.length === 0) {
      if (
        current?.local_publish?.writer_mode ===
        "local-principal-v1" &&
        records.length > 0
      ) {
        failures.push(
          `local Principal changeset ${changesetId} cannot relabel a pre-existing Git record`,
        );
      }
      continue;
    }
    if (!current) {
      failures.push(
        `local Principal changeset ${changesetId} must not be deleted from canonical audit history`,
      );
      continue;
    }
    if (
      current.local_publish?.writer_mode !==
      "local-principal-v1"
    ) {
      failures.push(
        `local Principal changeset ${changesetId} must retain local_publish evidence`,
      );
      continue;
    }
    for (const { value } of localRecords) {
      if (canonicalJson(value) !== canonicalJson(current)) {
        failures.push(
          `local Principal changeset ${changesetId} is terminal audit history and must remain immutable`,
        );
        break;
      }
    }
  }
}
const supersessionGraph = new Map();
for (const { file, value } of supersededChangesets) {
  const replacementId = value.supersession?.replacement_changeset_id;
  if (replacementId && !seenChangesetIds.has(replacementId)) {
    failures.push(`${file}: replacement changeset does not exist: ${replacementId}`);
  }
  if (typeof value.id === "string" && replacementId) {
    supersessionGraph.set(value.id, replacementId);
  }
}
const visitedSupersessions = new Set();
const activeSupersessions = new Set();
function visitSupersession(id, trail = []) {
  if (activeSupersessions.has(id)) {
    failures.push(`changeset supersession cycle: ${[...trail, id].join(" -> ")}`);
    return;
  }
  if (visitedSupersessions.has(id)) return;
  visitedSupersessions.add(id);
  activeSupersessions.add(id);
  const replacementId = supersessionGraph.get(id);
  if (replacementId && supersessionGraph.has(replacementId)) {
    visitSupersession(replacementId, [...trail, id]);
  }
  activeSupersessions.delete(id);
}
for (const id of supersessionGraph.keys()) {
  visitSupersession(id);
}

if (failures.length) {
  console.error("Mission Control data validation failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log("Mission Control data validation OK");
