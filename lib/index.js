// src/host/index.js
import z from "@deepseek-ai/schemastery";
import { readdir as readdir7 } from "node:fs/promises";
import { join as join12 } from "node:path";

// src/host/task/audit-log.js
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFile, readFile, rename, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
var AUDIT_FILE = "worktree-space-log.jsonl";
var MAX_BYTES = 10 * 1024 * 1024;
var STDERR_LIMIT = 2048;
var ARGV_LIMIT = 512;
var STACK_LIMIT = 4e3;
var MESSAGE_LIMIT = 2e3;
function localStamp(date = /* @__PURE__ */ new Date()) {
  const two = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}
var READ_ONLY_SUBCOMMANDS = /* @__PURE__ */ new Set([
  "cat-file",
  "check-ignore",
  "config",
  "diff",
  "for-each-ref",
  "log",
  "ls-files",
  "merge-base",
  "rev-list",
  "rev-parse",
  "show-ref",
  "status",
  "symbolic-ref",
  "var",
  "version"
]);
function firstLine(text) {
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (line.trim() !== "") return truncate(redact(line.trim()), MESSAGE_LIMIT);
  }
  return "";
}
var scope = new AsyncLocalStorage();
function auditEnter(fields) {
  const carried = {};
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (typeof value === "string" && value.trim() !== "") carried[key] = value.trim();
  }
  scope.enterWith({ ...scope.getStore() ?? {}, ...carried });
}
var overridden = true;
var reader = null;
function setAuditEnabledReader(read) {
  reader = typeof read === "function" ? read : null;
}
function auditEnabled() {
  if (reader) return reader();
  return overridden;
}
function truncate(value, limit) {
  const text = String(value ?? "");
  return text.length <= limit ? text : `${text.slice(0, limit)}... (${text.length - limit} more characters)`;
}
var URL_CREDENTIALS = /\/\/[^\/\s@]*@/g;
var ASSIGNED_SECRET = /((?:token|password|passwd|secret|authorization|api[-_]?key)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\r\n,;]+)/gi;
function redact(value) {
  return String(value ?? "").replace(URL_CREDENTIALS, "//***@").replace(ASSIGNED_SECRET, "$1***");
}
async function auditRecord(kind, level, fields) {
  try {
    if (!auditEnabled()) return;
    const carried = scope.getStore() ?? {};
    const tasksRoot = typeof carried.tasksRoot === "string" ? carried.tasksRoot.trim() : "";
    if (tasksRoot === "") return;
    const line = `${JSON.stringify({
      ts: localStamp(),
      kind,
      level,
      op: carried.op ?? "",
      task: carried.task ?? "",
      project: carried.project ?? "",
      ...fields
    })}
`;
    const path = join(tasksRoot, AUDIT_FILE);
    const size = await stat(path).then((info) => info.size, () => 0);
    if (size >= MAX_BYTES) await rotate(path);
    await appendFile(path, line, "utf8");
  } catch {
  }
}
async function rotate(path) {
  const stamp = localStamp().replace(/[: ]/g, "-");
  await rename(path, join(dirname(path), `${basename(path, extname(path))}.${stamp}${extname(path)}`));
}
function gitRecordCode(stderr) {
  const text = String(stderr ?? "");
  if (/not a git repository/i.test(text)) return "E3004";
  if (/is not a working tree|No such file or directory/i.test(text)) return "E3005";
  return "E3003";
}
function gitLevel(exitCode, signal, stdout, stderr) {
  if ((signal ?? null) !== null) return "error";
  if (exitCode === 0) return "info";
  return String(stderr ?? "").trim() === "" && String(stdout ?? "").trim() === "" ? "info" : "error";
}
async function recordGitCall({ cwd, args, exitCode, signal, stdout = "", stderr = "", ms }) {
  const argv = Array.isArray(args) ? args.map((one) => truncate(redact(one), ARGV_LIMIT)) : [];
  const failed = exitCode !== 0 || (signal ?? null) !== null;
  if (!failed && READ_ONLY_SUBCOMMANDS.has(String(argv[0] ?? ""))) return;
  const level = gitLevel(exitCode, signal, stdout, stderr);
  const complaint = firstLine(stderr) || firstLine(stdout);
  await auditRecord("git", level, {
    cwd: typeof cwd === "string" ? cwd : "",
    argv,
    ...level === "error" ? {
      // The same code `runGit` puts on the error it throws, from the same
      // stderr, so a git record and whatever caught the failure name the
      // same condition and `grep` for it lands on both.
      code: gitRecordCode(stderr),
      msg: complaint ? `This git command failed, so whatever it was for did not happen: ${complaint}` : "This git command failed without saying why, so whatever it was for may not have happened."
    } : {},
    exit: typeof exitCode === "number" ? exitCode : null,
    ...signal ? { signal } : {},
    ...failed ? { stderr: truncate(redact(stderr), STDERR_LIMIT), stdout: truncate(redact(stdout), STDERR_LIMIT) } : {},
    ...typeof ms === "number" ? { ms } : {}
  });
}
async function recordEvent(level, message, fields = {}) {
  const severity = level === "error" ? "error" : level === "warn" ? "warn" : "info";
  await auditRecord("event", severity, {
    ...fields,
    msg: truncate(redact(String(message ?? "")), MESSAGE_LIMIT)
  });
}
async function recordError(error, fields = {}) {
  const decided = fields.code ?? error?.code;
  await auditRecord("error", "error", {
    ...fields,
    ...error instanceof Error ? { name: error.name } : {},
    message: truncate(redact(String(error?.message ?? error)), MESSAGE_LIMIT),
    ...decided === void 0 ? {} : { code: decided },
    ...typeof error?.stack === "string" ? { stack: truncate(redact(error.stack), STACK_LIMIT) } : {}
  });
}
async function recordWarning(message, fields = {}) {
  await auditRecord("warning", "warn", {
    ...fields,
    message: truncate(redact(String(message ?? "")), MESSAGE_LIMIT)
  });
}

// src/host/task/codes.js
var ERROR_CODES = {
  // --- E1xxx container and isolation --------------------------------------
  E1001: "paths.js - the tasks root is the repositories directory itself",
  E1002: "paths.js, add.js - the container, or the task space, is inside a repository",
  E1003: "paths.js, add.js - the container, or the task space, holds a repository",
  E1004: "paths.js, container.js, archive.js, inspect.js, add.js - the tasks root is missing or empty",
  E1005: "container.js - the tasks root was refused on creation",
  // --- E2xxx task space lifecycle -----------------------------------------
  E2001: "create.js - the task name is taken by a different task space",
  E2002: "create.js - the task space is this task own, left before its Workspace was registered",
  E2003: "archive.js, add.js - no task space at that path",
  E2004: "archive.js, add.js - the task space holds no git worktrees",
  E2005: "create.js, add.js - creating or extending failed with no code of its own, and everything was rolled back",
  E2006: "create.js, add.js - creating or extending failed with no code of its own, and the rollback left something behind",
  // --- E3xxx git and branches ---------------------------------------------
  E3001: "create.js, add.js - the branch to cut the worktree from is already in use",
  E3002: "create.js, add.js - the requested base ref does not exist in that repository",
  E3003: "git.js - a git command failed, for any reason not covered below",
  E3004: "git.js - the directory is not a git repository",
  E3005: "git.js - the worktree checkout has gone",
  // --- E4xxx arguments and validation -------------------------------------
  E4001: "create.js, add.js - no repository was selected",
  E4002: "create.js, add.js - two repositories in one task share a name",
  E4003: "index.js - the task name is missing",
  E4004: "index.js - the source root is missing",
  E4005: "index.js, add.js - a path is required, either a worktree, a task space or a repository",
  E4006: "index.js - the workspace scan hit its directory limit",
  E4007: "archive.js - deleting an unmerged branch was not forced",
  E4008: "archive.js - the merge target is unusable",
  E4009: "naming.js - the task name or branch prefix is not usable",
  E4010: "delivery.js - a delivery policy value is not one of the allowed ones",
  // --- E5xxx finishing and merging ----------------------------------------
  E5001: "archive.js - a merge is still standing, so nothing was finished",
  E5002: "archive.js - finishing did not complete for every repository",
  E5003: "archive.js - one repository could not be finished and needs another attempt",
  E5004: "archive.js - the source checkout has uncommitted work the merge would overwrite",
  E5005: "deploy.js - the delivery policy requires a deployment before a merge, and none was recorded",
  E5006: "deploy.js - the last deployment smoke did not pass, so the merge is refused",
  E5007: "deploy.js - the delivery policy waits for a human acceptance ack, so the merge is refused",
  E5008: "deploy.js - the deploy script is missing, or it failed while rebuilding the environment",
  E5009: "deploy.js - the delivery policy names a deploy target the manifest does not offer",
  E5010: "deploy.js - the deploy manifest exists but cannot be parsed, so no target can be trusted",
  // --- E6xxx scanning and discovery ---------------------------------------
  E6001: "discover.js, add.js - a candidate directory is not a source repository",
  E6002: "index.js - a workspace was not selected",
  // --- E7xxx the package itself -------------------------------------------
  E7001: "skill.js - the package root for the bundled skill cannot be located",
  E7002: "skill.js - a bundled skill file has no YAML frontmatter",
  E7003: "skill.js - a bundled skill file declares no description",
  E7004: "skill.js - a bundled skill file declares a name that is not the one served",
  E7005: "tool.js - an unknown action was asked for",
  E7006: "tool.js - a required argument for an action is missing",
  E7007: "tool.js - an irreversible action was asked for through a tool call, where it is not the user's own decision"
};
var UNKNOWN = "E9001";
function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  error.withMsg = (sentence) => {
    error.msg = sentence;
    return error;
  };
  return error;
}

// src/host/task/deploy.js
import { existsSync } from "node:fs";
import { readFile as readFile3, readdir as readdir2, writeFile as writeFile2 } from "node:fs/promises";
import { join as join4 } from "node:path";

// src/host/task/delivery.js
var DEPLOY_TARGETS = ["docker", "host", "none"];
var DEPLOY_MODES = ["auto", "on-request"];
var VERIFICATION_MODES = ["agent", "agent-then-human", "human"];
var MERGE_MODES = ["auto", "ask", "never"];
var CONFLICT_MODES = ["agent-auto", "ask", "stop"];
var STRAY_MODES = ["archive", "keep", "discard"];
var DEFAULT_DELIVERY_POLICY = Object.freeze({
  version: 1,
  deploy: Object.freeze({ target: "none", mode: "on-request" }),
  verification: "agent-then-human",
  merge: Object.freeze({ mode: "ask", target: null, deleteBranch: true }),
  conflicts: "ask",
  strays: "keep"
});
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function oneOf(list, value, field, { strict }) {
  if (value === void 0 || value === null || `${value}`.trim() === "") return void 0;
  const text = String(value).trim();
  if (list.includes(text)) return text;
  if (strict) throw coded("E4010", `'${text}' is not a valid ${field}; expected one of: ${list.join(", ")}`);
  return void 0;
}
function mergeTarget(value, { strict }) {
  if (value === void 0 || value === null) return void 0;
  const text = String(value).trim();
  if (text === "") return null;
  if (text.includes("/") || text.includes("\\") || text.includes(" ")) {
    if (strict) throw coded("E4010", `'${text}' is not a usable merge target branch name`);
    return void 0;
  }
  return text;
}
function buildPolicy(input, { strict }) {
  const source = isPlainObject(input) ? input : {};
  const sourceDeploy = isPlainObject(source.deploy) ? source.deploy : {};
  const sourceMerge = isPlainObject(source.merge) ? source.merge : {};
  const target = oneOf(DEPLOY_TARGETS, sourceDeploy.target, "deploy.target", { strict }) ?? DEFAULT_DELIVERY_POLICY.deploy.target;
  const deployMode = oneOf(DEPLOY_MODES, sourceDeploy.mode, "deploy.mode", { strict }) ?? DEFAULT_DELIVERY_POLICY.deploy.mode;
  const verification = oneOf(VERIFICATION_MODES, source.verification, "verification", { strict }) ?? DEFAULT_DELIVERY_POLICY.verification;
  const mergeMode = oneOf(MERGE_MODES, sourceMerge.mode, "merge.mode", { strict }) ?? DEFAULT_DELIVERY_POLICY.merge.mode;
  const conflicts = oneOf(CONFLICT_MODES, source.conflicts, "conflicts", { strict }) ?? DEFAULT_DELIVERY_POLICY.conflicts;
  const strays = oneOf(STRAY_MODES, source.strays, "strays", { strict }) ?? DEFAULT_DELIVERY_POLICY.strays;
  const mergeTargetValue = mergeTarget(sourceMerge.target, { strict }) ?? DEFAULT_DELIVERY_POLICY.merge.target;
  const deleteBranch = sourceMerge.deleteBranch === void 0 ? DEFAULT_DELIVERY_POLICY.merge.deleteBranch : sourceMerge.deleteBranch === true;
  return {
    version: 1,
    deploy: { target, mode: deployMode },
    verification,
    merge: { mode: mergeMode, target: mergeTargetValue, deleteBranch },
    conflicts,
    strays
  };
}
function normalizeDeliveryPolicy(input) {
  return buildPolicy(input, { strict: true });
}
function coerceDeliveryPolicy(input) {
  return buildPolicy(input, { strict: false });
}
function deliveryPolicyOf(metadata) {
  return coerceDeliveryPolicy(isPlainObject(metadata) ? metadata.delivery : void 0);
}
function resolveDeliveryPolicy(project, explicit, defaults = {}) {
  const stored = isPlainObject(defaults) ? defaults[project] : void 0;
  const chosen = explicit !== void 0 && explicit !== null ? explicit : stored;
  return chosen === void 0 || chosen === null ? coerceDeliveryPolicy(void 0) : normalizeDeliveryPolicy(chosen);
}
function applyStraysPolicy(policy, request, archive, taskPath) {
  const cleanStray = request.cleanStray === true;
  const discardDocuments = request.discardDocuments === true;
  const documentsDirectory = typeof request.documentsDirectory === "string" ? request.documentsDirectory.trim() : "";
  const keep = Array.isArray(request.keep) ? request.keep : [];
  const callerDecided = cleanStray || discardDocuments || documentsDirectory !== "" || keep.length > 0;
  if (policy.strays === "discard" && request.force === true) {
    return { cleanStray: true, discardDocuments: true, documentsDirectory: "" };
  }
  if (callerDecided || policy.strays !== "archive") {
    return { cleanStray, discardDocuments, documentsDirectory };
  }
  const strategy = archive && archive.strategy === "custom" && String(archive.directory ?? "").trim() !== "" ? String(archive.directory).trim() : containerRootOf(taskPath);
  const now = /* @__PURE__ */ new Date();
  const pad = (value) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const parts = String(taskPath).split(/[\\/]+/).filter((part) => part !== "");
  const task = parts[parts.length - 1] ?? "task";
  const project = parts[parts.length - 2] ?? "project";
  const root = String(strategy).replace(/[\\/]+$/, "");
  return {
    cleanStray: true,
    discardDocuments: false,
    documentsDirectory: `${root}\\archived-docs\\${project}\\${task}-${stamp}`
  };
}
function containerRootOf(taskPath) {
  const parts = String(taskPath ?? "").split(/[\\/]+/).filter((part) => part !== "");
  const up = parts.slice(0, -2).join("\\");
  return up === "" ? "." : up;
}

// src/host/task/shared.js
import { readdir, readFile as readFile2, stat as stat2, writeFile } from "node:fs/promises";
import { join as join3 } from "node:path";

// src/host/task/git.js
function gitFailureCode(stderr) {
  const text = String(stderr ?? "");
  if (/not a git repository/i.test(text)) return "E3004";
  if (/is not a working tree|No such file or directory/i.test(text)) return "E3005";
  return "E3003";
}
async function runGit(subprocess, cwd, args, { log = true } = {}) {
  const handle = subprocess.spawn({
    argv: ["git", "-C", cwd, ...args],
    cwd,
    stdio: {
      stdin: "ignore",
      stdout: { maxBytes: 2 * 1024 * 1024 },
      stderr: { maxBytes: 512 * 1024 }
    },
    graceMs: 1e3
  });
  const startedAt = Date.now();
  const outcome = await handle.done;
  const stdout = handle.collected.stdout?.readFrom(0).text ?? "";
  const stderr = handle.collected.stderr?.readFrom(0).text ?? "";
  if (log || outcome.exitCode !== 0 || (outcome.signal ?? null) !== null) {
    await recordGitCall({
      cwd,
      args,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      stdout,
      stderr,
      ms: Date.now() - startedAt
    });
  }
  if (outcome.exitCode !== 0 || outcome.signal !== null) {
    const error = new Error(`git ${args.join(" ")} failed${outcome.signal ? ` (${outcome.signal})` : ` (exit ${outcome.exitCode})`}: ${stderr.trim() || stdout.trim()}`);
    error.code = gitFailureCode(stderr);
    throw error;
  }
  return stdout.trim();
}
async function tryRunGit(subprocess, cwd, args, options) {
  try {
    return await runGit(subprocess, cwd, args, options);
  } catch {
    return "";
  }
}
async function gitSucceeded(subprocess, cwd, args, options) {
  try {
    await runGit(subprocess, cwd, args, options);
    return true;
  } catch {
    return false;
  }
}
async function detectDefaultBranch(subprocess, repoPath, worktrees) {
  const [remoteHead, refsOutput] = await Promise.all([
    tryRunGit(subprocess, repoPath, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]),
    tryRunGit(subprocess, repoPath, ["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes/origin"])
  ]);
  const refs = new Set(refsOutput.split(/\r?\n/).filter(Boolean));
  if (remoteHead) {
    const separator = remoteHead.indexOf("/");
    const name3 = separator >= 0 ? remoteHead.slice(separator + 1) : "";
    if (name3) return { name: name3, ref: refs.has(name3) ? name3 : remoteHead };
  }
  for (const name3 of ["main", "master", "trunk", "develop"]) {
    if (refs.has(name3)) return { name: name3, ref: name3 };
    if (refs.has(`origin/${name3}`)) return { name: name3, ref: `origin/${name3}` };
  }
  const name2 = worktrees.find((worktree) => worktree.isMain)?.branch ?? worktrees.find((worktree) => worktree.branch)?.branch;
  return name2 ? { name: name2, ref: name2 } : { name: "HEAD", ref: "HEAD" };
}
function parseWorktrees(text) {
  const rows = [];
  let current;
  const push = () => {
    if (current?.path) rows.push(current);
    current = void 0;
  };
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      push();
      current = { path: line.slice(9).trim() };
    } else if (current && line.startsWith("HEAD ")) {
      current.head = line.slice(5).trim();
    } else if (current && line.startsWith("branch ")) {
      const ref = line.slice(7).trim();
      current.branch = ref.startsWith("refs/heads/") ? ref.slice(11) : ref;
    } else if (current && line === "detached") {
      current.detached = true;
    } else if (current && line.startsWith("locked")) {
      current.locked = true;
    } else if (current && line.startsWith("prunable")) {
      current.prunable = true;
    }
  }
  push();
  return rows.map((row, index) => ({
    path: row.path,
    branch: row.branch,
    head: row.head,
    isMain: index === 0,
    detached: row.detached === true,
    locked: row.locked === true,
    prunable: row.prunable === true
  }));
}

// src/host/task/naming.js
import { basename as basename2, resolve } from "node:path";
var DEFAULT_BRANCH_PREFIX = "task/";
var TaskNameError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "TaskNameError";
    this.code = "E4009";
  }
};
var FORBIDDEN = /[/\\\s]/;
var FORBIDDEN_IN_PROJECT = /[/\\]/;
var ILLEGAL_BRANCH_CHARACTERS = /[\s~^:?*\[\]\\\u0000-\u001f\u007f]/;
function validateTaskName(task) {
  const name2 = String(task ?? "");
  if (name2 === "") throw new TaskNameError("a task name is required");
  if (name2 === "." || name2 === "..") throw new TaskNameError(`task name must not be '.' or '..': ${name2}`);
  if (FORBIDDEN.test(name2)) {
    throw new TaskNameError(`task name must not contain /, \\ or whitespace: ${name2}`);
  }
  return name2;
}
function validateProjectName(project) {
  const name2 = String(project ?? "");
  if (name2 === "") throw new TaskNameError("a project name is required");
  if (name2 === "." || name2 === "..") throw new TaskNameError(`project name must not be '.' or '..': ${name2}`);
  if (FORBIDDEN_IN_PROJECT.test(name2)) throw new TaskNameError(`project name must not contain / or \\: ${name2}`);
  return name2;
}
function projectNameFor(sourceRoot) {
  return validateProjectName(basename2(resolve(String(sourceRoot ?? ""))));
}
function validateBranchPrefix(prefix) {
  const value = String(prefix ?? "").trim();
  if (value === "") return DEFAULT_BRANCH_PREFIX;
  if (ILLEGAL_BRANCH_CHARACTERS.test(value)) {
    throw new TaskNameError(`branch prefix must not contain whitespace or any of ~ ^ : ? * [ ] \\ : ${value}`);
  }
  if (value.includes("..")) throw new TaskNameError(`branch prefix must not contain '..': ${value}`);
  if (value.includes("@{")) throw new TaskNameError(`branch prefix must not contain '@{': ${value}`);
  if (value.includes("//")) throw new TaskNameError(`branch prefix must not contain an empty path segment: ${value}`);
  if (value.startsWith("/") || value.startsWith("-")) {
    throw new TaskNameError(`branch prefix must not start with '/' or '-': ${value}`);
  }
  return value;
}
function branchNameFor(task, prefix = DEFAULT_BRANCH_PREFIX) {
  return `${prefix}${task}`;
}
function deploymentEnvIdFor(project, task) {
  const slug = (value, fallback) => {
    const folded = String(value ?? "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
    return folded === "" ? fallback : folded;
  };
  return ["dsh", slug(project, "project"), slug(task, "task")].join("-");
}

// src/host/task/paths.js
import { dirname as dirname2, join as join2, parse, resolve as resolve2 } from "node:path";
import { lstatSync } from "node:fs";
var CASE_INSENSITIVE = process.platform === "win32";
function canonicalPath(value) {
  const unified = String(value ?? "").replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  if (unified === "") return "/";
  return CASE_INSENSITIVE ? unified.toLowerCase() : unified;
}
function samePathLocation(left, right) {
  return canonicalPath(left) === canonicalPath(right);
}
function isInside(parent, child) {
  const outer = canonicalPath(parent);
  const inner = canonicalPath(child);
  if (outer === inner) return false;
  return inner.startsWith(outer.endsWith("/") ? outer : `${outer}/`);
}
var IsolationError = class extends Error {
  constructor(code, message) {
    super(message);
    this.name = "IsolationError";
    this.code = code;
  }
};
function assertIsolated(sourceRoot, tasksRoot) {
  if (samePathLocation(sourceRoot, tasksRoot)) {
    throw new IsolationError("E1001", `the tasks root must not be the repositories' directory itself: ${sourceRoot}`);
  }
  if (isInside(sourceRoot, tasksRoot)) {
    throw new IsolationError(
      "E1002",
      `the tasks root ${tasksRoot} is inside the repositories' directory ${sourceRoot}
  work and source must be isolated; put the container beside that directory`
    );
  }
  if (isInside(tasksRoot, sourceRoot)) {
    throw new IsolationError(
      "E1003",
      `the tasks root ${tasksRoot} contains the repositories' directory ${sourceRoot}
  work and source must be isolated; put the container beside that directory`
    );
  }
}
var FenceError = class extends Error {
  constructor(code, message) {
    super(message);
    this.name = "FenceError";
    this.code = code;
  }
};
function assertInsideContainer(tasksRoot, target, what = "this path") {
  const root = canonicalPath(tasksRoot);
  const inner = canonicalPath(target);
  const inside = inner.startsWith(root.endsWith("/") ? root : `${root}/`);
  if (!inside) {
    throw new FenceError("E1005", `${what} is outside the container root and will not be deleted: ${target}
  the container root is ${tasksRoot}`);
  }
}
function assertTaskSpaceShape(tasksRoot, taskPath) {
  const rest = canonicalPath(taskPath).slice(canonicalPath(tasksRoot).replace(/\/+$/, "").length);
  const segments = rest.split("/").filter((segment) => segment !== "");
  if (segments.length !== 2 || segments.some((segment) => segment === "." || segment === "..")) {
    throw new FenceError("E1005", `a task space must be <container root>/<project>/<task>; this path is not one and will not be deleted: ${taskPath}`);
  }
}
function refuseDelete(tasksRoot, target, what = "this path") {
  try {
    assertInsideContainer(tasksRoot, target, what);
    assertRealDirectory(target, what);
    return "";
  } catch (error) {
    return error instanceof FenceError ? error.message : `refusing to delete ${what}: ${target}`;
  }
}
function assertRealDirectory(path, what = "this directory") {
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    return;
  }
  if (stats.isSymbolicLink()) {
    throw new FenceError("E1005", `${what} is a link, not a directory, and will not be deleted: ${path}`);
  }
}
var CONTAINER_NAME = "worktree-space";
var CONTAINER_BACKUP_NAME = "dsh-worktree-space";
function containerIn(parent, sourceRoot) {
  const preferred = join2(parent, CONTAINER_NAME);
  const swallows = isInside(preferred, sourceRoot) || samePathLocation(preferred, sourceRoot);
  return swallows ? join2(parent, CONTAINER_BACKUP_NAME) : preferred;
}
function firstDirectoryBelowRoot(absolute, root) {
  const parts = absolute.slice(root.length).split(/[\\/]+/).filter(Boolean);
  return parts.length > 1 ? join2(root, parts[0]) : void 0;
}
function containerParentFor(absolute, root = parse(absolute).root) {
  const driveRoot = /^[A-Za-z]:[\\/]$/.test(root) ? root : void 0;
  const first = driveRoot === void 0 ? void 0 : firstDirectoryBelowRoot(absolute, root);
  if (first !== void 0) return first;
  return driveRoot === void 0 ? dirname2(absolute) : driveRoot;
}
function recommendTasksRoot(sourceRoot) {
  const absolute = resolve2(sourceRoot);
  return containerIn(containerParentFor(absolute), absolute);
}

// src/host/task/shared.js
var BREADCRUMB = "README.en.md";
var TASK_METADATA = "worktree-space.json";
var TASK_README = "worktree-space.md";
var TASK_OWNED_FILES = [TASK_METADATA, TASK_README, BREADCRUMB];
async function isLinkedWorktree(directory) {
  try {
    return (await stat2(join3(directory, ".git"))).isFile();
  } catch {
    return false;
  }
}
function resolveTasksRoot(sourceRoot, requestedRoot, configuredRoot) {
  const requested = typeof requestedRoot === "string" ? requestedRoot.trim() : "";
  if (requested !== "") return requested;
  const configured = typeof configuredRoot === "string" ? configuredRoot.trim() : "";
  return configured === "" ? recommendTasksRoot(sourceRoot) : configured;
}
function taskSpacePath(tasksRoot, project, task) {
  const root = String(tasksRoot ?? "").trim();
  const path = join3(root, validateProjectName(project), validateTaskName(task));
  assertTaskSpaceShape(root, path);
  return path;
}
async function listTaskWorktrees(subprocess, taskPath) {
  let entries;
  try {
    entries = await readdir(taskPath, { withFileTypes: true });
  } catch {
    return [];
  }
  const repositories = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const worktreePath = join3(taskPath, entry.name);
    if (!await isLinkedWorktree(worktreePath)) continue;
    const branch = await tryRunGit(subprocess, worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const status = await tryRunGit(subprocess, worktreePath, ["status", "--porcelain"]);
    repositories.push({
      name: entry.name,
      path: worktreePath,
      branch: branch === "" ? void 0 : branch,
      changedFiles: status === "" ? 0 : status.split(/\r?\n/).filter(Boolean).length
    });
  }
  return repositories;
}
function taskMetadata(details) {
  const { task, project, tasksRoot, sourceRoot, branch, baseRef, repositories = [], delivery } = details;
  return {
    version: 1,
    task,
    project,
    tasksRoot,
    sourceRoot,
    branch,
    baseRef: baseRef === void 0 || `${baseRef}`.trim() === "" ? null : `${baseRef}`,
    deploymentEnvId: deploymentEnvIdFor(project, task),
    delivery: coerceDeliveryPolicy(delivery),
    createdAt: (/* @__PURE__ */ new Date()).toISOString(),
    repositories: repositories.map((entry) => ({
      name: entry.name,
      sourcePath: entry.sourcePath,
      ...entry.sourceBranch === void 0 ? {} : { sourceBranch: entry.sourceBranch },
      ...entry.startCommit === void 0 ? {} : { startCommit: entry.startCommit },
      branch: entry.branch ?? branch
    }))
  };
}
async function readTaskMetadata(taskPath) {
  const text = await readFile2(join3(taskPath, TASK_METADATA), "utf8").catch(() => "");
  if (text.trim() !== "") {
    try {
      const parsed = JSON.parse(text);
      if (parsed !== null && typeof parsed === "object" && typeof parsed.task === "string" && parsed.task !== "") {
        return parsed;
      }
    } catch {
    }
  }
  const legacy = await parseLegacyBreadcrumb(taskPath);
  return legacy === void 0 ? void 0 : { version: 0, ...legacy };
}
async function parseLegacyBreadcrumb(taskPath) {
  const text = await readFile2(join3(taskPath, BREADCRUMB), "utf8").catch(() => "");
  if (text.trim() === "") return void 0;
  const task = /^#\s*Task:\s*(.+)$/m.exec(text)?.[1]?.trim();
  if (task === void 0 || task === "") return void 0;
  const branch = /^-\s*Branch:\s*`([^`]+)`/m.exec(text)?.[1]?.trim();
  const sourceRoot = /^-\s*Source root:\s*`([^`]+)`/m.exec(text)?.[1]?.trim();
  return {
    task,
    ...branch === void 0 || branch === "" ? {} : { branch },
    ...sourceRoot === void 0 || sourceRoot === "" ? {} : { sourceRoot }
  };
}
function renderTaskMetadata(metadata) {
  const { task, project, branch, baseRef, createdAt, sourceRoot, repositories = [], deploymentEnvId, delivery } = metadata;
  const lines = [
    `# Task: ${task}`,
    "",
    ...typeof project === "string" && project !== "" ? [`- Project: \`${project}\``] : [],
    `- Branch: \`${branch}\` (one branch per repository below)`,
    `- Base: ${baseRef === void 0 || baseRef === null || `${baseRef}`.trim() === "" ? "each repository's current HEAD" : `\`${baseRef}\``}`,
    ...typeof createdAt === "string" && createdAt !== "" ? [`- Created: ${createdAt}`] : [],
    `- Source root: \`${sourceRoot}\``,
    "- This folder is the agent session working directory.",
    "- The facts above are stored in `worktree-space.json`; this file is generated from it.",
    "",
    "## Repositories",
    ...repositories.map((entry) => `- \`${entry.name}\``),
    "",
    "## Conventions",
    "- Commit in each repository separately (the same branch name everywhere).",
    "- Source repositories are read-only: never edit or commit there.",
    "- Merging back to the main branch is the user's action, not the agent's.",
    "",
    ...typeof deploymentEnvId === "string" && deploymentEnvId !== "" ? [
      "## Deployment",
      "- If this space holds deployable services \u2014 a repository with its own `deploy/deploy.sh`, or a `deploy/` orchestration root beside the worktrees \u2014 deploy them to an isolated Docker environment rather than starting them on the host.",
      `- Environment id for this task: \`DSH_ENV_ID=${deploymentEnvId}\`. Pass it to every deploy command: it is what keeps this task's containers, images and acceptance URL apart from every other task's.`,
      "- `./deploy.sh up` builds and starts the environment and prints the acceptance URL; run `./deploy.sh smoke` and let it pass before handing the URL to the user.",
      "- `./deploy.sh status --json` is the machine-readable view; `./deploy.sh destroy` tears the environment down when acceptance is over.",
      ""
    ] : [],
    ...delivery === void 0 ? [] : [
      "## Delivery policy",
      `- Deploy: target \`${delivery.deploy.target}\` (${delivery.deploy.mode}).`,
      `- Verification: \`${delivery.verification}\`.`,
      `- Merge: \`${delivery.merge.mode}\` into ${delivery.merge.target === null ? "the branch each source repository has checked out" : `\`${delivery.merge.target}\``}, then ${delivery.merge.deleteBranch ? "delete" : "keep"} the task branch.`,
      `- Conflicts: \`${delivery.conflicts}\`. Strays: \`${delivery.strays}\`.`,
      "- `done` enforces this policy: a merge is refused while the deployment state has no passing smoke and, under agent-then-human, while the human acceptance ack is missing.",
      ""
    ]
  ];
  return lines.join("\n");
}
async function writeTaskMetadata(taskPath, metadata) {
  await writeFile(join3(taskPath, TASK_METADATA), `${JSON.stringify(metadata, null, 2)}
`, "utf8");
  await writeFile(join3(taskPath, TASK_README), renderTaskMetadata(metadata), "utf8");
}

// src/host/task/deploy.js
var STATE_NAME = ".state.json";
var DOCKER_MAX_BYTES = 512 * 1024;
async function runProcess(subprocess, argv, { cwd, maxBytes = DOCKER_MAX_BYTES } = {}) {
  const handle = subprocess.spawn({
    argv,
    cwd,
    stdio: { stdin: "ignore", stdout: { maxBytes }, stderr: { maxBytes } },
    graceMs: 1e3
  });
  const outcome = await handle.done;
  return {
    ok: outcome.exitCode === 0,
    exitCode: outcome.exitCode,
    stdout: handle.collected.stdout?.readFrom(0).text ?? "",
    stderr: handle.collected.stderr?.readFrom(0).text ?? ""
  };
}
async function runDocker(subprocess, args) {
  return runProcess(subprocess, ["docker", ...args], { cwd: process.cwd() });
}
async function tryDocker(subprocess, args) {
  try {
    return await runDocker(subprocess, args);
  } catch {
    return { ok: false, exitCode: null, stdout: "", stderr: "" };
  }
}
async function requireRecorded(taskPath) {
  const recorded = await readTaskMetadata(taskPath);
  if (recorded === void 0) throw coded("E2003", `no such task space: ${taskPath}`);
  return recorded;
}
async function deliveryStateFiles(taskPath) {
  const files = [];
  const entries = await readdir2(taskPath, { withFileTypes: true }).catch(() => []);
  const candidates = [join4(taskPath, "deploy", STATE_NAME)];
  for (const entry of entries) {
    if (entry.isDirectory()) candidates.push(join4(taskPath, entry.name, "deploy", STATE_NAME));
  }
  for (const path of candidates) {
    if (existsSync(path)) files.push(path);
  }
  return files;
}
async function readDeliveryState(taskPath) {
  for (const path of await deliveryStateFiles(taskPath)) {
    try {
      const parsed = JSON.parse(await readFile3(path, "utf8"));
      if (parsed !== null && typeof parsed === "object") return { path, state: parsed };
    } catch {
    }
  }
  return void 0;
}
async function containersFor(subprocess, envId) {
  const out = await tryDocker(subprocess, [
    "ps",
    "-a",
    "--filter",
    `label=dsh.env-id=${envId}`,
    "--format",
    "{{.Names}}	{{.State}}"
  ]);
  if (!out.ok || out.stdout.trim() === "") return [];
  return out.stdout.trim().split(/\r?\n/).map((line) => {
    const [name2, state] = line.split("	");
    return { name: name2 ?? "", state: state ?? "unknown" };
  }).filter((row) => row.name !== "");
}
async function containerIds(subprocess, envId) {
  const out = await tryDocker(subprocess, ["ps", "-a", "-q", "--filter", `label=dsh.env-id=${envId}`]);
  return out.ok ? out.stdout.trim().split(/\r?\n/).filter((one) => one !== "") : [];
}
async function deploymentStatus(subprocess, taskPath) {
  const recorded = await requireRecorded(taskPath);
  const envId = typeof recorded.deploymentEnvId === "string" ? recorded.deploymentEnvId : "";
  const policy = deliveryPolicyOf(recorded);
  const found = await readDeliveryState(taskPath);
  const manifest = await readDeployManifest(taskPath);
  const targets = manifest === void 0 ? ["docker"] : manifest.broken ? [] : Object.keys(manifest.targets);
  return {
    envId,
    target: policy.deploy.target,
    verification: policy.verification,
    // The targets the manifest offers, and whether the policy's own target
    // allows unattended deploys - the D8 exemption a host target states in its
    // manifest entry. A space without a manifest offers docker the L0 way.
    targets,
    autoAllowed: manifest !== void 0 && !manifest.broken && manifest.targets[policy.deploy.target]?.autoAllowed === true,
    url: found?.state?.url ?? null,
    lastSmoke: found?.state?.lastSmoke ?? null,
    humanAck: found?.state?.humanAck ?? null,
    destroyedAt: found?.state?.destroyedAt ?? null,
    stateFound: found !== void 0,
    statePath: found?.path ?? null,
    containers: envId === "" ? [] : await containersFor(subprocess, envId)
  };
}
async function ackAcceptance(taskPath) {
  const found = await readDeliveryState(taskPath);
  if (found === void 0) {
    throw coded("E5005", "there is no deployment state to accept: deploy the task space and let the smoke pass first");
  }
  const next = { ...found.state, humanAck: { at: (/* @__PURE__ */ new Date()).toISOString(), by: "user" } };
  await writeFile2(found.path, `${JSON.stringify(next)}
`, "utf8");
  return { statePath: found.path, humanAck: next.humanAck };
}
async function assertDeliveryGate(recorded, taskPath, { merge = false, bypass = false } = {}) {
  if (merge !== true) return void 0;
  const policy = deliveryPolicyOf(recorded);
  if (policy.deploy.target === "none") return void 0;
  const envId = typeof recorded?.deploymentEnvId === "string" ? recorded.deploymentEnvId : "";
  const found = await readDeliveryState(taskPath);
  const missing = [];
  if (found === void 0) {
    if (bypass) return `the user acknowledged finishing without any recorded ${policy.deploy.target} deployment`;
    throw coded(
      "E5005",
      `the delivery policy requires a ${policy.deploy.target} deployment before merging, and no deployment state was recorded${envId === "" ? "" : ` (environment ${envId})`}. Deploy the task space and run its smoke first.`
    );
  }
  const smoke = found.state?.lastSmoke;
  if (smoke === null || typeof smoke !== "object" || smoke.result !== "pass") missing.push("a passing smoke");
  if ((policy.verification === "agent-then-human" || policy.verification === "human") && found.state?.humanAck?.at === void 0) {
    missing.push("the human acceptance ack");
  }
  if (missing.length === 0) return void 0;
  if (bypass) return `the user acknowledged finishing without ${missing.join(" and ")}`;
  if (missing.length === 1 && missing[0] === "a passing smoke") {
    throw coded("E5006", "the last deployment smoke did not pass, or never ran; run it again and only then merge");
  }
  throw coded("E5007", `the delivery policy waits for ${missing.join(" and ")} before merging; confirm the acceptance in the Worktree Space panel, or finish anyway from there`);
}
async function destroyDeployment(subprocess, taskPath, envId) {
  let id = typeof envId === "string" ? envId.trim() : "";
  let recordedForTarget;
  if (id === "") {
    recordedForTarget = await readTaskMetadata(taskPath).catch(() => void 0);
    if (recordedForTarget !== void 0 && typeof recordedForTarget.deploymentEnvId === "string") id = recordedForTarget.deploymentEnvId;
  }
  if (id === "") {
    return { removed: false, containers: 0, warning: "no deployment environment is recorded for this task space, so there is nothing named to remove" };
  }
  const target = recordedForTarget !== void 0 ? recordedForTarget : await readTaskMetadata(taskPath).catch(() => void 0);
  const policyTarget = typeof target?.delivery === "object" && target.delivery !== null ? String(target.delivery?.deploy?.target ?? "docker") : "docker";
  if (policyTarget !== "docker") {
    const manifest = await readDeployManifest(taskPath);
    const entry = manifestEntryFor(manifest, policyTarget, "destroy");
    const out = await runManifestCommand(subprocess, entry.destroy, manifest.dir, id);
    return { removed: out.ok, containers: 0, ...out.ok ? {} : { warning: outputTail(out.stderr, out.stdout) } };
  }
  const ids = await containerIds(subprocess, id);
  if (ids.length === 0) {
    return { removed: false, containers: 0 };
  }
  const inspect = await tryDocker(subprocess, [
    "inspect",
    ...ids,
    "--format",
    '{{index .Config.Labels "com.docker.compose.project.config_files"}}	{{index .Config.Labels "com.docker.compose.project.working_dir"}}'
  ]);
  let composed = false;
  if (inspect.ok) {
    for (const line of inspect.stdout.split(/\r?\n/)) {
      const [files, dir] = line.split("	");
      if (!files || files === "<no value>" || !dir || dir === "<no value>") continue;
      const down = await tryDocker(subprocess, [
        "compose",
        "--project-name",
        id,
        "--project-directory",
        dir,
        ...files.split(",").filter((file) => file.trim() !== "").flatMap((file) => ["-f", file.trim()]),
        "down",
        "-v",
        "--remove-orphans"
      ]);
      if (down.ok) {
        composed = true;
        break;
      }
    }
  }
  const warnings = [];
  let removed = composed;
  const left = await containerIds(subprocess, id);
  if (left.length > 0) {
    const removedForce = await tryDocker(subprocess, ["rm", "-f", ...left]);
    if (removedForce.ok) {
      removed = true;
    } else {
      warnings.push(`could not remove ${left.length} container${left.length === 1 ? "" : "s"} of environment ${id}: ${removedForce.stderr.trim() !== "" ? removedForce.stderr.trim() : "docker failed"}`);
    }
  }
  await preserveStates(taskPath);
  return { removed, containers: ids.length, ...warnings.length > 0 ? { warning: warnings[0] } : {} };
}
async function preserveStates(taskPath) {
  const destroyedAt = (/* @__PURE__ */ new Date()).toISOString();
  for (const path of await deliveryStateFiles(taskPath)) {
    try {
      const state = JSON.parse(await readFile3(path, "utf8"));
      if (state !== null && typeof state === "object") {
        await writeFile2(path, `${JSON.stringify({ ...state, url: null, destroyedAt })}
`, "utf8");
      }
    } catch {
    }
  }
}
var OUTPUT_TAIL = 4e3;
function outputTail(...streams) {
  const text = streams.join("\n").trim();
  return text.length > OUTPUT_TAIL ? `\u2026${text.slice(text.length - OUTPUT_TAIL)}` : text;
}
async function findDeployScript(taskPath) {
  const entries = await readdir2(taskPath, { withFileTypes: true }).catch(() => []);
  const candidates = [join4(taskPath, "deploy")];
  for (const entry of entries) {
    if (entry.isDirectory()) candidates.push(join4(taskPath, entry.name, "deploy"));
  }
  for (const dir of candidates) {
    const script = join4(dir, "deploy.sh");
    if (existsSync(script)) return { script, dir };
  }
  return void 0;
}
var MANIFEST_NAME = "deploy.yaml";
function parseManifestTargets(text) {
  if (typeof text !== "string" || text.trim() === "") return void 0;
  const targets = /* @__PURE__ */ Object.create(null);
  let current = null;
  let sawTargets = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trimEnd();
    if (line.trim() === "") continue;
    const indent = line.length - line.trimStart().length;
    const body = line.trim();
    const field = /^([A-Za-z][A-Za-z0-9_-]*):(?:\s+(.*))?$/.exec(body);
    if (field === null) return void 0;
    const [, key, inline] = field;
    if (indent === 0) {
      if (key === "targets" && inline === void 0) {
        sawTargets = true;
        current = null;
        continue;
      }
      return void 0;
    }
    if (!sawTargets) return void 0;
    if (inline === void 0 || inline === "") {
      current = targets[key] = {};
      continue;
    }
    if (current === null) return void 0;
    const scalar = inline.replace(/^['"]|['"]$/g, "");
    current[key] = scalar === "true" ? true : scalar === "false" ? false : scalar;
  }
  return sawTargets && Object.keys(targets).length > 0 ? targets : void 0;
}
async function readDeployManifest(taskPath) {
  const entries = await readdir2(taskPath, { withFileTypes: true }).catch(() => []);
  const candidates = [join4(taskPath, "deploy")];
  for (const entry of entries) {
    if (entry.isDirectory()) candidates.push(join4(taskPath, entry.name, "deploy"));
  }
  for (const dir of candidates) {
    const file = join4(dir, MANIFEST_NAME);
    if (!existsSync(file)) continue;
    const text = await readFile3(file, "utf8").catch(() => void 0);
    if (text === void 0) return { broken: true, dir, targets: void 0 };
    const targets = parseManifestTargets(text);
    if (targets === void 0) return { broken: true, dir, targets: void 0 };
    return { broken: false, dir, targets };
  }
  return void 0;
}
function manifestEntryFor(manifest, target, field) {
  if (target === "none") {
    throw coded("E5009", "the delivery policy deploys nothing (target none), so there is no manifest entry to serve; this action should not have been reachable");
  }
  if (manifest === void 0) return target === "docker" ? null : void 0;
  if (manifest.broken) throw coded("E5010", `the deploy manifest exists but cannot be parsed, so no target can be trusted; fix or remove ${MANIFEST_NAME}`);
  const entry = manifest.targets[target];
  if (entry === void 0 || entry === null || typeof entry !== "object") {
    throw coded("E5009", `the manifest offers no '${target}' target (its targets: ${Object.keys(manifest.targets).join(", ") || "none"}); the delivery policy cannot be served by swapping in another`);
  }
  if (field !== void 0 && typeof entry[field] !== "string" || field !== void 0 && entry[field] === "") {
    throw coded("E5009", `the manifest's '${target}' target names no '${field}' command`);
  }
  return entry;
}
async function runManifestCommand(subprocess, command, dir, envId) {
  return runProcess(subprocess, ["bash", "-c", `DSH_ENV_ID='${envId}' ${command}`], {
    cwd: dir,
    maxBytes: 2 * 1024 * 1024
  });
}
async function smokeEnvironment(subprocess, taskPath) {
  const recorded = await requireRecorded(taskPath);
  const envId = typeof recorded.deploymentEnvId === "string" ? recorded.deploymentEnvId.trim() : "";
  const policy = deliveryPolicyOf(recorded);
  const manifest = await readDeployManifest(taskPath);
  const entry = manifestEntryFor(manifest, policy.deploy.target, "smoke");
  let out;
  if (entry === null) {
    const found = await findDeployScript(taskPath);
    if (found === void 0) {
      throw coded("E5008", `no deploy/deploy.sh exists in this task space, so there is nothing to smoke: ${taskPath}`);
    }
    try {
      out = await runProcess(subprocess, ["bash", found.script, "smoke", ...envId === "" ? [] : [envId]], {
        cwd: found.dir,
        maxBytes: 2 * 1024 * 1024
      });
    } catch (error) {
      throw coded("E5008", `the deploy script could not be started (${error.message}); bash must be on the PATH the server runs with`);
    }
  } else {
    out = await runManifestCommand(subprocess, entry.smoke, manifest.dir, envId);
  }
  return {
    output: outputTail(out.stderr, out.stdout),
    exitCode: out.exitCode,
    status: await deploymentStatus(subprocess, taskPath)
  };
}
async function deployEnvironment(subprocess, taskPath) {
  const recorded = await requireRecorded(taskPath);
  const envId = typeof recorded.deploymentEnvId === "string" ? recorded.deploymentEnvId.trim() : "";
  const policy = deliveryPolicyOf(recorded);
  const manifest = await readDeployManifest(taskPath);
  const entry = manifestEntryFor(manifest, policy.deploy.target, "up");
  let out;
  if (entry === null) {
    const found = await findDeployScript(taskPath);
    if (found === void 0) {
      throw coded("E5008", `no deploy/deploy.sh exists in this task space, so there is nothing to deploy: ${taskPath}`);
    }
    try {
      out = await runProcess(subprocess, ["bash", found.script, "up", ...envId === "" ? [] : [envId]], {
        cwd: found.dir,
        maxBytes: 2 * 1024 * 1024
      });
    } catch (error) {
      throw coded("E5008", `the deploy script could not be started (${error.message}); bash must be on the PATH the server runs with`);
    }
    if (!out.ok) {
      throw coded("E5008", `the deploy script failed with exit code ${out.exitCode}:
${outputTail(out.stderr, out.stdout)}`);
    }
  } else {
    out = await runManifestCommand(subprocess, entry.up, manifest.dir, envId);
    if (!out.ok) {
      throw coded("E5008", `the manifest's up command failed with exit code ${out.exitCode}:
${outputTail(out.stderr, out.stdout)}`);
    }
  }
  return {
    output: outputTail(out.stdout),
    status: await deploymentStatus(subprocess, taskPath)
  };
}

// src/host/task/concurrency.js
async function mapWithLimit(items, limit, worker) {
  const list = [...items];
  const results = new Array(list.length);
  const width = Math.max(1, Math.trunc(limit) || 1);
  let next = 0;
  const run = async () => {
    for (; ; ) {
      const index = next++;
      if (index >= list.length) return;
      results[index] = await worker(list[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, list.length) }, run));
  return results;
}

// src/host/task/inspect.js
import { existsSync as existsSync3 } from "node:fs";
import { readdir as readdir4, stat as stat4 } from "node:fs/promises";
import { basename as basename4, dirname as dirname3, join as join7 } from "node:path";

// src/host/task/container.js
import { existsSync as existsSync2 } from "node:fs";
import { mkdir, writeFile as writeFile3 } from "node:fs/promises";
import { join as join5 } from "node:path";
var CONTAINER_README = "README.md";
var CONTAINER_ARCHIVE_FOLDER = "archived-docs";
var CONTAINER_NOTICE = `# Worktree Space

\u672C\u76EE\u5F55\u7531 **Worktree Space** \u63D2\u4EF6\u7BA1\u7406\uFF0C\u7528\u6765\u5B58\u653E\u5404\u4E2A\u4EFB\u52A1\u7684\u5DE5\u4F5C\u533A\uFF08Git Worktree\uFF09\u3002

- \u6BCF\u4E2A\u4EFB\u52A1\u7A7A\u95F4\u662F \`<\u9879\u76EE>/<\u4EFB\u52A1>/\`\uFF0C\u4E0B\u9762\u6BCF\u4E2A\u4ED3\u5E93\u4E00\u4EFD worktree\u3002
- \u8FD9\u91CC**\u4E0D\u8981**\u76F4\u63A5 \`git init\`\uFF0C\u4E5F**\u4E0D\u8981** \`git clone\` \u8FDB\u6765\uFF1A\u672C\u76EE\u5F55\u4E00\u65E6\u6210\u4E3A Git \u4ED3\u5E93\uFF0C
  \u6BCF\u4E2A worktree \u90FD\u4F1A\u843D\u5728\u67D0\u4E2A\u68C0\u51FA\u4E4B\u5185\uFF0C\u4EFB\u52A1\u91CC\u7684\u6539\u52A8\u5C31\u53EF\u80FD\u88AB\u8BEF\u5F53\u6210\u6E90\u4ED3\u5E93\u7684\u4E00\u90E8\u5206\u3002
- \u63D2\u4EF6\u5728\u521B\u5EFA\u4EFB\u52A1\u7A7A\u95F4\u524D\u4F1A\u68C0\u67E5\u672C\u76EE\u5F55\u4E0B\u6CA1\u6709 \`.git\`\uFF0C\u53D1\u73B0\u65F6\u62D2\u7EDD\u521B\u5EFA\u3002
- \u5F52\u6863\u6587\u6863\u9ED8\u8BA4\u6536\u5728\u672C\u76EE\u5F55\u4E0B\u7684 \`archived-docs/<\u9879\u76EE>/<\u4EFB\u52A1>-<\u65F6\u95F4\u6233>/\`\uFF08\u63D2\u4EF6\u914D\u7F6E\u91CC\u53EF\u4EE5\u6539\u5230\u522B\u5904\uFF09\u3002

\u53EF\u4EE5\u653E\u5FC3\u5728\u672C\u76EE\u5F55\u91CC\u653E\u81EA\u5DF1\u7684\u6587\u4EF6\u3002\u8FD9\u4EFD README \u53EA\u5728\u4E0D\u5B58\u5728\u65F6\u5199\u5165\uFF0C\u63D2\u4EF6\u4E0D\u4F1A\u8986\u76D6\u5DF2\u6709\u7684\u540C\u540D\u6587\u4EF6\u3002

## English

This directory is managed by the **Worktree Space** plugin and holds the working
spaces (Git worktrees) of its tasks.

- A task space is \`<project>/<task>/\`, with one worktree per repository.
- Do **not** run \`git init\` here, and do **not** \`git clone\` into it: the moment
  this directory is a repository, every worktree sits inside a checkout and the
  changes made for a task can be mistaken for part of the source tree.
- The plugin checks that this directory holds no \`.git\` before it creates a
  task space, and refuses to create one when it does.
- Archived documents are filed into \`archived-docs/<project>/<task>-<stamp>/\`
  in this same directory by default (the plugin's configuration can point them
  elsewhere).

You are free to keep your own files here. This README is written only when one is
not already present, and is never overwritten.
`;
async function prepareContainerRoot(tasksRoot) {
  const root = String(tasksRoot ?? "").trim();
  if (root === "") throw coded("E1004", "a tasks root is required");
  if (existsSync2(join5(root, ".git"))) {
    throw coded(
      "E1005",
      `the tasks root ${root} is a git repository
  worktree spaces must be filed under a directory that is not one, or every task would be committed into it; put the container beside the repositories instead`
    );
  }
  await mkdir(root, { recursive: true });
  const notice = join5(root, CONTAINER_README);
  if (!existsSync2(notice)) await writeFile3(notice, CONTAINER_NOTICE, "utf8");
}

// src/host/task/discover.js
import { readdir as readdir3, stat as stat3 } from "node:fs/promises";
import { basename as basename3, join as join6, resolve as resolve3 } from "node:path";
async function isSourceRepository(directory) {
  try {
    return (await stat3(join6(directory, ".git"))).isDirectory();
  } catch {
    return false;
  }
}
async function discoverSourceRepos(sourceRoot, {
  signal,
  maxDepth = 1,
  maxDirectories = Number.POSITIVE_INFINITY,
  ignored = /* @__PURE__ */ new Set(),
  exclude = []
} = {}) {
  const repositories = [];
  const queue = [{ path: sourceRoot, depth: 0 }];
  let inspected = 0;
  for (let cursor = 0; cursor < queue.length; ) {
    signal?.throwIfAborted();
    const batch = queue.slice(cursor, cursor + 8);
    cursor += batch.length;
    inspected += batch.length;
    if (inspected > maxDirectories) break;
    await Promise.all(batch.map(async ({ path, depth }) => {
      if (exclude.some((nested) => isInside(nested, path))) return;
      if (await isSourceRepository(path)) {
        repositories.push(path);
        return;
      }
      if (depth >= maxDepth) return;
      let entries;
      try {
        entries = await readdir3(path, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith(".")) continue;
        if (entry.name.endsWith(".worktrees")) continue;
        if (ignored.has(entry.name.toLowerCase())) continue;
        queue.push({ path: join6(path, entry.name), depth: depth + 1 });
      }
    }));
  }
  return repositories.sort();
}
async function resolveSourceRepos(sourceRoot, requested) {
  const repositories = [];
  let rootIsRepo;
  const rootAnswersForItself = async (entry) => {
    if (rootIsRepo === void 0) rootIsRepo = await isSourceRepository(sourceRoot);
    return rootIsRepo && !/[\\/]/.test(entry) && basename3(sourceRoot) === basename3(entry);
  };
  for (const raw of requested) {
    const entry = typeof raw === "string" ? raw.trim() : "";
    if (entry === "") throw coded("E4005", "a repository path is required");
    const candidate = await rootAnswersForItself(entry) ? resolve3(sourceRoot) : resolve3(sourceRoot, entry);
    if (!samePathLocation(candidate, sourceRoot) && !isInside(sourceRoot, candidate)) {
      throw coded("E4006", `not inside the source root ${sourceRoot}: ${entry}`);
    }
    if (!await isSourceRepository(candidate)) throw coded("E6001", `not a source repository: ${basename3(candidate)}`);
    repositories.push(candidate);
  }
  return repositories;
}

// src/host/task/inspect.js
async function classifySourceRoot(sourceRoot, { signal, ...bounds } = {}) {
  const repositories = await discoverSourceRepos(sourceRoot, { signal, ...bounds });
  return {
    path: sourceRoot,
    // Whether the path is a directory at all. `isSourceRoot` cannot answer it: a
    // directory that holds no repositories and a path that is not there both come
    // back as false, and a caller registering a Workspace needs to tell those two
    // apart before it makes one out of the path.
    isDirectory: await isExistingDirectory(sourceRoot),
    isRepository: await isSourceRepository(sourceRoot),
    isSourceRoot: repositories.length > 0,
    repositoryCount: repositories.length,
    repositories: repositories.map((repoPath) => ({ name: basename4(repoPath), path: repoPath }))
  };
}
var pathKey = (value) => {
  const text = String(value ?? "");
  return text.length > 1 ? text.replace(/[\\/]+$/, "") : text;
};
async function classifySourceRoots(paths, { signal, concurrency = 6, ...bounds } = {}) {
  const asked = [];
  const seen = /* @__PURE__ */ new Set();
  for (const raw of paths ?? []) {
    const path = String(raw ?? "").trim();
    if (path === "") continue;
    const key = pathKey(path);
    if (seen.has(key)) continue;
    seen.add(key);
    asked.push(path);
  }
  const classified = await mapWithLimit(asked, concurrency, async (path) => {
    try {
      const nested = asked.filter((other) => other !== path && isInside(path, other));
      return await classifySourceRoot(path, { signal, ...bounds, exclude: nested });
    } catch {
      return void 0;
    }
  });
  return classified.filter((entry) => entry !== void 0);
}
async function isExistingDirectory(directory) {
  try {
    return (await stat4(directory)).isDirectory();
  } catch {
    return false;
  }
}
async function suggestTaskRoot(subprocess, sourceRoot, { tasksRoot, branchPrefix = DEFAULT_BRANCH_PREFIX, configuredRoot = "", ...bounds } = {}) {
  const requested = typeof tasksRoot === "string" ? tasksRoot.trim() : "";
  const suggested = resolveTasksRoot(sourceRoot, requested, configuredRoot);
  assertIsolated(sourceRoot, suggested);
  const repositories = await discoverSourceRepos(sourceRoot, bounds);
  return {
    sourceRoot,
    suggested,
    explicit: requested !== "",
    // The same resolution a create performs, so the preview the dialog shows and
    // the branch the host would make cannot disagree.
    branchPrefix: validateBranchPrefix(branchPrefix),
    // One git call per repository, in parallel: the dialog's cards name the branch
    // each HEAD is on, which is the fact the repository view shows for its main
    // worktree.
    repositories: await Promise.all(repositories.map(async (repoPath) => {
      const branch = await currentBranchOf(subprocess, repoPath);
      return {
        name: basename4(repoPath),
        path: repoPath,
        ...branch === void 0 ? {} : { branch }
      };
    }))
  };
}
async function currentBranchOf(subprocess, repoPath) {
  const branch = await tryRunGit(subprocess, repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return branch === "" || branch === "HEAD" ? void 0 : branch;
}
async function inspectTask(taskPath) {
  const path = String(taskPath ?? "").trim();
  const name2 = basename4(path);
  const containerRoot = dirname3(dirname3(path));
  const notATask = { path, isTask: false, task: name2, project: basename4(dirname3(path)), tasksRoot: containerRoot, repositories: [] };
  if (path === "") return notATask;
  let entries;
  try {
    entries = await readdir4(path, { withFileTypes: true });
  } catch {
    return notATask;
  }
  const repositories = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (await isLinkedWorktree(join7(path, entry.name))) repositories.push(entry.name);
  }
  const details = await readTaskMetadata(path);
  if (details === void 0 && repositories.length === 0) return notATask;
  return {
    path,
    isTask: true,
    task: details?.task ?? name2,
    // The record knows where it was filed. A space made before the project layer
    // existed has neither field, and its path answers for both: the directory it
    // sits in is its project, and the one above that the container root.
    project: typeof details?.project === "string" && details.project !== "" ? details.project : basename4(dirname3(path)),
    tasksRoot: typeof details?.tasksRoot === "string" && details.tasksRoot !== "" ? details.tasksRoot : containerRoot,
    ...details?.branch === void 0 ? {} : { branch: details.branch },
    ...details?.sourceRoot === void 0 ? {} : { sourceRoot: details.sourceRoot },
    ...details?.baseRef === void 0 || details.baseRef === null ? {} : { baseRef: details.baseRef },
    ...details?.createdAt === void 0 ? {} : { createdAt: details.createdAt },
    repositories: repositories.sort()
  };
}
async function listTasks(subprocess, { tasksRoot } = {}) {
  if (typeof tasksRoot !== "string" || tasksRoot.trim() === "") throw coded("E1004", "a tasks root is required");
  const root = tasksRoot.trim();
  if (!existsSync3(root)) return { tasksRoot: root, tasks: [] };
  const projects = await readdir4(root, { withFileTypes: true });
  const tasks = [];
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    if (project.name === CONTAINER_ARCHIVE_FOLDER) continue;
    const projectPath = join7(root, project.name);
    for (const entry of await readdir4(projectPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const taskPath = join7(projectPath, entry.name);
      tasks.push({
        name: entry.name,
        project: project.name,
        path: taskPath,
        repositories: await listTaskWorktrees(subprocess, taskPath)
      });
    }
  }
  tasks.sort((left, right) => left.project.localeCompare(right.project) || left.name.localeCompare(right.name));
  return { tasksRoot: root, tasks };
}

// src/host/task/create.js
import { existsSync as existsSync4 } from "node:fs";
import { mkdir as mkdir2, readdir as readdir5, rm } from "node:fs/promises";
import { basename as basename5, join as join8 } from "node:path";
async function sourceFacts(subprocess, repoPath) {
  const [branch, commit] = await Promise.all([
    tryRunGit(subprocess, repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]),
    tryRunGit(subprocess, repoPath, ["rev-parse", "HEAD"])
  ]);
  return {
    // A detached HEAD prints `HEAD`, which is no branch to name.
    ...branch === "" || branch === "HEAD" ? {} : { sourceBranch: branch },
    ...commit === "" ? {} : { startCommit: commit }
  };
}
function holdsOnlyOurs(leftovers, created) {
  return leftovers.every((name2) => TASK_OWNED_FILES.includes(name2) || created.some((entry) => basename5(entry.path) === name2));
}
async function rollbackTask(subprocess, tasksRoot, taskPath, branch, created) {
  const stranded = [];
  for (const entry of created) {
    const refused = refuseDelete(tasksRoot, entry.path, `the worktree '${entry.name}'`);
    if (refused !== "") {
      stranded.push(entry.name);
      continue;
    }
    if (!await gitSucceeded(subprocess, entry.repoPath, ["worktree", "remove", "--force", entry.path])) {
      stranded.push(entry.name);
      continue;
    }
    if (!await gitSucceeded(subprocess, entry.repoPath, ["branch", "-D", "--", branch])) {
      stranded.push(`${entry.name}'s branch ${branch}`);
    }
  }
  if (stranded.length > 0) return stranded;
  const container = `the task space ${basename5(taskPath)}`;
  let leftovers;
  try {
    leftovers = await readdir5(taskPath);
  } catch (error) {
    if (error?.code !== "ENOENT") stranded.push(container);
    return stranded;
  }
  if (!holdsOnlyOurs(leftovers, created)) {
    stranded.push(container);
    return stranded;
  }
  try {
    await rm(taskPath, { recursive: true, force: true });
  } catch {
    stranded.push(container);
  }
  return stranded;
}
async function createTask(subprocess, options) {
  const {
    sourceRoot,
    task,
    tasksRoot: requestedRoot,
    repos,
    baseRef,
    branchPrefix = DEFAULT_BRANCH_PREFIX,
    configuredRoot = "",
    // How far to look for the repositories a task covers. The same bounds the
    // classification and the suggestion used, so the count on the Workspace card,
    // the list in the create dialog, and what this actually takes are one number
    // rather than three that happen to disagree.
    scanBounds: scanBounds2 = {},
    // The delivery policy as this request stated it, and the per-project defaults
    // the configuration holds. Resolved below, once, before anything is made.
    delivery,
    deliveryDefaults = {}
  } = options;
  const name2 = validateTaskName(task);
  const prefix = validateBranchPrefix(branchPrefix);
  const tasksRoot = resolveTasksRoot(sourceRoot, requestedRoot, configuredRoot);
  assertIsolated(sourceRoot, tasksRoot);
  const project = projectNameFor(sourceRoot);
  const policy = resolveDeliveryPolicy(project, delivery, deliveryDefaults);
  if (Array.isArray(repos) && repos.length === 0) {
    throw coded("E4001", "select at least one repository for the task");
  }
  const selected = Array.isArray(repos) ? await resolveSourceRepos(sourceRoot, repos) : await discoverSourceRepos(sourceRoot, scanBounds2);
  if (selected.length === 0) {
    throw coded(
      "E6001",
      `no source repositories found under ${sourceRoot}: expected a repository, or .git directories within ${scanBounds2.maxDepth ?? 1} level(s) below it`
    );
  }
  const names = selected.map((repoPath) => basename5(repoPath));
  const duplicate = names.find((entry, index) => names.indexOf(entry) !== index);
  if (duplicate !== void 0) {
    throw coded("E4002", `two selected repositories are both named '${duplicate}'; select repositories with distinct names`);
  }
  const branch = branchNameFor(name2, prefix);
  const taskPath = taskSpacePath(tasksRoot, project, name2);
  auditEnter({ task: name2, project, tasksRoot });
  if (existsSync4(taskPath)) {
    const existing = await readTaskMetadata(taskPath).catch(() => void 0);
    const ours = existing !== void 0 && existing.task === name2 && existing.project === project && existing.branch === branch;
    const error = coded("E2001", `task space already exists: ${taskPath}`);
    if (ours) error.code = "E2002";
    error.msg = ours ? `Nothing was created. A task space for exactly this task, project and branch is already on disk at ${taskPath}, which means an earlier create got as far as making it and stopped before its Workspace was registered. Creating again under this name will keep failing until that one is registered, finished or removed.` : `Nothing was created. The name is already taken by a different task space at ${taskPath}, so this create would have overwritten somebody else's work. Pick another task name, or finish the existing task first.`;
    throw error;
  }
  for (const repoPath of selected) {
    if (await gitSucceeded(subprocess, repoPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])) {
      throw coded(
        "E3001",
        `branch '${branch}' already exists in '${basename5(repoPath)}'; pick another task name`
      ).withMsg(
        `Nothing was created. The branch ${branch} already exists in ${basename5(repoPath)}, so a new worktree could not be named after it and cutting one would have pointed this task's work at work already in progress. Pick another task name, or start from a branch that is free.`
      );
    }
  }
  if (baseRef !== void 0 && `${baseRef}`.trim() !== "") {
    for (const repoPath of selected) {
      if (!await gitSucceeded(subprocess, repoPath, ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`])) {
        throw coded("E3002", `base '${baseRef}' not found in '${basename5(repoPath)}'`);
      }
    }
  }
  await prepareContainerRoot(tasksRoot);
  await mkdir2(join8(tasksRoot, project), { recursive: true });
  await mkdir2(taskPath);
  const created = [];
  try {
    for (const repoPath of selected) {
      const worktreePath = join8(taskPath, basename5(repoPath));
      const facts = await sourceFacts(subprocess, repoPath);
      const args = baseRef === void 0 || `${baseRef}`.trim() === "" ? ["worktree", "add", worktreePath, "-b", branch] : ["worktree", "add", worktreePath, "-b", branch, `${baseRef}`];
      await runGit(subprocess, repoPath, args);
      created.push({ name: basename5(repoPath), path: worktreePath, repoPath, ...facts });
    }
    await writeTaskMetadata(taskPath, taskMetadata({
      task: name2,
      project,
      tasksRoot,
      sourceRoot,
      branch,
      baseRef: baseRef === void 0 || `${baseRef}`.trim() === "" ? void 0 : `${baseRef}`,
      delivery: policy,
      repositories: created.map((entry) => ({
        name: entry.name,
        sourcePath: entry.repoPath,
        branch,
        ...entry.sourceBranch === void 0 ? {} : { sourceBranch: entry.sourceBranch },
        ...entry.startCommit === void 0 ? {} : { startCommit: entry.startCommit }
      }))
    }));
  } catch (error) {
    const stranded = await rollbackTask(subprocess, tasksRoot, taskPath, branch, created);
    const suffix = stranded.length === 0 ? "" : ` (could not roll back: ${stranded.join(", ")})`;
    const own = typeof error?.code === "string" && Object.hasOwn(ERROR_CODES, error.code) ? error.code : "";
    const code = own !== "" ? own : stranded.length === 0 ? "E2005" : "E2006";
    await recordError(error, {
      phase: "create",
      code,
      msg: stranded.length === 0 ? "Creating the task space failed. The rollback removed the worktrees, the branch and the task space this call had made, so the same name can be used again." : "Creating the task space failed and the rollback could not remove everything. The leftovers named in `stranded` are still on disk and have to be dealt with by hand.",
      ...created.length === 0 ? {} : { created: created.map((entry) => entry.name) },
      ...stranded.length === 0 ? {} : { stranded }
    });
    const rolled = new Error(`${error.message}${suffix}`);
    rolled.code = code;
    throw rolled;
  }
  await recordEvent(
    "info",
    `Created the task space. Every selected repository has a worktree on ${branch} and the task metadata is written, so this is the point from which the task exists.`,
    { phase: "create", branch, path: taskPath, worktrees: created.map((entry) => entry.name) }
  );
  return {
    task: name2,
    project,
    branch,
    path: taskPath,
    tasksRoot,
    baseRef: baseRef === void 0 || `${baseRef}`.trim() === "" ? void 0 : `${baseRef}`,
    repositories: created.map((entry) => ({ name: entry.name, path: entry.path }))
  };
}

// src/host/task/add.js
import { existsSync as existsSync5 } from "node:fs";
import { readFile as readFile4, rm as rm2, writeFile as writeFile4 } from "node:fs/promises";
import { basename as basename6, join as join9 } from "node:path";
async function branchOf(subprocess, metadata, worktrees) {
  const recorded = typeof metadata?.branch === "string" ? metadata.branch.trim() : "";
  if (recorded !== "") return recorded;
  const seen = new Set(worktrees.map((entry) => entry.branch).filter(Boolean));
  return seen.size === 1 ? [...seen][0] : void 0;
}
async function hydrated(subprocess, taskPath, identity, metadata, worktrees) {
  if (Array.isArray(metadata?.repositories) && metadata.repositories.length > 0) {
    return { ...metadata, version: 1, task: identity.task, project: identity.project, tasksRoot: identity.tasksRoot };
  }
  const repositories = [];
  for (const entry of worktrees) {
    const porcelain = await tryRunGit(subprocess, entry.path, ["worktree", "list", "--porcelain"]);
    const mainRepo = parseWorktrees(porcelain).find((row) => row.isMain)?.path ?? "";
    const facts = await sourceFacts(subprocess, mainRepo === "" ? entry.path : mainRepo);
    repositories.push({
      name: entry.name,
      sourcePath: mainRepo,
      ...facts.sourceBranch === void 0 ? {} : { sourceBranch: facts.sourceBranch },
      ...facts.startCommit === void 0 ? {} : { startCommit: facts.startCommit },
      branch: entry.branch ?? ""
    });
  }
  return {
    ...metadata,
    version: 1,
    task: identity.task,
    project: identity.project,
    tasksRoot: identity.tasksRoot,
    baseRef: metadata?.baseRef ?? null,
    repositories
  };
}
function assertAddIsolated(taskPath, repoPath, name2) {
  if (samePathLocation(taskPath, repoPath)) {
    throw coded("E1002", `'${name2}' is the task space itself, so its worktree would be written inside it`);
  }
  if (isInside(taskPath, repoPath)) {
    throw coded("E1002", `'${name2}' sits inside the task space at ${repoPath}, so its worktree would be written into the task space; add a source repository instead`);
  }
  if (isInside(repoPath, taskPath)) {
    throw coded("E1003", `'${name2}' at ${repoPath} holds the task space, so a worktree cut from it would be part of itself`);
  }
}
async function rollbackAdded(subprocess, tasksRoot, created) {
  const stranded = [];
  for (const entry of created) {
    const refused = refuseDelete(tasksRoot, entry.path, `the worktree '${entry.name}'`);
    if (refused !== "") {
      stranded.push(entry.name);
      continue;
    }
    if (!await gitSucceeded(subprocess, entry.repoPath, ["worktree", "remove", "--force", entry.path])) {
      stranded.push(entry.name);
    }
  }
  return stranded;
}
async function restoreMetadata(taskPath, previousJson, previousReadme) {
  for (const [name2, before] of [[TASK_METADATA, previousJson], [TASK_README, previousReadme]]) {
    try {
      if (before === void 0) {
        await rm2(join9(taskPath, name2), { force: true });
      } else {
        await writeFile4(join9(taskPath, name2), before, "utf8");
      }
    } catch {
    }
  }
}
async function addTaskRepositories(subprocess, options) {
  const { task, project, tasksRoot, repositories, baseRef } = options;
  if (typeof tasksRoot !== "string" || tasksRoot.trim() === "") throw coded("E1004", "a tasks root is required");
  if (!Array.isArray(repositories) || repositories.length === 0) {
    throw coded("E4001", "name at least one repository to add to the task");
  }
  const projectName = validateProjectName(project);
  const taskPath = taskSpacePath(tasksRoot, projectName, task);
  if (!existsSync5(taskPath)) throw coded("E2003", `no such task space: ${taskPath}`);
  auditEnter({ task, project: projectName, tasksRoot: tasksRoot.trim() });
  const worktrees = await listTaskWorktrees(subprocess, taskPath);
  if (worktrees.length === 0) {
    throw coded("E2004", `no git worktrees found in ${taskPath}, so there is no branch this task can be extended on`);
  }
  const metadata = await readTaskMetadata(taskPath);
  const branch = await branchOf(subprocess, metadata, worktrees);
  if (branch === void 0) {
    throw coded("E2004", `the worktrees in ${taskPath} do not agree on a branch, so this task cannot be extended; finish it or name a new task`);
  }
  const recorded = await hydrated(subprocess, taskPath, { task, project: projectName, tasksRoot: tasksRoot.trim() }, metadata, worktrees);
  const taken = /* @__PURE__ */ new Set([
    ...worktrees.map((entry) => entry.name),
    ...Array.isArray(recorded.repositories) ? recorded.repositories.map((entry) => entry?.name) : []
  ]);
  const start = typeof baseRef === "string" && baseRef.trim() !== "" ? baseRef.trim() : void 0;
  const selected = [];
  for (const raw of repositories) {
    const repoPath = typeof raw === "string" ? raw.trim() : "";
    if (repoPath === "") throw coded("E4005", "a repository path is required");
    const name2 = basename6(repoPath);
    if (selected.some((entry) => basename6(entry) === name2)) {
      throw coded("E4002", `two of the repositories to add are both named '${name2}'`);
    }
    if (taken.has(name2)) {
      throw coded("E4002", `the task space already holds a repository named '${name2}'; every worktree in a task is named after its source repository, so two repositories cannot share one name`);
    }
    if (!await isSourceRepository(repoPath)) {
      throw coded("E6001", `not a source repository: ${repoPath}`);
    }
    assertAddIsolated(taskPath, repoPath, name2);
    if (await gitSucceeded(subprocess, repoPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])) {
      throw coded(
        "E3001",
        `branch '${branch}' already exists in '${name2}'; a worktree cannot be named after a branch that is already there, and cutting one would point this task at work already in progress`
      );
    }
    if (start !== void 0 && !await gitSucceeded(subprocess, repoPath, ["rev-parse", "--verify", "--quiet", `${start}^{commit}`])) {
      throw coded("E3002", `base '${start}' not found in '${name2}'`);
    }
    taken.add(name2);
    selected.push(repoPath);
  }
  const previousJson = await readFile4(join9(taskPath, TASK_METADATA), "utf8").catch(() => void 0);
  const previousReadme = await readFile4(join9(taskPath, TASK_README), "utf8").catch(() => void 0);
  const created = [];
  try {
    for (const repoPath of selected) {
      const name2 = basename6(repoPath);
      const worktreePath = join9(taskPath, name2);
      const facts = await sourceFacts(subprocess, repoPath);
      const args = start === void 0 ? ["worktree", "add", worktreePath, "-b", branch] : ["worktree", "add", worktreePath, "-b", branch, start];
      await runGit(subprocess, repoPath, args);
      created.push({ name: name2, path: worktreePath, repoPath, ...facts });
    }
    await writeTaskMetadata(taskPath, {
      ...recorded,
      branch,
      baseRef: start ?? recorded.baseRef ?? null,
      repositories: [
        ...Array.isArray(recorded.repositories) ? recorded.repositories : [],
        ...created.map((entry) => ({
          name: entry.name,
          sourcePath: entry.repoPath,
          ...entry.sourceBranch === void 0 ? {} : { sourceBranch: entry.sourceBranch },
          ...entry.startCommit === void 0 ? {} : { startCommit: entry.startCommit },
          branch,
          addedAt: (/* @__PURE__ */ new Date()).toISOString()
        }))
      ]
    });
  } catch (error) {
    const stranded = await rollbackAdded(subprocess, tasksRoot, created);
    await restoreMetadata(taskPath, previousJson, previousReadme);
    const suffix = stranded.length === 0 ? "" : ` (could not roll back: ${stranded.join(", ")})`;
    const own = typeof error?.code === "string" && Object.hasOwn(ERROR_CODES, error.code) ? error.code : "";
    const code = own !== "" ? own : stranded.length === 0 ? "E2005" : "E2006";
    await recordError(error, {
      phase: "add",
      code,
      msg: stranded.length === 0 ? `Adding repositories to '${task}' failed. The worktrees this call made were taken back, so the task is exactly as it was and the same repositories can be added again.` : `Adding repositories to '${task}' failed and the worktrees this call made could not all be removed. The ones named in \`stranded\` are still on disk; the task's own repositories were not touched.`,
      ...created.length === 0 ? {} : { created: created.map((entry) => entry.name) },
      ...stranded.length === 0 ? {} : { stranded }
    });
    const rolled = new Error(`${error.message}${suffix}`);
    rolled.code = code;
    throw rolled;
  }
  await recordEvent(
    "info",
    `Added ${created.length} repositor${created.length === 1 ? "y" : "ies"} to the task space. ${created.map((entry) => entry.name).join(", ")} now has a worktree on ${branch} alongside the ones it already had, and the task metadata records where each source repository lives.`,
    { phase: "add", branch, path: taskPath, added: created.map((entry) => entry.name) }
  );
  return {
    task,
    project: projectName,
    branch,
    path: taskPath,
    tasksRoot: tasksRoot.trim(),
    baseRef: start,
    repositories: created.map((entry) => ({ name: entry.name, path: entry.path, sourcePath: entry.repoPath }))
  };
}

// src/host/task/archive.js
import { existsSync as existsSync6 } from "node:fs";
import { cp, mkdir as mkdir3, mkdtemp, open, readdir as readdir6, rmdir, rm as rm3 } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename as basename7, join as join10 } from "node:path";
async function mergeInProgress(subprocess, site) {
  return gitSucceeded(subprocess, site, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]);
}
async function conflictedFiles(subprocess, site) {
  const output = await tryRunGit(subprocess, site, ["diff", "--name-only", "--diff-filter=U"]);
  return output.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
}
var MARKER_SCAN_MAX_BYTES = 1024 * 1024;
async function readHead(path) {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(MARKER_SCAN_MAX_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}
async function conflictMarkers(subprocess, site) {
  const changed = await tryRunGit(subprocess, site, ["diff", "--name-only", "HEAD"]);
  const listed = [.../* @__PURE__ */ new Set([...changed.split(/\r?\n/), ...await conflictedFiles(subprocess, site)])].map((line) => line.trim()).filter((line) => line !== "");
  const marked = [];
  for (const file of listed) {
    let text = "";
    try {
      text = await readHead(join10(site, file));
    } catch {
      continue;
    }
    if (/^(<{7}|={7}|>{7})(\s|$)/m.test(text)) marked.push(file);
  }
  return marked;
}
async function uncommittedCount(subprocess, worktreePath) {
  const status = await tryRunGit(subprocess, worktreePath, ["status", "--short"]);
  return status === "" ? 0 : status.split(/\r?\n/).filter((line) => line.trim() !== "").length;
}
var STATUS_RECORD = /^([ MADRCU?!]{2}) ([\s\S]+)$/;
async function dirtyPaths(subprocess, site) {
  const status = await tryRunGit(subprocess, site, ["status", "--porcelain=v1", "-z"]);
  if (status === "") return [];
  const records = status.split("\0");
  const dirty = [];
  for (let index = 0; index < records.length; index += 1) {
    const parsed = STATUS_RECORD.exec(records[index]) ?? STATUS_RECORD.exec(` ${records[index]}`);
    if (parsed === null) continue;
    const [, columns, path] = parsed;
    if (columns === "??") continue;
    if (columns.includes("R") || columns.includes("C")) index += 1;
    dirty.push(path);
  }
  return dirty;
}
async function dirtyPathsInTheWay(subprocess, site, branch, target) {
  const dirty = await dirtyPaths(subprocess, site);
  if (dirty.length === 0) return [];
  const base = await tryRunGit(subprocess, site, ["merge-base", target, branch]);
  if (base === "") return [];
  const written = new Set(
    (await tryRunGit(subprocess, site, ["diff", "--name-only", base, branch])).split(/\r?\n/).map((path) => path.trim()).filter((path) => path !== "")
  );
  return dirty.filter((path) => written.has(path));
}
async function resolveMergeTarget(subprocess, mainRepo, requested, taskBranch) {
  const name2 = basename7(mainRepo);
  const checkedOut = await tryRunGit(subprocess, mainRepo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const onBranch = checkedOut !== "" && checkedOut !== "HEAD";
  const explicit = typeof requested === "string" ? requested.trim() : "";
  if (explicit !== "") {
    if (explicit === taskBranch) {
      throw coded("E4008", `merge target '${explicit}' is the branch being merged, so it cannot be the branch merged into`);
    }
    if (!await gitSucceeded(subprocess, mainRepo, ["show-ref", "--verify", "--quiet", `refs/heads/${explicit}`])) {
      throw coded("E4008", `merge target '${explicit}' is not a local branch of '${name2}'`);
    }
    return explicit;
  }
  if (!onBranch) {
    throw coded("E4008", `'${name2}' has no branch checked out; name the branch to merge into`);
  }
  return checkedOut;
}
async function mergeCandidates(subprocess, mainRepo, listed, taskBranch, checkedOut) {
  const output = await tryRunGit(subprocess, mainRepo, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
  const taken = new Set(listed.filter((row) => !row.isMain).map((row) => row.branch).filter(Boolean));
  if (taskBranch) taken.add(taskBranch);
  return output.split(/\r?\n/).map((line) => line.trim()).filter((branch) => branch !== "" && !taken.has(branch)).sort((left, right) => left === checkedOut ? -1 : right === checkedOut ? 1 : left.localeCompare(right));
}
async function mergeIntoBranch(subprocess, mainRepo, branch, target) {
  const checkedOut = await tryRunGit(subprocess, mainRepo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (target === checkedOut) {
    const pending = await dirtyPathsInTheWay(subprocess, mainRepo, branch, target);
    if (pending.length > 0) {
      throw coded(
        "E5004",
        `the checkout at ${mainRepo} has uncommitted work that this merge would overwrite: ${pending.join(", ")}. Commit or stash it, then finish the task.`
      );
    }
    try {
      await runGit(subprocess, mainRepo, ["merge", "--no-ff", "--no-edit", branch]);
    } catch (error) {
      await gitSucceeded(subprocess, mainRepo, ["merge", "--abort"]);
      throw error;
    }
    return;
  }
  const holder = await mkdtemp(join10(tmpdir(), "dsh-worktree-space-merge-"));
  const worktree = join10(holder, "worktree");
  const drop = async ({ aborted }) => {
    if (aborted) await gitSucceeded(subprocess, worktree, ["merge", "--abort"]);
    if (!await gitSucceeded(subprocess, mainRepo, ["worktree", "remove", "--force", worktree])) {
      await gitSucceeded(subprocess, mainRepo, ["worktree", "prune"]);
    }
    await rm3(holder, { recursive: true, force: true });
  };
  try {
    await runGit(subprocess, mainRepo, ["worktree", "add", worktree, target]);
    await runGit(subprocess, worktree, ["merge", "--no-ff", "--no-edit", branch]);
  } catch (error) {
    await drop({ aborted: true });
    throw error;
  }
  await drop({ aborted: false });
}
async function auditOutcome(repositories, warnings, phase) {
  for (const entry of repositories) {
    if (typeof entry?.error !== "string" || entry.error === "") continue;
    await recordError(entry.error, {
      phase,
      repository: entry.name ?? "",
      worktree: entry.path ?? "",
      mainRepo: entry.mainRepo ?? "",
      branch: entry.branch ?? "",
      // E5001 is the case with a way forward that is not "try again" - a merge
      // has to be settled first - and E5003 is a plain failure to retry. They
      // read alike in the message, which is why they are two codes.
      code: entry.conflict === true ? "E5001" : "E5003",
      msg: entry.conflict === true ? `Finishing ${entry.name ?? "this repository"} stopped on unmerged work, so nothing of that worktree was removed. The conflict has to be settled, or the branch deleted by hand, before the task space can be finished.` : `Finishing ${entry.name ?? "this repository"} failed, so that worktree and its branch are still on disk. The rest of the task space went as planned; this one needs a second attempt.`,
      ...entry.conflict === true ? { conflict: true } : {},
      ...typeof entry.mergeSite === "string" && entry.mergeSite !== "" ? { mergeSite: entry.mergeSite } : {},
      ...Array.isArray(entry.conflictedFiles) && entry.conflictedFiles.length > 0 ? { conflictedFiles: entry.conflictedFiles } : {}
    });
  }
  for (const warning of warnings) await recordWarning(warning, { phase });
}
async function planTask(subprocess, { task, project, tasksRoot, targets } = {}) {
  if (typeof tasksRoot !== "string" || tasksRoot.trim() === "") throw coded("E1004", "a tasks root is required");
  const projectName = validateProjectName(project);
  const taskPath = taskSpacePath(tasksRoot, projectName, task);
  if (!existsSync6(taskPath)) throw coded("E2003", `no such task space: ${taskPath}`);
  auditEnter({ task, project: projectName, tasksRoot });
  const entries = await readdir6(taskPath, { withFileTypes: true });
  const worktrees = [];
  const strays = [];
  for (const entry of entries) {
    const entryPath = join10(taskPath, entry.name);
    if (entry.isDirectory() && await isLinkedWorktree(entryPath)) {
      worktrees.push(entryPath);
      continue;
    }
    if (TASK_OWNED_FILES.includes(entry.name)) continue;
    const kind = strayKind(entry.name, entry.isDirectory());
    strays.push({
      name: entry.name,
      directory: entry.isDirectory(),
      // Only the user's own directories are worth walking: nobody needs a
      // document count of `node_modules`.
      documents: kind !== "content" ? 0 : entry.isDirectory() ? await countDocuments(entryPath) : isDocument(entry.name) ? 1 : 0,
      kind
    });
  }
  if (worktrees.length === 0) throw coded("E2004", `no git worktrees found in ${taskPath}`);
  const repositories = [];
  let mergeTarget2;
  let changedFiles = 0;
  let commits = 0;
  for (const worktreePath of worktrees) {
    const name2 = basename7(worktreePath);
    const branch = await tryRunGit(subprocess, worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const status = await tryRunGit(subprocess, worktreePath, ["status", "--short", "--branch"]);
    const lines = status === "" ? [] : status.split(/\r?\n/);
    const changed = lines.filter((line) => line !== "" && !line.startsWith("## ")).length;
    const plan = { name: name2, path: worktreePath, mainRepo: "", branch, changedFiles: changed, branches: [] };
    const porcelain = await tryRunGit(subprocess, worktreePath, ["worktree", "list", "--porcelain"]);
    const listed = parseWorktrees(porcelain);
    const mainRepo = listed.find((row) => row.isMain)?.path ?? "";
    plan.mainRepo = mainRepo;
    if (mainRepo === "") plan.error = "cannot locate the source repository";
    else {
      const checkedOut = await tryRunGit(subprocess, mainRepo, ["rev-parse", "--abbrev-ref", "HEAD"]);
      if (checkedOut !== "" && checkedOut !== "HEAD") plan.checkedOut = checkedOut;
      plan.branches = await mergeCandidates(subprocess, mainRepo, listed, branch, plan.checkedOut);
      try {
        plan.target = await resolveMergeTarget(subprocess, mainRepo, targets?.[name2], branch);
        const ahead = await tryRunGit(subprocess, worktreePath, ["rev-list", "--count", `${plan.target}..HEAD`]);
        const counted = Number.parseInt(ahead, 10);
        if (Number.isFinite(counted)) plan.commits = counted;
        mergeTarget2 = mergeTarget2 ?? plan.target;
      } catch (error) {
        plan.error = error.message;
      }
    }
    changedFiles += plan.changedFiles;
    commits += plan.commits ?? 0;
    repositories.push(plan);
  }
  await auditOutcome(repositories, [], "plan");
  return { task, project: projectName, path: taskPath, tasksRoot: tasksRoot.trim(), mergeTarget: mergeTarget2, changedFiles, commits, repositories, strays };
}
var DOCUMENT_EXTENSIONS = /* @__PURE__ */ new Set([".md", ".markdown", ".mdx", ".txt", ".rst", ".adoc"]);
var BUILD_DIRECTORIES = /* @__PURE__ */ new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "output",
  "target",
  "bin",
  "obj",
  "coverage",
  ".cache",
  ".next",
  ".nuxt",
  ".turbo",
  ".parcel-cache",
  "__pycache__",
  ".pytest_cache",
  ".gradle",
  ".m2",
  ".venv",
  "venv",
  "vendor"
]);
var EDITOR_DIRECTORIES = /* @__PURE__ */ new Set([".idea", ".vscode", ".vs"]);
var EDITOR_FILES = /* @__PURE__ */ new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);
var BUILD_FILE_SUFFIXES = [".o", ".obj", ".pyc", ".pyo", ".class", ".tsbuildinfo", ".tmp", ".orig", ".rej"];
var EDITOR_FILE_SUFFIXES = [".iml", ".swp", ".swo", "~"];
function strayKind(name2, directory) {
  if (directory) {
    if (BUILD_DIRECTORIES.has(name2)) return "build";
    if (EDITOR_DIRECTORIES.has(name2)) return "editor";
    return "content";
  }
  if (EDITOR_FILES.has(name2) || EDITOR_FILE_SUFFIXES.some((suffix) => name2.endsWith(suffix))) return "editor";
  if (BUILD_FILE_SUFFIXES.some((suffix) => name2.endsWith(suffix))) return "build";
  return "content";
}
function isDocument(name2) {
  const dot = name2.lastIndexOf(".");
  return dot > 0 && DOCUMENT_EXTENSIONS.has(name2.slice(dot).toLowerCase());
}
async function countDocuments(directory, { maxEntries = 200 } = {}) {
  let seen = 0;
  let found = 0;
  const queue = [directory];
  while (queue.length > 0 && seen < maxEntries) {
    const current = queue.shift();
    let children;
    try {
      children = await readdir6(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      seen += 1;
      if (seen > maxEntries) break;
      if (child.isDirectory()) queue.push(join10(current, child.name));
      else if (isDocument(child.name)) found += 1;
    }
  }
  return found;
}
async function finishTask(subprocess, options) {
  const {
    task,
    project,
    tasksRoot,
    merge = false,
    target,
    targets,
    deleteBranch = false,
    force = false,
    cleanStray = false,
    keep = [],
    documentsDirectory,
    discardDocuments = false,
    cause,
    acknowledgeDelivery = false,
    deliveryArchive
  } = options;
  if (deleteBranch && !merge && !force) {
    throw coded("E4007", "deleting a branch that was never merged requires force");
  }
  if (typeof tasksRoot !== "string" || tasksRoot.trim() === "") throw coded("E1004", "a tasks root is required");
  const projectName = validateProjectName(project);
  const taskPath = taskSpacePath(tasksRoot, projectName, task);
  if (!existsSync6(taskPath)) throw coded("E2003", `no such task space: ${taskPath}`);
  auditEnter({ task, project: projectName, tasksRoot });
  if (!existsSync6(join10(taskPath, TASK_METADATA))) {
    throw coded(
      "E2005",
      `${taskPath} holds no ${TASK_METADATA}, so this plugin has no record of creating it and nothing in it will be deleted.
  What is missing: ${join10(taskPath, TASK_METADATA)}
  If this really is a task space this plugin made and its record was removed by hand, restore the file from a backup before finishing it.`
    );
  }
  const warnings = [];
  const recorded = await readTaskMetadata(taskPath);
  const taskBranch = typeof recorded?.branch === "string" ? recorded.branch : "";
  if (taskBranch === "") {
    warnings.push(`no task branch is recorded in ${taskPath}; no branch was deleted in any repository`);
  }
  const strayed = applyStraysPolicy(deliveryPolicyOf(recorded), {
    cleanStray,
    discardDocuments,
    documentsDirectory,
    keep,
    force
  }, deliveryArchive, taskPath);
  const strayCleanStray = strayed.cleanStray;
  const strayDiscardDocuments = strayed.discardDocuments;
  const strayDestination = strayed.documentsDirectory;
  if (strayDestination !== "") assertIsolated(taskPath, strayDestination);
  const gateWarning = await assertDeliveryGate(recorded, taskPath, { merge, bypass: acknowledgeDelivery === true });
  if (gateWarning !== void 0) warnings.push(gateWarning);
  const entries = await readdir6(taskPath, { withFileTypes: true });
  const worktrees = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const worktreePath = join10(taskPath, entry.name);
    if (await isLinkedWorktree(worktreePath)) worktrees.push(worktreePath);
  }
  if (worktrees.length === 0) throw coded("E2004", `no git worktrees found in ${taskPath}`);
  const repositories = [];
  let failed = false;
  for (const worktreePath of worktrees) {
    const name2 = basename7(worktreePath);
    const branch = await tryRunGit(subprocess, worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const porcelain = await tryRunGit(subprocess, worktreePath, ["worktree", "list", "--porcelain"]);
    const mainRepo = parseWorktrees(porcelain).find((row) => row.isMain)?.path ?? "";
    const outcome = { name: name2, path: worktreePath, mainRepo, branch, merged: false, removed: false, branchDeleted: false, mergeInProgress: false, mergeSite: "", conflictedFiles: [] };
    if (mainRepo === "") {
      outcome.error = "cannot locate the source repository";
      repositories.push(outcome);
      failed = true;
      continue;
    }
    const midMerge = await mergeInProgress(subprocess, worktreePath);
    if ((merge || !deleteBranch) && !force && !midMerge && await uncommittedCount(subprocess, worktreePath) > 0) {
      outcome.error = `uncommitted work is waiting in ${worktreePath}; commit it before the task can be finished`;
      repositories.push(outcome);
      failed = true;
      continue;
    }
    if (merge && midMerge) {
      const pending = await conflictMarkers(subprocess, worktreePath);
      outcome.conflict = true;
      outcome.mergeSite = worktreePath;
      outcome.mergeInProgress = true;
      outcome.conflictedFiles = pending.length > 0 ? pending : await conflictedFiles(subprocess, worktreePath);
      outcome.error = pending.length > 0 ? `the resolved merge still has conflict markers in ${pending.join(", ")}` : `the merge in ${worktreePath} is resolved but not committed`;
      repositories.push(outcome);
      failed = true;
      continue;
    }
    if (merge && (branch === "" || branch === "HEAD")) {
      outcome.error = branch === "" ? `'${name2}' reports no branch, so there is nothing in it to merge; check that ${worktreePath} is still the worktree this task made` : `'${name2}' is on a detached HEAD, so its commits belong to no branch and there is nothing to merge them from. Check a branch out in ${worktreePath}, or move the work onto one, before the task can be finished.`;
      repositories.push(outcome);
      failed = true;
      continue;
    }
    if (merge) {
      try {
        const mergeTarget2 = await resolveMergeTarget(subprocess, mainRepo, targets?.[name2] ?? target, branch);
        outcome.target = mergeTarget2;
        if (!await gitSucceeded(subprocess, worktreePath, ["merge-base", "--is-ancestor", mergeTarget2, branch])) {
          const rehearsalBase = await runGit(subprocess, worktreePath, ["rev-parse", "HEAD"]);
          try {
            await runGit(subprocess, worktreePath, ["merge", "--no-ff", "--no-edit", mergeTarget2]);
          } catch (error) {
            if (await mergeInProgress(subprocess, worktreePath)) {
              outcome.conflict = true;
              outcome.mergeSite = worktreePath;
              outcome.mergeInProgress = true;
              outcome.conflictedFiles = await conflictedFiles(subprocess, worktreePath);
              outcome.error = error.message;
              repositories.push(outcome);
              failed = true;
              continue;
            }
            await gitSucceeded(subprocess, worktreePath, ["merge", "--abort"]);
            outcome.error = error.message;
            repositories.push(outcome);
            failed = true;
            continue;
          }
          await runGit(subprocess, worktreePath, ["reset", "--hard", rehearsalBase]);
        }
        await mergeIntoBranch(subprocess, mainRepo, branch, mergeTarget2);
        outcome.merged = true;
      } catch (error) {
        const dirtyCheckout = error?.code === "E5004" || /would be overwritten by merge/i.test(String(error?.message ?? ""));
        outcome.conflict = !dirtyCheckout;
        await gitSucceeded(subprocess, mainRepo, ["merge", "--abort"]);
        outcome.error = error.message;
        repositories.push(outcome);
        failed = true;
        continue;
      }
    }
    const removeArgs = force ? ["worktree", "remove", "--force", worktreePath] : ["worktree", "remove", worktreePath];
    const refused = refuseDelete(tasksRoot, worktreePath, `the worktree '${name2}'`);
    if (refused !== "") {
      outcome.error = refused;
      repositories.push(outcome);
      failed = true;
      continue;
    }
    if (!await gitSucceeded(subprocess, mainRepo, removeArgs)) {
      outcome.error = "failed to remove the worktree (uncommitted changes? force it deliberately)";
      repositories.push(outcome);
      failed = true;
      continue;
    }
    outcome.removed = true;
    if (deleteBranch) {
      if (branch !== taskBranch) {
        outcome.branchDeleted = false;
        warnings.push(
          branch === "" ? `'${name2}' has no branch checked out, so no branch was deleted in '${mainRepo}'` : `'${name2}' is on '${branch}', not on the task branch '${taskBranch}', so that branch was left alone in '${mainRepo}'`
        );
      } else {
        const deleted = await gitSucceeded(
          subprocess,
          mainRepo,
          // `--` because this is the one git call that leaves the container: a
          // branch name git itself will not start with a dash is read here, but
          // `--` costs nothing and closes the shape of argument where a
          // different name someday might.
          force ? ["branch", "-D", "--", branch] : ["branch", "-d", "--", branch]
        );
        outcome.branchDeleted = deleted;
        if (!deleted) warnings.push(`branch '${branch}' was not deleted in '${name2}'`);
      }
    }
    repositories.push(outcome);
  }
  const leftovers = await readdir6(taskPath, { withFileTypes: true });
  let stillOpen = false;
  for (const entry of leftovers) {
    if (entry.isDirectory() && await isLinkedWorktree(join10(taskPath, entry.name))) {
      stillOpen = true;
      break;
    }
  }
  if (!stillOpen) {
    for (const name2 of TASK_OWNED_FILES) await rm3(join10(taskPath, name2), { force: true });
  }
  const remainingEntries = await readdir6(taskPath, { withFileTypes: true });
  const strays = [];
  const content = /* @__PURE__ */ new Set();
  for (const entry of remainingEntries) {
    if (entry.isDirectory() && await isLinkedWorktree(join10(taskPath, entry.name))) continue;
    if (TASK_OWNED_FILES.includes(entry.name)) continue;
    strays.push(entry.name);
    if (strayKind(entry.name, entry.isDirectory()) === "content") content.add(entry.name);
    if (entry.isDirectory()) {
      const refused = refuseDelete(tasksRoot, join10(taskPath, entry.name), `the leftover '${entry.name}'`);
      if (refused !== "") {
        keep.push(entry.name);
        warnings.push(refused);
        strays.pop();
        content.delete(entry.name);
        continue;
      }
    }
  }
  const removedStrays = [];
  const archivedStrays = [];
  const keptByFailure = [];
  for (const name2 of content) {
    if (keep.includes(name2)) continue;
    if (strayDestination === "") {
      if (!strayDiscardDocuments) continue;
    } else {
      try {
        await mkdir3(strayDestination, { recursive: true });
        await cp(join10(taskPath, name2), join10(strayDestination, name2), { recursive: true, force: false, errorOnExist: true });
      } catch (error) {
        warnings.push(`could not archive '${name2}' to '${strayDestination}': ${error.message}`);
        keptByFailure.push(name2);
        continue;
      }
      archivedStrays.push(name2);
    }
    await rm3(join10(taskPath, name2), { recursive: true, force: true });
    if (strayDestination === "") removedStrays.push(name2);
  }
  if (strayCleanStray) {
    for (const name2 of strays) {
      if (keep.includes(name2) || keptByFailure.includes(name2)) continue;
      if (archivedStrays.includes(name2) || removedStrays.includes(name2)) continue;
      await rm3(join10(taskPath, name2), { recursive: true, force: true });
      removedStrays.push(name2);
    }
  }
  const remaining = await readdir6(taskPath);
  let containerRemoved = false;
  if (remaining.length === 0) {
    containerRemoved = true;
    try {
      await rmdir(taskPath);
    } catch {
      containerRemoved = false;
    }
  }
  await auditOutcome(repositories, warnings, "done");
  const removedCount = repositories.filter((entry) => entry?.removed === true).length;
  if (!failed) {
    await recordEvent(
      cause ? "warn" : "info",
      cause ? `The task space was taken down because ${cause} The create had already made this work, so removing it is what makes the whole create fail as one thing: nothing of it is left behind.` : `Finished the task: ${removedCount} worktree${removedCount === 1 ? "" : "s"} removed${deleteBranch ? " and the branches deleted" : ", the branches kept"}${containerRemoved ? ", and the task space directory itself is gone" : ", with the task space directory left in place for what it still holds"}.`,
      {
        phase: "done",
        ...cause ? { cause } : {},
        removed: repositories.filter((entry) => entry?.removed === true).map((entry) => entry.name),
        ...deleteBranch ? { branchesDeleted: true } : { branchesKept: true },
        ...containerRemoved ? { containerRemoved: true } : {}
      }
    );
    if (cause === void 0) {
      const policy = deliveryPolicyOf(recorded);
      const envId = typeof recorded?.deploymentEnvId === "string" ? recorded.deploymentEnvId : "";
      if (policy.deploy.target !== "none" && envId !== "") {
        try {
          const outcome = await destroyDeployment(subprocess, taskPath, envId);
          if (outcome.warning !== void 0) warnings.push(outcome.warning);
        } catch (error) {
          warnings.push(`deployment cleanup failed for ${envId}: ${error.message}`);
        }
      }
    }
  } else {
    const stuck = repositories.filter((entry) => entry?.removed !== true).map((entry) => entry.name);
    await recordEvent(
      "error",
      `Finishing the task did not complete. ${stuck.length} of ${repositories.length} repositories could not be finished and are still on disk; the rest went as planned.`,
      {
        phase: "done",
        code: "E5002",
        ...cause ? { cause } : {},
        ...stuck.length > 0 ? { notRemoved: stuck } : {}
      }
    );
  }
  return {
    task,
    project: projectName,
    path: taskPath,
    mergeTarget: repositories.find((entry) => entry.target)?.target,
    repositories,
    strays: strays.filter((name2) => !removedStrays.includes(name2) && !archivedStrays.includes(name2)),
    archivedStrays,
    removedStrays,
    containerRemoved,
    failed,
    warnings
  };
}

// src/host/task/scan-cache.js
var SCAN_CACHE_LIMIT = 4;
var STATUS_CACHE_LIMIT = 500;
var cleanPath = (value) => {
  const text = String(value ?? "");
  return text.length > 1 ? text.replace(/[\\/]+$/, "") : text;
};
var scans = /* @__PURE__ */ new Map();
var statuses = /* @__PURE__ */ new Map();
var remember = (map, key, value, limit) => {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value);
};
function scanKey(paths) {
  const unique = /* @__PURE__ */ new Set();
  for (const path of paths ?? []) {
    const cleaned = cleanPath(path);
    if (cleaned !== "") unique.add(cleaned);
  }
  return [...unique].sort().join("\n");
}
function rememberScan(paths, repositories) {
  const key = scanKey(paths);
  if (key === "") return;
  remember(scans, key, repositories, SCAN_CACHE_LIMIT);
}
function rememberStatus(path, status) {
  const key = cleanPath(path);
  if (key === "") return;
  remember(statuses, key, status, STATUS_CACHE_LIMIT);
}
function recallScan(paths) {
  const key = scanKey(paths);
  const repositories = key === "" ? void 0 : scans.get(key);
  if (repositories === void 0) return void 0;
  const remembered = {};
  for (const repository of repositories) {
    for (const worktree of repository.worktrees ?? []) {
      const status = statuses.get(cleanPath(worktree.path));
      if (status !== void 0) remembered[worktree.path] = status;
    }
  }
  return { repositories, statuses: remembered };
}

// src/host/task/skill.js
import { closeSync, existsSync as existsSync7, openSync, readFileSync, readSync } from "node:fs";
import { open as open2 } from "node:fs/promises";
import { basename as basename8, dirname as dirname4, join as join11, resolve as resolve4 } from "node:path";
import { fileURLToPath } from "node:url";
var PROVIDER_NAME = "dsh-worktree-space";
var SKILL_NAME = "task-worktree-space";
var PACKAGE_NAME = "dsh-worktree-space";
var BUNDLED_SKILL_RANK = 600;
var SKILL_FILE = "SKILL.md";
function packageRoot() {
  let directory = dirname4(fileURLToPath(import.meta.url));
  for (; ; ) {
    const manifest = join11(directory, "package.json");
    if (existsSync7(manifest)) {
      try {
        if (JSON.parse(readFileSync(manifest, "utf8")).name === PACKAGE_NAME) return directory;
      } catch {
      }
    }
    const parent = dirname4(directory);
    if (parent === directory) {
      throw coded("E7001", `${PACKAGE_NAME}: cannot locate the package root for the bundled skill`);
    }
    directory = parent;
  }
}
var SKILL_MAX_BYTES = 256 * 1024;
async function readBounded(path, signal) {
  const handle = await open2(path, "r");
  try {
    const buffer = Buffer.alloc(SKILL_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > SKILL_MAX_BYTES) {
      throw coded("E7005", `${PACKAGE_NAME}: ${basename8(path)} is larger than the ${SKILL_MAX_BYTES} bytes a skill may hold`);
    }
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}
function readBoundedSync(path) {
  const handle = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(SKILL_MAX_BYTES + 1);
    const bytesRead = readSync(handle, buffer, 0, buffer.length, 0);
    if (bytesRead > SKILL_MAX_BYTES) {
      throw coded("E7005", `${PACKAGE_NAME}: ${basename8(path)} is larger than the ${SKILL_MAX_BYTES} bytes a skill may hold`);
    }
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    closeSync(handle);
  }
}
function parseSkillFile(raw, path) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw);
  if (frontmatter?.[1] === void 0) throw coded("E7002", `${PACKAGE_NAME}: ${path} has no YAML frontmatter`);
  const description = /^description:[ \t]*(.+?)[ \t]*$/mu.exec(frontmatter[1])?.[1];
  const declared = /^name:[ \t]*(.+?)[ \t]*$/mu.exec(frontmatter[1])?.[1];
  if (description === void 0 || description === "") throw coded("E7003", `${PACKAGE_NAME}: ${path} has no description`);
  if (declared !== SKILL_NAME) {
    throw coded("E7004", `${PACKAGE_NAME}: ${path} declares name '${declared}' where '${SKILL_NAME}' is served`);
  }
  return { description, content: raw.slice(frontmatter[0].length).trim() };
}
function registerTaskSkill(ctx) {
  if (typeof ctx.get !== "function") return void 0;
  const skills = ctx.get("skills");
  if (skills === void 0 || skills === null || typeof skills.registerProvider !== "function") return void 0;
  const directory = join11(packageRoot(), "assets", "skill", SKILL_NAME);
  const skillPath = join11(directory, SKILL_FILE);
  const { description } = parseSkillFile(readBoundedSync(skillPath), skillPath);
  const candidate = {
    name: SKILL_NAME,
    description,
    path: skillPath,
    invocation: { modelInvocable: true, userInvocable: true },
    provider: PROVIDER_NAME,
    source: "bundled",
    rank: BUNDLED_SKILL_RANK,
    resourceBase: { kind: "directory", path: directory },
    locator: skillPath
  };
  const provider = {
    name: PROVIDER_NAME,
    list: () => Promise.resolve([candidate]),
    async get(requested, options) {
      const asked = typeof requested?.locator === "string" ? requested.locator : "";
      if (asked !== "" && resolve4(asked) !== resolve4(skillPath)) {
        throw coded("E7005", `${PACKAGE_NAME}: not a skill this provider serves: ${basename8(asked)}`);
      }
      const raw = await readBounded(skillPath, options?.signal);
      const loaded = parseSkillFile(raw, skillPath);
      const { rank: _rank, locator: _locator, ...summary } = candidate;
      return { ...summary, description: loaded.description, content: loaded.content };
    }
  };
  return skills.registerProvider(() => provider);
}

// src/host/task/tool.js
import { defineTool } from "@deepseek-ai/dsh-tools";
var DESCRIPTION = [
  "Create, list and finish a per-task Git worktree workspace that spans one or more repositories: inside the task space container, one directory per project (the source root's own directory name) holding one directory per task, and under that a worktree of every selected repository, all on one branch.",
  "",
  "Drive it in order: suggest-root, then create, then list, then done. Ask the user for the task name and the Worktree Space container root before creating anything.",
  `A create does both halves: it makes the directory and the worktrees, and registers the result as a DSH Workspace, which is what puts the task space in the workspace list. Opening a session in it is not something a tool call can do - that is the panel's "Create and open", or picking the registered Workspace in the workspace list - so say which entry opens it rather than leaving the user to find it. A create that answers with a warning instead says its Workspace was not registered, and names what to do about it.`,
  "Every repository shares one branch, `task/<task>` unless the user asks for another prefix and it is passed as branchPrefix.",
  'When a task that already exists turns out to need another repository, add it with action "add" rather than creating a second task: name the container (tasksRoot or sourceRoot), the project and the task, and pass each repository as an absolute path. A repository added this way may sit anywhere on disk, on another volume included \u2014 nothing later depends on where it is \u2014 but it joins the branch the task is already on and starts from its own HEAD unless baseRef says otherwise. Nothing is removed from a task this way.',
  "Pass merge only when the user asked to merge, and deleteBranch only after a merge: a branch that landed on its target is safe to remove, and that is the tidying-up this tool does on its own.",
  "This tool cannot do `force`, and asking for it is an error rather than a warning: discarding uncommitted work, and force-deleting a branch whose commits landed nowhere, are irreversible and have to be the user's own decision. Abandoning a task needs force too, so it is not available here either. When a task really has to be abandoned that way, say so and ask them to open the Worktree Space management page and finish it there, rather than retrying.",
  "Finishing commits nothing itself: a worktree still holding uncommitted work stops the finish and is named, and the commit is the caller's to make - an agent session opened in the task space writes a better message than a fixed one. force discards that work as the worktree goes.",
  "A repository answered with `mergeInProgress` holds an unresolved merge at `mergeSite`: resolve the files listed in `conflictedFiles` in that checkout, commit the merge there, then call done again with the same merge request to finish. Never resolve a conflict by picking a side the user has not picked.",
  "A merge lands on the branch each source repository has checked out unless another is named; a branch that is checked out nowhere is merged in a worktree of its own, so no source checkout is ever switched.",
  "The task's delivery policy - whether a merge waits for a passing deployment smoke, and for a human acceptance ack - is decided by the user and recorded in the task metadata at create time. It is not a tool argument, and done enforces it: a refused merge names what is missing, and the way past it is to deploy, smoke, and be accepted - not to retry.",
  "The task's note names the conflict mode too: a task whose policy is conflicts=agent-auto expects the caller to resolve a returned conflict itself - ask no one, fix the files listed in conflictedFiles in that checkout, commit the merge there, and call done again. Under any other mode a returned conflict is reported and waits for the user."
].join("\n");
function emptyRow(name2) {
  return {
    name: name2,
    path: "",
    branch: "",
    changedFiles: 0,
    merged: false,
    removed: false,
    branchDeleted: false,
    mainRepo: "",
    mergeInProgress: false,
    mergeSite: "",
    conflictedFiles: [],
    error: ""
  };
}
var OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: { type: "string", required: true },
    summary: { type: "string", required: true },
    task: { type: "string", required: true },
    project: { type: "string", required: true },
    branch: { type: "string", required: true },
    container: { type: "string", required: true },
    tasksRoot: { type: "string", required: true },
    suggested: { type: "string", required: true },
    failed: { type: "boolean", required: true },
    warnings: { type: "array", required: true, items: { type: "string" } },
    repositories: {
      type: "array",
      required: true,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string", required: true },
          path: { type: "string", required: true },
          branch: { type: "string", required: true },
          changedFiles: { type: "integer", required: true },
          merged: { type: "boolean", required: true },
          removed: { type: "boolean", required: true },
          branchDeleted: { type: "boolean", required: true },
          mainRepo: { type: "string", required: true },
          mergeInProgress: { type: "boolean", required: true },
          mergeSite: { type: "string", required: true },
          conflictedFiles: { type: "array", required: true, items: { type: "string" } },
          error: { type: "string", required: true }
        }
      }
    }
  }
};
function envelope(action) {
  return {
    action,
    summary: "",
    task: "",
    project: "",
    branch: "",
    container: "",
    tasksRoot: "",
    suggested: "",
    failed: false,
    warnings: [],
    repositories: []
  };
}
function required(value, name2) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "") throw coded("E7006", `${name2} is required for this action`);
  return text;
}
async function containerFor(subprocess, tasksRoot, sourceRoot, configuredRoot = "") {
  const explicit = typeof tasksRoot === "string" ? tasksRoot.trim() : "";
  if (explicit !== "") return explicit;
  const source = typeof sourceRoot === "string" ? sourceRoot.trim() : "";
  if (source === "") throw coded("E7006", "tasksRoot is required (or sourceRoot, to use its recommended task space)");
  return (await suggestTaskRoot(subprocess, source, { configuredRoot })).suggested;
}
function projectFor(project, sourceRoot) {
  const explicit = typeof project === "string" ? project.trim() : "";
  if (explicit !== "") return explicit;
  const source = typeof sourceRoot === "string" ? sourceRoot.trim() : "";
  if (source === "") throw coded("E7006", "project is required (or sourceRoot, whose directory name it is)");
  return projectNameFor(source);
}
var REGISTRY_METHODS = ["create", "list", "delete"];
var NO_WORKSPACE_REGISTRY = "this deployment serves no Workspace registry to register it with";
function workspaceRegistryOf(ctx) {
  if (typeof ctx.get !== "function") return void 0;
  const registry = ctx.get("workspaceRegistry");
  if (registry === null || registry === void 0) return void 0;
  return REGISTRY_METHODS.some((name2) => typeof registry[name2] === "function") ? registry : void 0;
}
async function registerTaskWorkspace(registry, taskPath, sourceRoot, task) {
  if (typeof registry.create !== "function") return NO_WORKSPACE_REGISTRY;
  let title;
  try {
    const source = typeof registry.resolveByPath === "function" ? await registry.resolveByPath(sourceRoot) : void 0;
    if (source !== null && source !== void 0 && typeof source.title === "string" && source.title !== "") {
      title = `${source.title}/${task}`;
    }
  } catch {
  }
  try {
    await registry.create(taskPath, title);
    return "";
  } catch (error) {
    return String(error?.message ?? error);
  }
}
async function dropTaskWorkspace(registry, taskPath) {
  if (registry === void 0 || typeof registry.list !== "function" || typeof registry.delete !== "function") return "";
  const byHand = "; remove it from the workspace list by hand if it is still there";
  let registered;
  try {
    const target = canonicalPath(taskPath);
    registered = registry.list().filter((entry) => entry !== null && entry !== void 0 && canonicalPath(entry.path) === target);
  } catch (error) {
    return `the task space is gone but its DSH Workspace registration could not be read (${String(error?.message ?? error)})${byHand}`;
  }
  const problems = [];
  for (const entry of registered) {
    try {
      await registry.delete(entry.id);
    } catch (error) {
      problems.push(String(error?.message ?? error));
    }
  }
  if (problems.length === 0) return "";
  return `the task space is gone but its DSH Workspace registration could not be dropped (${problems.join("; ")})${byHand}`;
}
function refuseIrreversible(args) {
  if (args.force !== true) return;
  throw coded(
    "E7007",
    "force cannot be done from a tool call: discarding uncommitted work, and force-deleting a branch whose commits landed nowhere, are irreversible and have to be the user's own decision. Abandoning a task (deleteBranch without merge) needs force too, so it is not available here either. Ask them to open the Worktree Space management page and finish this task space there. Merging, and removing a branch once it has landed, are both still available here."
  );
}
function summarize(action, value) {
  if (action === "suggest-root") {
    const names = value.repositories.map((row) => row.name).join(", ");
    return `Recommended task space for ${value.tasksRoot === "" ? "the source root" : value.tasksRoot}: ${value.suggested}. ${value.repositories.length} source repositor${value.repositories.length === 1 ? "y" : "ies"}${names === "" ? "" : `: ${names}`}.`;
  }
  if (action === "create") {
    const names = value.repositories.map((row) => row.name).join(", ");
    return `Task '${value.task}' is ready at ${value.container} on branch '${value.branch}', with worktrees of: ${names}.${value.warnings.length === 0 ? "" : ` Warnings: ${value.warnings.join("; ")}.`}`;
  }
  if (action === "add") {
    const names = value.repositories.map((row) => row.name).join(", ");
    return `Added to task '${value.task}' at ${value.container} on branch '${value.branch}': ${names}.${value.warnings.length === 0 ? "" : ` Warnings: ${value.warnings.join("; ")}.`}`;
  }
  if (action === "list") {
    if (value.repositories.length === 0 && value.container === "") return `No task space at ${value.tasksRoot}.`;
    const perTask = value.repositories.filter((row) => row.name !== "").length;
    return `${value.repositories.length} task${value.repositories.length === 1 ? "" : "s"} under ${value.tasksRoot} (${perTask} worktree${perTask === 1 ? "" : "s"}).`;
  }
  const failed = value.failed ? " Some repositories need attention:" : "";
  const attention = value.repositories.filter((row) => row.error !== "").map((row) => `${row.name}: ${row.error}`).join("; ");
  const handedOn = value.repositories.filter((row) => row.mergeInProgress);
  const headline = handedOn.length === 0 ? `Task '${value.task}' finished. Task space ${value.container === "" ? "removed" : `kept at ${value.container}`}.` : `Task '${value.task}' is unfinished: a merge is waiting to be resolved in ${handedOn.map((row) => row.mergeSite).join(", ")}.`;
  const handoff = handedOn.length === 0 ? "" : ` Resolve ${handedOn.map((row) => row.conflictedFiles.join(", ")).filter((list) => list !== "").join("; ") || "the conflict"}, commit the merge there, then call done again.`;
  return `${headline}${failed}${attention}${handoff}${value.warnings.length === 0 ? "" : ` Warnings: ${value.warnings.join("; ")}.`}`;
}
var CARD_ROW_LIMIT = 20;
var CARD_WARNING_LIMIT = 3;
var CARD_TEXT_LIMIT = 4e3;
function cardText(result) {
  const meta = result !== null && typeof result === "object" && result.meta !== null && typeof result.meta === "object" && !Array.isArray(result.meta) ? result.meta : null;
  const parts = [];
  if (meta !== null) {
    if (typeof meta.summary === "string" && meta.summary !== "") parts.push(meta.summary);
    const rows = Array.isArray(meta.repositories) ? meta.repositories : [];
    const lines = rows.map((row) => {
      const name2 = typeof row?.name === "string" ? row.name : "?";
      const state = row?.error ? `failed: ${String(row.error)}` : row?.merged === true ? "merged" : "not merged";
      return `${name2}: ${state}${row?.removed === true ? ", worktree removed" : ""}`;
    });
    const total = typeof meta.total === "number" && Number.isFinite(meta.total) ? meta.total : rows.length;
    if (total > rows.length) lines.push(`... and ${total - rows.length} more repositories`);
    if (lines.length > 0) parts.push(lines.join("\n"));
    const warnings = Array.isArray(meta.warnings) ? meta.warnings.filter((one) => typeof one === "string") : [];
    if (warnings.length > 0) parts.push(`warnings: ${warnings.join("; ")}`);
  } else if (Array.isArray(result?.content)) {
    const text2 = result.content.map((block) => block?.type === "text" && typeof block.text === "string" ? block.text : "").filter((one) => one !== "").join("\n\n");
    if (text2 !== "") parts.push(text2);
  }
  const text = parts.join("\n\n");
  return text.length > CARD_TEXT_LIMIT ? `${text.slice(0, CARD_TEXT_LIMIT)}
... (truncated)` : text;
}
function registerTaskTool(ctx, options = {}) {
  if (typeof ctx.get !== "function") return void 0;
  const tools = ctx.get("tools");
  if (tools === void 0 || tools === null || typeof tools.register !== "function") return void 0;
  const configuredRoot = () => typeof options.configuredRoot === "function" ? options.configuredRoot() : "";
  const configuredDeliveryDefaults2 = () => typeof options.configuredDeliveryDefaults === "function" ? options.configuredDeliveryDefaults() : {};
  const configuredArchive = () => typeof options.configuredArchive === "function" ? options.configuredArchive() : void 0;
  return tools.register(defineTool({
    name: "task_worktree_space",
    description: DESCRIPTION,
    parameters: {
      action: {
        type: "string",
        required: true,
        enum: ["suggest-root", "create", "add", "list", "done"],
        description: "suggest-root, create, add, list, or done."
      },
      task: { type: "string", description: "Name (create, add, done): the task space directory and branch suffix, with no separators or spaces." },
      project: { type: "string", description: "Project layer (add, list, done): the source root's own directory name. Omit when sourceRoot is given, since it is derived from it." },
      sourceRoot: { type: "string", description: "Directory of the repositories. Required for suggest-root and create." },
      tasksRoot: { type: "string", description: "Container for task spaces: beside the repositories' directory, never inside it or a parent of it. Omit for the recommendation." },
      repos: { type: "array", items: { type: "string" }, description: "Repository paths, as reported by suggest-root (create, add). Omit for every discovered (create). A bare name is read as relative to sourceRoot, which only names a repository sitting directly in it." },
      baseRef: { type: "string", description: "Start point (create, add). Omit for each repository HEAD." },
      branchPrefix: { type: "string", description: "Branch prefix (create, suggest-root): the branch is this plus the task name. Omit for the default task/." },
      merge: { type: "boolean", description: "Merge before removing the worktrees (done). Only on request." },
      target: { type: "string", description: "Branch to merge into (done), for every repository. Omit for the branch each source repository has checked out." },
      deleteBranch: { type: "boolean", description: "Delete each branch (done), after a merge. Needs merge; deleting a branch that never landed is refused here." },
      cleanStray: { type: "boolean", description: "Remove leftovers in the task space (done), except keep. Never reaches the user's own documents here." },
      keep: { type: "array", items: { type: "string" }, description: "Entries to keep with cleanStray (done)." },
      force: { type: "boolean", description: "Discard uncommitted changes (done). Refused here, always - the user decides that themselves, on the management page." }
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: "text", text: value.summary }],
      // The card's own projection, bounded here as well as at the card: a
      // hundred-repository task must neither bloat the session log nor a card.
      // `total` stays in place, so a capped list can never be read as the whole
      // answer.
      presentationMeta: (_args, value) => ({
        summary: value.summary,
        total: value.repositories.length,
        repositories: value.repositories.slice(0, CARD_ROW_LIMIT).map((row) => ({
          name: row.name,
          merged: row.merged,
          removed: row.removed,
          error: row.error
        })),
        warnings: value.warnings.slice(0, CARD_WARNING_LIMIT)
      })
    },
    async execute(args) {
      const action = args.action;
      if (action === "suggest-root") {
        const sourceRoot = required(args.sourceRoot, "sourceRoot");
        const result = await suggestTaskRoot(ctx.subprocess, sourceRoot, {
          tasksRoot: args.tasksRoot,
          branchPrefix: typeof args.branchPrefix === "string" ? args.branchPrefix : void 0,
          // The plugin's own setting outranks the recommendation: it is the user's
          // standing answer to where task spaces go, so the model proposes it too.
          configuredRoot: configuredRoot()
        });
        const value = envelope(action);
        value.tasksRoot = result.sourceRoot;
        value.suggested = result.suggested;
        value.repositories = result.repositories.map((entry) => ({ ...emptyRow(entry.name), path: entry.path, branch: entry.branch ?? "" }));
        value.summary = summarize(action, value);
        return value;
      }
      if (action === "create") {
        const sourceRoot = required(args.sourceRoot, "sourceRoot");
        const result = await createTask(ctx.subprocess, {
          sourceRoot,
          task: required(args.task, "task"),
          tasksRoot: args.tasksRoot,
          repos: Array.isArray(args.repos) ? args.repos : void 0,
          baseRef: typeof args.baseRef === "string" ? args.baseRef : void 0,
          branchPrefix: typeof args.branchPrefix === "string" ? args.branchPrefix : void 0,
          configuredRoot: configuredRoot(),
          // The policy is not a tool argument: the model never picks how a task is
          // delivered. It reads the same project defaults a dialog-made create
          // would, so a task started from a session lands on the same answers.
          deliveryDefaults: configuredDeliveryDefaults2()
        });
        const value = envelope(action);
        value.task = result.task;
        value.project = result.project;
        value.branch = result.branch;
        value.container = result.path;
        value.tasksRoot = result.tasksRoot;
        const registry = workspaceRegistryOf(ctx);
        const unregistered = registry === void 0 ? NO_WORKSPACE_REGISTRY : await registerTaskWorkspace(registry, result.path, sourceRoot, result.task);
        if (unregistered !== "") {
          value.warnings.push(
            `the task space is on disk but not registered as a DSH Workspace (${unregistered}); register it from the Worktree Space panel - "Create and open", or "Register again" after a create is refused - and open the task's session there; until it is registered, creating this task again is refused as E2002`
          );
        }
        value.repositories = result.repositories.map((entry) => ({ ...emptyRow(entry.name), path: entry.path, branch: result.branch }));
        value.summary = summarize(action, value);
        return value;
      }
      if (action === "add") {
        const task = required(args.task, "task");
        const tasksRoot = await containerFor(ctx.subprocess, args.tasksRoot, args.sourceRoot, configuredRoot());
        const project = projectFor(args.project, args.sourceRoot);
        const result = await addTaskRepositories(ctx.subprocess, {
          task,
          project,
          tasksRoot,
          // Absolute paths, not names: a repository added to an existing task need
          // not sit under the source root that task began from, so there is no
          // directory to resolve a name against.
          repositories: Array.isArray(args.repos) ? args.repos : [],
          baseRef: typeof args.baseRef === "string" && args.baseRef.trim() !== "" ? args.baseRef.trim() : void 0
        });
        const value = envelope(action);
        value.task = result.task;
        value.project = result.project;
        value.branch = result.branch;
        value.container = result.path;
        value.tasksRoot = result.tasksRoot;
        value.repositories = result.repositories.map((entry) => ({ ...emptyRow(entry.name), path: entry.path, branch: result.branch }));
        value.summary = summarize(action, value);
        return value;
      }
      if (action === "list") {
        const tasksRoot = await containerFor(ctx.subprocess, args.tasksRoot, args.sourceRoot, configuredRoot());
        const result = await listTasks(ctx.subprocess, { tasksRoot });
        const value = envelope(action);
        value.tasksRoot = result.tasksRoot;
        for (const task of result.tasks) {
          const label = `${task.project}/${task.name}`;
          if (task.repositories.length === 0) {
            value.repositories.push({ ...emptyRow(label), path: task.path });
            continue;
          }
          for (const repository of task.repositories) {
            value.repositories.push({
              ...emptyRow(`${label}/${repository.name}`),
              path: repository.path,
              branch: repository.branch ?? "",
              changedFiles: repository.changedFiles
            });
          }
        }
        value.summary = summarize(action, value);
        return value;
      }
      if (action === "done") {
        const task = required(args.task, "task");
        refuseIrreversible(args);
        const tasksRoot = await containerFor(ctx.subprocess, args.tasksRoot, args.sourceRoot, configuredRoot());
        const project = projectFor(args.project, args.sourceRoot);
        const result = await finishTask(ctx.subprocess, {
          task,
          project,
          tasksRoot,
          merge: args.merge === true,
          target: typeof args.target === "string" ? args.target : void 0,
          deleteBranch: args.deleteBranch === true,
          force: args.force === true,
          cleanStray: args.cleanStray === true,
          keep: Array.isArray(args.keep) ? args.keep : [],
          deliveryArchive: configuredArchive()
        });
        const value = envelope(action);
        value.task = task;
        value.project = project;
        value.container = result.containerRemoved ? "" : result.path;
        value.tasksRoot = tasksRoot;
        value.failed = result.failed;
        value.warnings = result.warnings;
        if (result.containerRemoved) {
          const stranded = await dropTaskWorkspace(workspaceRegistryOf(ctx), result.path);
          if (stranded !== "") value.warnings.push(stranded);
        }
        value.repositories = result.repositories.map((entry) => ({
          ...emptyRow(entry.name),
          path: entry.path,
          branch: entry.branch ?? "",
          merged: entry.merged === true,
          removed: entry.removed === true,
          branchDeleted: entry.branchDeleted === true,
          mainRepo: entry.mainRepo ?? "",
          mergeInProgress: entry.mergeInProgress === true,
          mergeSite: entry.mergeSite ?? "",
          conflictedFiles: Array.isArray(entry.conflictedFiles) ? entry.conflictedFiles : [],
          error: entry.error ?? ""
        }));
        value.summary = summarize(action, value);
        return value;
      }
      throw coded("E7005", `unknown action: ${action}`);
    },
    // Both presenters are pure: the same arguments and the same result give the
    // same view on the live path and on a session-log replay. Neither reads a
    // session, the clock, the environment or anything else outside its inputs.
    presentCall: (args) => ({
      card: "generic",
      title: `task_worktree_space: ${args.action}`,
      kind: "other",
      // The task name is the one input a reader wants while the call runs; the
      // whole args object (paths, flags, an archive directory) is not.
      rawInput: typeof args?.task === "string" && args.task !== "" ? args.task : void 0
    }),
    presentResult: (args, result) => ({
      card: "generic",
      title: `task_worktree_space: ${args?.action ?? "call"}`,
      content: [{ type: "text", text: cardText(result) }]
    })
  }));
}

// src/host/index.js
var API_PREFIX = "/api/dsh-worktree-space";
var WORKTREE_ENDPOINTS = ["worktree.scan", "worktree.cached", "worktree.status"];
var TASK_ENDPOINTS = ["task.classify-root", "task.classify-roots", "task.suggest-root", "task.create", "task.add-repositories", "task.list", "task.inspect", "task.plan", "task.done", "task.deploy-status", "task.deploy-destroy", "task.deploy-accept", "task.deploy-up", "task.deploy-smoke", "task.preference"];
var ENDPOINTS = [...WORKTREE_ENDPOINTS, ...TASK_ENDPOINTS];
function readClientRequest(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const { type, rpcId, method, payload } = body;
  if (type !== "client-request") return null;
  if (typeof rpcId !== "string" || rpcId === "") return null;
  if (typeof method !== "string" || method === "") return null;
  const carried = payload !== null && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  return { type, rpcId, method, payload: carried };
}
var ok = (value) => ({ ok: true, value });
var PUBLIC_ERROR_CODES = /* @__PURE__ */ new Set([
  "E1001",
  "E1002",
  "E1003",
  "E1004",
  "E1005",
  "E2001",
  "E2002",
  "E2003",
  "E2004",
  "E2005",
  "E2006",
  "E3001",
  "E3002",
  "E3003",
  "E3004",
  "E3005",
  "E4001",
  "E4002",
  "E4003",
  "E4004",
  "E4005",
  "E4006",
  "E4007",
  "E4008",
  "E4009",
  "E4010",
  "E5001",
  "E5002",
  "E5003",
  "E5004",
  "E5005",
  "E5006",
  "E5007",
  "E5008",
  "E5009",
  "E5010",
  "E6001",
  "E6002",
  "E7001",
  "E7002",
  "E7003",
  "E7004",
  "E7005",
  "E7006",
  "E7007",
  "E9001",
  "cancelled"
]);
var fail = (code, message, details = {}) => ({
  ok: false,
  error: { code: publicCode(code), message, details: { issues: [], ...details } }
});
var publicCode = (code) => PUBLIC_ERROR_CODES.has(code) ? code : UNKNOWN;
var cleanPath2 = (value) => {
  const text = String(value ?? "");
  return text.length > 1 ? text.replace(/[\\/]+$/, "") : text;
};
var DEFAULT_IGNORED_SCAN_DIRECTORIES = [
  // JavaScript and the web
  "node_modules",
  "dist",
  "build",
  "coverage",
  "storybook-static",
  // Python
  "__pycache__",
  "site-packages",
  // The JVM, Rust, Scala, Clojure: Cargo and Maven agree on the name
  "target",
  // .NET
  "obj",
  "packages",
  // Apple
  "Library",
  "DerivedData",
  "Pods",
  // PHP, and the dependency trees other ecosystems fetch into the project
  "vendor",
  "deps",
  "elm-stuff",
  // Haskell, Elixir, OCaml, Perl, Zig
  "dist-newstyle",
  "_build",
  "blib",
  "zig-out",
  // Unreal, which capitalises its generated directories
  "Binaries",
  "Intermediate",
  "DerivedDataCache"
];
var DEFAULT_IGNORED_SCAN_DIRECTORY_SET = new Set(DEFAULT_IGNORED_SCAN_DIRECTORIES.map((name2) => name2.toLowerCase()));
function ignoredScanDirectorySet(added, removed) {
  const set = /* @__PURE__ */ new Set();
  for (const name2 of DEFAULT_IGNORED_SCAN_DIRECTORIES) set.add(name2.toLowerCase());
  for (const raw of Array.isArray(removed) ? removed : []) {
    const name2 = String(raw ?? "").trim().toLowerCase();
    if (name2 === "") continue;
    set.delete(name2);
  }
  for (const raw of Array.isArray(added) ? added : []) {
    const name2 = String(raw ?? "").trim();
    if (name2 === "") continue;
    set.add(name2);
    set.add(name2.toLowerCase());
  }
  return set;
}
var MIN_SCAN_DEPTH = 1;
var MAX_SCAN_DEPTH = 5;
var DEFAULT_SCAN_DEPTH = 3;
var MAX_SCAN_DIRECTORIES = 2e3;
var SCAN_CONCURRENCY = 6;
var appliedConfig = {};
function scanBounds() {
  const directories = Number(settingValue(appliedConfig.maxScanDirectories));
  const added = settingValue(appliedConfig.ignoredScanDirectories);
  const removed = settingValue(appliedConfig.removedScanDirectories);
  return {
    depth: resolveScanDepth(settingValue(appliedConfig.scanDepth)),
    directories: Number.isFinite(directories) ? Math.max(1, Math.trunc(directories)) : MAX_SCAN_DIRECTORIES,
    // A value that is not a list is not a list of names to honour, so the built-in
    // ones stand rather than the walk going past nothing.
    ignored: Array.isArray(added) || Array.isArray(removed) ? ignoredScanDirectorySet(Array.isArray(added) ? added : [], Array.isArray(removed) ? removed : []) : DEFAULT_IGNORED_SCAN_DIRECTORY_SET
  };
}
var taskScanBounds = () => {
  const { depth, directories, ignored } = scanBounds();
  return { maxDepth: depth, maxDirectories: directories, ignored };
};
var branchPrefixReference;
var archiveDirectoryReference;
var archiveStrategyReference;
var handoffEntryReference;
var tasksRootStrategyReference;
var tasksRootDirectoryReference;
function configuredBranchPrefix() {
  const value = branchPrefixReference?.get();
  return typeof value === "string" && value.trim() !== "" ? value : DEFAULT_BRANCH_PREFIX;
}
function configuredArchiveDirectory() {
  const value = archiveDirectoryReference?.get();
  return typeof value === "string" ? value.trim() : "";
}
function configuredArchiveStrategy() {
  const value = archiveStrategyReference?.get();
  return value === "custom" ? value : "container";
}
function configuredHandoffEntry() {
  return handoffEntryReference?.get() === "hide" ? "hide" : "show";
}
function configuredTasksRoot() {
  if (tasksRootStrategyReference?.get() !== "custom") return "";
  const value = tasksRootDirectoryReference?.get();
  return typeof value === "string" ? value.trim() : "";
}
var deliveryDefaultsReference;
function configuredDeliveryDefaults() {
  const raw = settingValue(deliveryDefaultsReference);
  if (typeof raw !== "string" || raw.trim() === "") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
function resolveScanDepth(value) {
  if (value === void 0 || value === null || value === "") return DEFAULT_SCAN_DEPTH;
  const depth = Math.trunc(Number(value));
  if (!Number.isFinite(depth)) return DEFAULT_SCAN_DEPTH;
  return Math.min(MAX_SCAN_DEPTH, Math.max(MIN_SCAN_DEPTH, depth));
}
async function discoverGitRoots(rootPath, { signal, maxDepth = DEFAULT_SCAN_DEPTH, maxDirectories = MAX_SCAN_DIRECTORIES, ignored = DEFAULT_IGNORED_SCAN_DIRECTORY_SET, onIssue } = {}) {
  const roots = [];
  const start = cleanPath2(rootPath);
  let unreadable = 0;
  let firstUnreadable = "";
  const noteUnreadable = (path, error) => {
    unreadable += 1;
    if (firstUnreadable !== "") return;
    firstUnreadable = `${path} (${error?.code ?? error?.message ?? "unreadable"})`;
  };
  const queue = [{ path: start, depth: 0 }];
  let inspected = 0;
  for (let cursor = 0; cursor < queue.length; ) {
    signal?.throwIfAborted();
    const batch = queue.slice(cursor, cursor + 8);
    cursor += batch.length;
    inspected += batch.length;
    if (inspected > maxDirectories) {
      onIssue?.(`Stopped after ${maxDirectories} directories; deeper repositories under ${start} are not shown. Raise the scan limits or point the Workspace at a narrower root.`);
      break;
    }
    await Promise.all(batch.map(async ({ path, depth }) => {
      signal?.throwIfAborted();
      let entries;
      try {
        entries = await readdir7(path, { withFileTypes: true });
      } catch (error) {
        noteUnreadable(path, error);
        return;
      }
      const gitEntry = entries.find((entry) => entry.name === ".git");
      if (gitEntry !== void 0) {
        if (gitEntry.isDirectory()) roots.push(path);
        return;
      }
      if (depth >= maxDepth) return;
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || ignored.has(entry.name.toLowerCase())) continue;
        if (entry.name.startsWith(".") && entry.name !== ".worktrees") continue;
        queue.push({ path: join12(path, entry.name), depth: depth + 1 });
      }
    }));
  }
  if (unreadable > 0) {
    onIssue?.(unreadable === 1 ? `Could not read ${firstUnreadable}, so repositories under it are not shown.` : `Could not read ${unreadable} directories under ${start}, the first being ${firstUnreadable}. Repositories under them are not shown.`);
  }
  return roots.sort();
}
async function recover(operation, classify) {
  try {
    return ok(await operation());
  } catch (error) {
    const message = String(error?.message ?? error);
    const own = typeof error?.code === "string" ? error.code : void 0;
    const code = publicCode(own ?? classify?.(message) ?? UNKNOWN);
    await recordError(error, {
      phase: "endpoint",
      code,
      ...typeof error?.msg === "string" && error.msg.trim() !== "" ? { msg: error.msg } : {}
    });
    return fail(code, message);
  }
}
function requestedPaths(payload) {
  if (!Array.isArray(payload?.paths)) return [];
  return payload.paths.filter((path) => typeof path === "string").map((path) => path.trim()).filter(Boolean);
}
function isInsideDirectory(outer, inner) {
  return isInside(outer, inner);
}
function topLevelRequestedPaths(paths) {
  const cleaned = [...new Set(paths.map(cleanPath2).filter(Boolean))];
  const outermostFirst = [...cleaned].sort((left, right) => left.length - right.length);
  const kept = [];
  for (const candidate of outermostFirst) {
    if (kept.some((outer) => isInsideDirectory(outer, candidate))) continue;
    kept.push(candidate);
  }
  return cleaned.filter((path) => kept.includes(path));
}
function branchTargets(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return void 0;
  const targets = {};
  for (const [name2, branch] of Object.entries(value)) {
    const repository = name2.trim();
    const target = typeof branch === "string" ? branch.trim() : "";
    if (repository !== "" && target !== "") targets[repository] = target;
  }
  return Object.keys(targets).length === 0 ? void 0 : targets;
}
var name = "dsh-worktree-space";
var inject = ["connection", "subprocess"];
var Config = z.object({
  panelEntry: z.union(["show", "hide"]).default("hide").loose().volatile().description("Also show the management page as a row in the sidebar panel list, under New session. Hidden by default: the footer shortcut is the one way in."),
  sidebarEntry: z.union(["show", "hide"]).default("show").loose().volatile().description("Show the Worktree Space shortcut in the sidebar footer."),
  /**
   * Whether the two entries that hand work to an agent are offered.
   *
   * Shown by default, because that is the finish the plugin has been shipping: a profile
   * that would rather not see an experimental entry sets this to hide, and the standard
   * finish is then the user's own commit and their own conflict resolution. The dialogs
   * read it from `task.preference` rather than from this form, because that is where the
   * other setting they default from already arrives.
   */
  handoffEntry: z.union(["show", "hide"]).default("show").loose().volatile().description("Offer the two experimental entries that hand uncommitted work, and a merge conflict, to an agent. Hidden, the standard flow applies: commit and resolve the conflict yourself, then finish the task again."),
  /**
   * Whether the audit log is written.
   *
   * On by default, and that is the setting being worth having: the log is the only
   * account of what happened to a task space that survives the terminal, and a
   * setting whose default was "off" would mean nobody had it until something went
   * wrong and they went looking. Switched off, nothing new is written and the file
   * already there is left alone - turning a log off is not a way to delete one,
   * because the records are frequently the only copy.
   *
   * Read through `task.preference` as well, so a dialog that needs to say whether
   * logging is on does not have to reach for the configuration form.
   */
  auditLog: z.union(["on", "off"]).default("on").loose().volatile().description("Write a record of every operation, git call and failure to the container root. Off stops new records and keeps the log already there."),
  /** The Web UI's control is gone: this is the one place the depth is chosen. */
  scanDepth: z.number().min(MIN_SCAN_DEPTH).max(MAX_SCAN_DEPTH).step(1).default(DEFAULT_SCAN_DEPTH).volatile().description("How many directory levels a scan descends from a Workspace root."),
  maxScanDirectories: z.number().min(1).step(1).default(MAX_SCAN_DIRECTORIES).volatile().description("Directories one scan may inspect before it stops looking."),
  /**
   * Directory names a scan walks past, on top of the ones it always skips.
   *
   * This is an addition rather than a replacement: the built-in names stay in
   * force whatever this holds, because the setting is about what a scan should
   * not spend its budget on, and switching `node_modules` back on by accident is
   * a mistake with no upside. A name among the built-in ones that has to stop
   * being skipped is the other direction, and has its own setting - see
   * `removedScanDirectories`.
   *
   * Names are matched without regard to case, because the directory names this
   * is compared against are spelled by whichever filesystem is under the
   * Workspace.
   *
   * The ceiling here is a long way above the one the dialog enforces, and on
   * purpose. That number is about a list of tags a person is looking at; this one
   * is about refusing a file so malformed that the plugin should refuse to start.
   * A configuration written by hand with a few hundred names in it is honoured,
   * because a name someone wrote down is a name they meant.
   */
  ignoredScanDirectories: z.array(z.string()).max(1e4).default([]).volatile().description("Extra directory names the scan never descends into, beyond the ones it always skips."),
  /**
   * The built-in names the scan descends into again.
   *
   * A subtraction rather than a replacement list, for a reason that only shows up
   * later: if this said "these are the names to skip", then every name a future
   * release adds to the built-in list would be silently dropped for anyone who had
   * ever edited this setting. Recording what was taken off keeps the two halves
   * saying what they mean, and survives the plugin changing underneath.
   *
   * A name here that the Host does not ship is ignored rather than refused: it
   * matches nothing, and a stale entry left by a rename should not stop the
   * configuration loading.
   */
  removedScanDirectories: z.array(z.string()).max(1e4).default([]).volatile().description("Built-in directory names the scan descends into again."),
  /**
   * The branch prefix every new task space starts from.
   *
   * It is the one setting both halves of this plugin write: the configuration card
   * edits it directly, and the create dialog offers to save the prefix it is about to
   * use. Volatile like the rest of this schema, which is what makes the Plugins page
   * render it and every edit land on the running entry instead of waiting for a reload.
   */
  defaultBranchPrefix: z.string().default(DEFAULT_BRANCH_PREFIX).volatile().description("The prefix every new task space starts from: the branch is this plus the task name. The create dialog offers to update it."),
  /**
   * Whether the container root is the plugin's recommendation or the user's.
   *
   * `default` keeps the derived rule - the first directory below the volume root,
   * which is what gives every project of one root workspace the same container and
   * the worktree the common ancestor a session needs to commit. `custom` answers
   * with `tasksRootDirectory` instead, for a user who wants every task space
   * somewhere of their own; a directory that shares no such ancestor with the
   * repositories then has to be authorised by hand in the agent sessions the finish
   * opens, which is what the setting's own note warns about.
   *
   * The create dialog offers to save the location it was about to use, the way it
   * already does for the branch prefix. Volatile like the rest of this schema.
   */
  tasksRootStrategy: z.union(["default", "custom"]).default("default").loose().volatile().description("Where a new task space goes. default derives it from the source root, and custom uses the directory below."),
  /**
   * The container root a task space goes in under the `custom` strategy.
   *
   * Empty means "not set", which leaves the recommendation in place rather than
   * naming nowhere. Unlike the archive directory this one is not merely a
   * destination: it is checked by the same isolation rule an explicitly requested
   * container root is, so a directory inside (or containing) the repositories is
   * refused when a task is created or suggested rather than silently used.
   */
  tasksRootDirectory: z.string().default("").volatile().description("Where new task spaces go under the custom strategy. Empty keeps the derived recommendation instead."),
  /**
   * Which root a task's documents are filed under when it is archived.
   *
   * `container` keeps them in the container root, under
   * `<container root>\archived-docs`: everything this plugin writes then lives
   * under the one directory it names, and no second anchor appears elsewhere on
   * the volume. `custom` uses `archiveDocumentsDirectory`.
   *
   * Volatile like the rest of this schema: the Plugins page serves it and a write
   * lands on the running entry without a reload.
   */
  archiveDocumentsStrategy: z.union(["container", "custom"]).default("container").loose().volatile().description("The root archived documents are filed under. container keeps them in the container root, and custom uses the directory below."),
  /**
   * Where a task's documents are filed when it is archived, under the `custom`
   * strategy.
   *
   * Empty means "not set" and falls back to the container root, which is what the
   * setting files under by default. The `<project>\<task>-<stamp>` folders are
   * added under whatever root is chosen, so two tasks filed into one directory
   * never mix their documents. Volatile for the same reason as the strategy above.
   *
   * The value is not checked here. A directory that cannot hold the copy, or one
   * inside the task container, is refused by the archive itself, where the path it
   * has to stay out of is known.
   */
  archiveDocumentsDirectory: z.string().default("").volatile().description("Where archived documents go under the custom strategy. Empty files them under the container root instead."),
  /**
   * The delivery policies projects default to, as JSON text: one object keyed by
   * project name, each value a policy the schema in `task/delivery.js` validates.
   *
   * A JSON string rather than a structured form field because the Plugins page has
   * no map editor yet; a user who wants a project's tasks to deploy and gate their
   * merges writes the object here once, and every create under that project reads
   * it. Invalid JSON, or a value that is not an object, is answered with an empty
   * map rather than raised: a broken default must not become a plugin that cannot
   * create anything.
   *
   * Volatile like the rest of this schema: a write lands on the running entry and
   * the next create follows it.
   */
  deliveryDefaultsJson: z.string().default("").volatile().description('Per-project default delivery policies as JSON, e.g. {"my-project":{"deploy":{"target":"docker","mode":"auto"}}}. Invalid JSON is ignored.')
});
function settingValue(setting) {
  if (setting !== null && typeof setting === "object" && typeof setting.get === "function") return setting.get();
  return setting;
}
function apply(ctx, config = {}) {
  appliedConfig = config ?? {};
  branchPrefixReference = config.defaultBranchPrefix;
  archiveDirectoryReference = config.archiveDocumentsDirectory;
  archiveStrategyReference = config.archiveDocumentsStrategy;
  handoffEntryReference = config.handoffEntry;
  tasksRootStrategyReference = config.tasksRootStrategy;
  tasksRootDirectoryReference = config.tasksRootDirectory;
  deliveryDefaultsReference = config.deliveryDefaultsJson;
  setAuditEnabledReader(() => settingValue(config.auditLog) !== "off");
  if (typeof ctx.inject === "function") {
    ctx.inject(["tools"], (toolsCtx) => registerTaskTool(toolsCtx, { configuredRoot: configuredTasksRoot, configuredDeliveryDefaults, configuredArchive: () => ({ strategy: configuredArchiveStrategy(), directory: configuredArchiveDirectory() }) }));
  } else {
    registerTaskTool(ctx, { configuredRoot: configuredTasksRoot, configuredDeliveryDefaults, configuredArchive: () => ({ strategy: configuredArchiveStrategy(), directory: configuredArchiveDirectory() }) });
  }
  if (typeof ctx.inject === "function") {
    ctx.inject(["skills"], (skillsCtx) => registerTaskSkill(skillsCtx));
  } else {
    registerTaskSkill(ctx);
  }
  const handle = async (endpoint, payload = {}, signal) => {
    if (signal?.aborted) return fail("cancelled", "The request was cancelled.");
    auditEnter({ op: endpoint });
    const listRepository = async (path) => {
      if (!path) throw coded("E6002", "Select a DSH Workspace.");
      const porcelain = await runGit(ctx.subprocess, path, ["worktree", "list", "--porcelain"], { log: false });
      const worktrees = parseWorktrees(porcelain);
      const repoPath = worktrees.find((worktree) => worktree.isMain)?.path;
      if (repoPath === void 0) throw coded("E3004", `${path} is not a Git repository.`);
      return { repoPath, worktrees };
    };
    if (endpoint === "worktree.scan") return recover(async () => {
      const paths = requestedPaths(payload);
      const bounds = scanBounds();
      const maxDepth = resolveScanDepth(payload.depth ?? bounds.depth);
      let reason = "";
      const spared = (why) => {
        if (reason === "") reason = why;
      };
      const walked = topLevelRequestedPaths(paths);
      if (walked.length === 0) throw coded("E4006", "No usable Workspace path was given to scan.");
      const found = await Promise.all(walked.map((path) => discoverGitRoots(path, { signal, maxDepth, maxDirectories: bounds.directories, ignored: bounds.ignored, onIssue: spared })));
      const roots = [...new Set(found.flat())];
      if (signal?.aborted) throw signal.reason;
      const seen = /* @__PURE__ */ new Set();
      const listed = await mapWithLimit(roots, SCAN_CONCURRENCY, async (root) => {
        signal?.throwIfAborted();
        try {
          return await listRepository(root);
        } catch {
          spared("Some repositories did not answer the scan and are not shown.");
          return void 0;
        }
      });
      const repositories = listed.filter((repository) => {
        if (repository === void 0) return false;
        const key = cleanPath2(repository.repoPath);
        if (key === "" || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const complete = reason === "";
      rememberScan(paths, repositories);
      return { lists: repositories, complete, reason, bounds: { depth: maxDepth, directories: bounds.directories } };
    });
    if (endpoint === "worktree.cached") return recover(async () => {
      const remembered = recallScan(requestedPaths(payload));
      const live = scanBounds();
      return {
        repositories: remembered?.repositories ?? [],
        statuses: remembered?.statuses ?? {},
        current: { depth: live.depth, directories: live.directories }
      };
    });
    if (endpoint === "worktree.status") return recover(async () => {
      const path = typeof payload.path === "string" ? payload.path.trim() : "";
      if (!path) throw coded("E4005", "Worktree path is required.");
      const target = typeof payload.target === "string" ? payload.target.trim() : "";
      const [output, ahead] = await Promise.all([
        runGit(ctx.subprocess, path, ["status", "--short", "--branch"]),
        target === "" ? "" : tryRunGit(ctx.subprocess, path, ["rev-list", "--count", `${target}..HEAD`])
      ]);
      const lines = output ? output.split(/\r?\n/) : [];
      const commits = Number.parseInt(ahead, 10);
      const status = {
        branchLine: lines.find((line) => line.startsWith("## ")) ?? "",
        changedFiles: lines.filter((line) => line && !line.startsWith("## ")).length,
        ...Number.isFinite(commits) ? { commits } : {},
        output
      };
      rememberStatus(path, status);
      return status;
    });
    if (endpoint === "task.classify-root") return recover(async () => {
      const sourceRoot = typeof payload.sourceRoot === "string" ? payload.sourceRoot.trim() : "";
      if (!sourceRoot) throw coded("E4004", "A source root is required.");
      return classifySourceRoot(sourceRoot, { signal });
    });
    if (endpoint === "task.classify-roots") return recover(async () => {
      const paths = requestedPaths(payload);
      if (paths.length === 0) throw coded("E4004", "A source root is required.");
      return classifySourceRoots(paths, { signal, concurrency: SCAN_CONCURRENCY, ...taskScanBounds() });
    });
    if (endpoint === "task.suggest-root") return recover(async () => {
      const sourceRoot = typeof payload.sourceRoot === "string" ? payload.sourceRoot.trim() : "";
      if (!sourceRoot) throw coded("E4004", "A source root is required.");
      return suggestTaskRoot(ctx.subprocess, sourceRoot, {
        tasksRoot: payload.tasksRoot,
        // An unnamed prefix is the configured one, not the built-in: the suggestion
        // is what the create dialog shows, and it must show the same default the
        // request will fall back to.
        branchPrefix: typeof payload.branchPrefix === "string" && payload.branchPrefix !== "" ? payload.branchPrefix : configuredBranchPrefix(),
        // Likewise for the location, so the dialog opens on the container root the
        // configuration names instead of on the one it would otherwise derive.
        configuredRoot: configuredTasksRoot(),
        // Same walk, same depth, same ignored names as the classification and
        // the create: the dialog previews what those two will act on.
        ...taskScanBounds()
      });
    });
    if (endpoint === "task.preference") return recover(async () => {
      return {
        defaultBranchPrefix: configuredBranchPrefix(),
        archiveDocumentsStrategy: configuredArchiveStrategy(),
        archiveDocumentsDirectory: configuredArchiveDirectory(),
        handoffEntry: configuredHandoffEntry(),
        // So a dialog can tell someone that what just happened was not recorded
        // rather than leave them to find an empty log and assume the plugin is
        // broken. The answer is the running state, not the configured value, so
        // it cannot disagree with what is actually being written.
        auditLog: auditEnabled() ? "on" : "off"
      };
    });
    if (endpoint === "task.create") return recover(async () => {
      const sourceRoot = typeof payload.sourceRoot === "string" ? payload.sourceRoot.trim() : "";
      const task = typeof payload.task === "string" ? payload.task.trim() : "";
      if (!sourceRoot) throw coded("E4004", "A source root is required.");
      if (!task) throw coded("E4003", "A task name is required.");
      const repos = Array.isArray(payload.repos) ? payload.repos.filter((name2) => typeof name2 === "string" && name2.trim() !== "").map((name2) => name2.trim()) : void 0;
      return createTask(ctx.subprocess, {
        sourceRoot,
        task,
        tasksRoot: payload.tasksRoot,
        repos,
        baseRef: typeof payload.baseRef === "string" ? payload.baseRef.trim() : void 0,
        // A caller that names no prefix gets the configured one; an empty string
        // means the same thing, which is what an emptied dialog field sends.
        branchPrefix: typeof payload.branchPrefix === "string" && payload.branchPrefix !== "" ? payload.branchPrefix : configuredBranchPrefix(),
        // A request that names no container root takes the configured one, which is
        // the same answer `task.suggest-root` just gave the dialog.
        configuredRoot: configuredTasksRoot(),
        // The delivery policy: an explicit one in the request wins, then the
        // project's stored default, then the built-in one. Resolved inside the
        // create, so an invalid policy refuses it before anything is made.
        delivery: payload.delivery,
        deliveryDefaults: configuredDeliveryDefaults(),
        // And the same walk that dialog previewed and the Workspace card counted,
        // with the same bounds: `scanDepth` decides what "the repositories under
        // this root" means, and one meaning has to hold across all three.
        scanBounds: taskScanBounds()
      });
    });
    if (endpoint === "task.add-repositories") return recover(async () => {
      const task = typeof payload.task === "string" ? payload.task.trim() : "";
      if (!task) throw coded("E4003", "A task name is required.");
      const repositories = Array.isArray(payload.repositories) ? payload.repositories.filter((path) => typeof path === "string" && path.trim() !== "").map((path) => path.trim()) : [];
      return addTaskRepositories(ctx.subprocess, {
        task,
        project: typeof payload.project === "string" ? payload.project : "",
        tasksRoot: typeof payload.tasksRoot === "string" ? payload.tasksRoot.trim() : "",
        repositories,
        baseRef: typeof payload.baseRef === "string" && payload.baseRef.trim() !== "" ? payload.baseRef.trim() : void 0
      });
    });
    if (endpoint === "task.list") return recover(async () => {
      const tasksRoot = typeof payload.tasksRoot === "string" ? payload.tasksRoot.trim() : "";
      return listTasks(ctx.subprocess, { tasksRoot });
    });
    if (endpoint === "task.inspect") return recover(async () => {
      const path = typeof payload.path === "string" ? payload.path.trim() : "";
      if (!path) throw coded("E4005", "A task path is required.");
      return inspectTask(path);
    });
    if (endpoint === "task.plan") return recover(async () => {
      const task = typeof payload.task === "string" ? payload.task.trim() : "";
      if (!task) throw coded("E4003", "A task name is required.");
      return planTask(ctx.subprocess, {
        task,
        project: typeof payload.project === "string" ? payload.project : "",
        tasksRoot: typeof payload.tasksRoot === "string" ? payload.tasksRoot.trim() : "",
        targets: branchTargets(payload.targets)
      });
    });
    if (endpoint === "task.done") return recover(async () => {
      const task = typeof payload.task === "string" ? payload.task.trim() : "";
      if (!task) throw coded("E4003", "A task name is required.");
      return finishTask(ctx.subprocess, {
        task,
        project: typeof payload.project === "string" ? payload.project : "",
        tasksRoot: typeof payload.tasksRoot === "string" ? payload.tasksRoot.trim() : "",
        merge: payload.merge === true,
        target: typeof payload.target === "string" ? payload.target : void 0,
        targets: branchTargets(payload.targets),
        deleteBranch: payload.deleteBranch === true,
        force: payload.force === true,
        cleanStray: payload.cleanStray === true,
        keep: Array.isArray(payload.keep) ? payload.keep.filter((name2) => typeof name2 === "string") : [],
        documentsDirectory: typeof payload.documentsDirectory === "string" ? payload.documentsDirectory : void 0,
        discardDocuments: payload.discardDocuments === true,
        // The user's own overrule of the delivery gate, from the panel's
        // "finish anyway?" confirmation. The tool never sends it: the model's way
        // past the gate is deploying, smoking and being accepted, never a flag.
        acknowledgeDelivery: payload.acknowledgeDelivery === true,
        // The strays policy may file content away; the archive preference is
        // the configuration's standing answer for where.
        deliveryArchive: { strategy: configuredArchiveStrategy(), directory: configuredArchiveDirectory() },
        // Why the dialog is finishing a task it never told the user existed. The
        // rollback after a create whose Workspace would not register goes through
        // this endpoint like any other, so without this the log would show the
        // worktrees and the branch being deleted and never say that the reason
        // was a create that had already half succeeded.
        cause: typeof payload.cause === "string" && payload.cause.trim() !== "" ? payload.cause.trim() : void 0
      });
    });
    if (endpoint === "task.deploy-status") return recover(async () => {
      const path = typeof payload.path === "string" ? payload.path.trim() : "";
      if (!path) throw coded("E4005", "A task path is required.");
      return deploymentStatus(ctx.subprocess, path);
    });
    if (endpoint === "task.deploy-destroy") return recover(async () => {
      const path = typeof payload.path === "string" ? payload.path.trim() : "";
      if (!path) throw coded("E4005", "A task path is required.");
      return destroyDeployment(ctx.subprocess, path);
    });
    if (endpoint === "task.deploy-accept") return recover(async () => {
      const path = typeof payload.path === "string" ? payload.path.trim() : "";
      if (!path) throw coded("E4005", "A task path is required.");
      return ackAcceptance(path);
    });
    if (endpoint === "task.deploy-up") return recover(async () => {
      const path = typeof payload.path === "string" ? payload.path.trim() : "";
      if (!path) throw coded("E4005", "A task path is required.");
      return deployEnvironment(ctx.subprocess, path);
    });
    if (endpoint === "task.deploy-smoke") return recover(async () => {
      const path = typeof payload.path === "string" ? payload.path.trim() : "";
      if (!path) throw coded("E4005", "A task path is required.");
      return smokeEnvironment(ctx.subprocess, path);
    });
    return fail(UNKNOWN, `Unknown endpoint: ${endpoint}`);
  };
  for (const endpoint of ENDPOINTS) {
    ctx.effect(() => ctx.connection.fetch.register({
      path: `${API_PREFIX}/${endpoint}`,
      methods: ["POST"],
      requestBody: "buffered",
      async fetch(request) {
        if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
          return new Response("content type must be application/json", { status: 415 });
        }
        let body;
        try {
          body = await request.json();
        } catch {
          return new Response("body is not JSON", { status: 400 });
        }
        const message = readClientRequest(body);
        if (message === null) return new Response("invalid client-request message", { status: 400 });
        const result = message.method === `dsh-worktree-space/${endpoint}` ? await handle(endpoint, message.payload, request.signal) : fail(UNKNOWN, "RPC method does not match endpoint.");
        return Response.json({ type: "server-response", rpcId: message.rpcId, result });
      }
    }), `dsh-worktree-space ${endpoint} route`);
  }
}
export {
  Config,
  DEFAULT_IGNORED_SCAN_DIRECTORY_SET,
  DEFAULT_SCAN_DEPTH,
  MAX_SCAN_DEPTH,
  MAX_SCAN_DIRECTORIES,
  MIN_SCAN_DEPTH,
  PUBLIC_ERROR_CODES,
  SCAN_CONCURRENCY,
  apply,
  branchTargets,
  cleanPath2 as cleanPath,
  configuredArchiveDirectory,
  configuredArchiveStrategy,
  configuredBranchPrefix,
  configuredDeliveryDefaults,
  configuredHandoffEntry,
  configuredTasksRoot,
  detectDefaultBranch,
  discoverGitRoots,
  fail,
  ignoredScanDirectorySet,
  inject,
  name,
  ok,
  parseWorktrees,
  readClientRequest,
  recover,
  requestedPaths,
  resolveScanDepth,
  runGit,
  topLevelRequestedPaths
};
