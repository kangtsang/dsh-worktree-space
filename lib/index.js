// src/host/index.js
import z from "@deepseek-ai/schemastery";
import { readdir as readdir11 } from "node:fs/promises";
import { join as join18 } from "node:path";

// src/host/task/audit-log.js
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import { open, readFile, rename, stat } from "node:fs/promises";
import { basename, dirname as dirname2, extname, join as join2 } from "node:path";

// src/host/task/paths.js
import { dirname, join, parse, resolve } from "node:path";
import { lstatSync, realpathSync } from "node:fs";
var CASE_INSENSITIVE = process.platform === "win32";
function foldDotSegments(path) {
  const absolute = path.startsWith("/");
  const segments = [];
  let escaped = false;
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (!escaped && segments.length > 0 && segments[segments.length - 1] !== "..") {
        segments.pop();
        continue;
      }
      escaped = true;
      segments.push(segment);
      continue;
    }
    segments.push(segment);
  }
  const body = segments.join("/");
  if (absolute) return `/${body}`;
  return body;
}
function canonicalPath(value) {
  const unified = String(value ?? "").replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  if (unified === "") return "/";
  return CASE_INSENSITIVE ? unified.toLowerCase() : unified;
}
function reducedPath(value) {
  const unified = String(value ?? "").replace(/[\\/]+/g, "/");
  const folded = foldDotSegments(unified);
  if (folded === "" || folded === "/") return "/";
  return CASE_INSENSITIVE ? folded.toLowerCase() : folded;
}
function samePathLocation(left, right) {
  return canonicalPath(left) === canonicalPath(right);
}
function canonicalPathSet(values) {
  const unique = /* @__PURE__ */ new Set();
  for (const value of values ?? []) {
    const key = reducedPath(value);
    if (key !== "" && key !== "/") unique.add(key);
  }
  return [...unique].sort().join("\n");
}
function absolutePath(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text === "" ? "" : resolve(text);
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
function realLocation(value) {
  const text = String(value ?? "");
  if (text === "") return void 0;
  const rest = [];
  let current = resolve(text);
  for (; ; ) {
    try {
      const real = realpathSync(current);
      return rest.length === 0 ? real : join(real, ...rest.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return void 0;
      rest.push(current.slice(parent.length).replace(/^[\\/]+/, ""));
      current = parent;
    }
  }
}
function isInsideReal(root, target) {
  const outer = reducedPath(root);
  const inner = reducedPath(target);
  if (outer === "/" || inner === "/") return false;
  return inner !== outer && inner.startsWith(`${outer}/`);
}
function assertInsideContainer(tasksRoot, target, what = "this path") {
  const root = reducedPath(tasksRoot);
  const inner = reducedPath(target);
  const inside = inner.startsWith(root.endsWith("/") ? root : `${root}/`);
  if (!inside) {
    throw new FenceError("E1005", `${what} is outside the container root and will not be deleted: ${target}
  the container root is ${tasksRoot}`);
  }
  const realRoot = realLocation(tasksRoot);
  const realTarget = realLocation(target);
  if (realRoot === void 0 || realTarget === void 0) {
    throw new FenceError("E1005", `${what} could not be resolved to a real location, so whether it is inside the container root cannot be shown, and it will not be deleted: ${target}
  the container root is ${tasksRoot}`);
  }
  if (!isInsideReal(realRoot, realTarget)) {
    throw new FenceError("E1005", `${what} resolves to ${realTarget}, which is outside the container root and will not be deleted: ${target}
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
    assertRealDirectory(target, what);
    assertInsideContainer(tasksRoot, target, what);
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
  const preferred = join(parent, CONTAINER_NAME);
  const swallows = isInside(preferred, sourceRoot) || samePathLocation(preferred, sourceRoot);
  return swallows ? join(parent, CONTAINER_BACKUP_NAME) : preferred;
}
function firstDirectoryBelowRoot(absolute, root) {
  const parts = absolute.slice(root.length).split(/[\\/]+/).filter(Boolean);
  return parts.length > 1 ? join(root, parts[0]) : void 0;
}
function containerParentFor(absolute, root = parse(absolute).root) {
  const driveRoot = /^[A-Za-z]:[\\/]$/.test(root) ? root : void 0;
  const first = driveRoot === void 0 ? void 0 : firstDirectoryBelowRoot(absolute, root);
  if (first !== void 0) return first;
  return driveRoot === void 0 ? dirname(absolute) : driveRoot;
}
function recommendTasksRoot(sourceRoot) {
  const absolute = resolve(sourceRoot);
  return containerIn(containerParentFor(absolute), absolute);
}

// src/host/task/task-lock.js
var chains = /* @__PURE__ */ new Map();
function withTaskLock(key, body) {
  const entry = canonicalPath(key);
  const previous = chains.get(entry) ?? Promise.resolve();
  let release;
  const mine = new Promise((resolve8) => {
    release = resolve8;
  });
  chains.set(entry, mine);
  return previous.then(() => body()).finally(() => {
    release();
    if (chains.get(entry) === mine) chains.delete(entry);
  });
}

// src/host/task/audit-log.js
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
var ASSIGNED_SECRET = /((?:token|password|passwd|pwd|secret|authorization|auth|credential|api[-_]?key|access[-_]?key)\s*[:=\s]\s*)("[^"]*"|'[^']*'|[^\r\n,;]+)/gi;
var TOKEN_SHAPES = /(?<![A-Za-z0-9_-])(?:(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|glpat-|sk-|xox[baprs]-)[A-Za-z0-9_-]{6,}|AKIA[0-9A-Z]{16})/g;
var AUTH_SCHEME = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/g;
var PEM_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
function redact(value) {
  return String(value ?? "").replace(URL_CREDENTIALS, "//***@").replace(PEM_BLOCK, "-----BEGIN PRIVATE KEY-----***").replace(AUTH_SCHEME, "$1 ***").replace(TOKEN_SHAPES, "***").replace(ASSIGNED_SECRET, "$1***");
}
function redactedFields(value) {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactedFields);
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactedFields(entry)]));
  }
  return value;
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
      ...redactedFields(fields)
    })}
`;
    const path = join2(tasksRoot, AUDIT_FILE);
    await withTaskLock(path, async () => {
      const size = await stat(path).then((info) => info.size, () => 0);
      if (size >= MAX_BYTES) {
        try {
          await rotate(path);
        } catch {
        }
      }
      const handle = await open(path, "a");
      try {
        await handle.write(line);
      } finally {
        await handle.close();
      }
    });
  } catch {
  }
}
async function rotate(path) {
  const stem = `${join2(dirname2(path), basename(path, extname(path)))}.${archiveStamp()}`;
  const extension = extname(path);
  let target = `${stem}${extension}`;
  for (let counter = 1; existsSync(target); counter++) {
    target = `${stem}-${counter}${extension}`;
  }
  await rename(path, target);
}
function archiveStamp(date = /* @__PURE__ */ new Date()) {
  const millis = String(date.getMilliseconds()).padStart(3, "0");
  return `${localStamp(date).replace(/[: ]/g, "-")}-${millis}`;
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
  const warning = message !== null && typeof message === "object" && typeof message.message === "string" ? message : void 0;
  const text = warning === void 0 ? message : warning.message;
  await auditRecord("warning", "warn", {
    ...fields,
    ...warning === void 0 ? {} : { code: warning.code, values: warning.values },
    message: truncate(redact(String(text ?? "")), MESSAGE_LIMIT)
  });
}

// src/host/task/codes.js
var ERROR_CODES = {
  // --- E1xxx container and isolation --------------------------------------
  E1001: "paths.js, inspect.js - the tasks root is the repositories directory itself, or is a repository itself",
  E1002: "paths.js, add.js - the container, or the task space, is inside a repository",
  E1003: "paths.js, add.js - the container, or the task space, holds a repository",
  E1004: "paths.js, container.js, archive.js, inspect.js, add.js - the tasks root is missing or empty",
  E1005: 'two conditions, both "this path is not one this plugin will touch". (1) paths.js - a delete is refused by the fence: the path is outside the container root, is not a <container root>/<project>/<task> shape, or is a link rather than a directory. (2) container.js - the container root is itself a git repository, refused before a task space is made under it',
  E1006: "archive.js - a task worktree resolves to a source repository the task never recorded",
  // --- E2xxx task space lifecycle -----------------------------------------
  E2001: "create.js - the task name is taken by a different task space",
  E2002: "create.js - the task space is this task own, left before its Workspace was registered",
  E2003: "archive.js, add.js, tool.js - no task space at that path",
  E2004: "archive.js, add.js - the task space holds no git worktrees",
  E2005: "create.js, add.js - creating or extending failed with no code of its own, and everything was rolled back",
  E2006: "create.js, add.js - creating or extending failed with no code of its own, and the rollback left something behind",
  E2007: "archive.js - the task space at that path belongs to a different task or project than the one asked for",
  // --- E3xxx git and branches ---------------------------------------------
  // The two codes below are not thrown where a literal could be grepped: they are
  // chosen at runtime from git's own stderr, by `gitFailureCode` in git.js and by
  // its deliberate duplicate `gitRecordCode` in audit-log.js (duplicated because
  // git.js imports audit-log.js, so sharing one would be a cycle; a test asserts
  // the two agree). `grep -n E3003` finds the classifier rather than a throw, which
  // is the honest description of where these come from.
  E3001: "create.js, add.js - the branch to cut the worktree from is already in use",
  E3002: "create.js, add.js - the requested base ref does not exist in that repository",
  E3003: "git.js - derived from git stderr: a git command failed for any reason not covered below",
  E3004: "git.js - derived from git stderr: the directory is not a git repository",
  E3005: "git.js - derived from git stderr: the worktree checkout has gone",
  // --- E4xxx arguments and validation -------------------------------------
  E4001: "create.js, add.js - no repository was selected",
  E4002: "create.js, add.js - two repositories in one task share a name",
  E4003: "index.js - the task name is missing",
  E4004: "index.js - the source root is missing",
  E4005: "index.js, add.js - a path is required, either a worktree, a task space or a repository",
  E4006: 'two conditions, both "the request named nothing this could act on". (1) index.js - no usable Workspace path was given to scan. (2) discover.js - a requested repository is not inside the source root. NOTE: hitting the directory ceiling is NOT this code any more - a walk that runs out of budget reports through onIssue and keeps the repositories it did find',
  E4007: "archive.js - deleting an unmerged branch was not forced",
  E4008: "archive.js - the merge target is unusable",
  E4009: "naming.js - the task name or branch prefix is not usable",
  E4010: "delivery.js - a delivery policy value is not one of the allowed ones",
  E4011: "index.js - a handoff access request named no session",
  E4012: "index.js - a session was to be given full access while the setting that grants it is off",
  E4014: "create.js - the requested deploy script is not a file inside the source root",
  E4015: "create.js - the task is set to deploy but nothing in the source root or its repositories can deploy it",
  // --- E5xxx finishing and merging ----------------------------------------
  E5001: "archive.js - a merge is still standing, so nothing was finished",
  E5002: "archive.js - finishing did not complete for every repository",
  E5003: "archive.js - one repository could not be finished and needs another attempt",
  E5004: "archive.js - the source checkout has uncommitted work the merge would overwrite",
  E5006: "deploy.js - the last deployment smoke did not pass, so the merge is refused",
  E5008: "deploy.js - the deploy script is missing, or it failed while rebuilding the environment",
  E5011: "archive.js - a worktree is held by something outside this process, so removing it would fail",
  E5012: "tool.js - a session is still working in the task space, so the finish is refused",
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
function warned(code, message, values) {
  return { code, message, values: values ?? {} };
}
function coded(code, message, details) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  error.details = details ?? {};
  error.withMsg = (sentence) => {
    error.msg = sentence;
    return error;
  };
  return error;
}

// src/host/task/deploy.js
import { existsSync as existsSync3, statSync as statSync2 } from "node:fs";
import { readFile as readFile4, readdir as readdir3, writeFile as writeFile3 } from "node:fs/promises";
import { dirname as dirname5, join as join7, resolve as resolve4 } from "node:path";

// src/host/task/bash-interpreter.js
import { statSync } from "node:fs";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname as dirname3, join as join3 } from "node:path";
var WINDOWS_STUB_NAMES = [
  "system32/bash.exe",
  "syswow64/bash.exe",
  "windowsapps/bash.exe",
  "program files/wsl/bash.exe"
];
var GIT_BASH_PATHS = [
  "C:/Program Files/Git/bin/bash.exe",
  "C:/Program Files/Git/usr/bin/bash.exe",
  "C:/Program Files (x86)/Git/bin/bash.exe",
  "C:/Program Files (x86)/Git/usr/bin/bash.exe"
];
function harnessBashCandidates() {
  const root = join3(homedir(), ".dsh", "dsh-ops", "shells", "bash");
  let versions;
  try {
    versions = readdirSync(root);
  } catch {
    return [];
  }
  return versions.sort((a, b) => b.localeCompare(a, "en", { numeric: true })).map((version) => join3(root, version, "usr", "bin", "bash.exe"));
}
function isWindowsBashStub(candidate) {
  const normalised = String(candidate ?? "").replace(/\\/g, "/").toLowerCase();
  return WINDOWS_STUB_NAMES.some((name2) => normalised.endsWith(`/${name2}`));
}
function isExecutableFile(candidate) {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}
function bashInterpreter() {
  if (process.platform !== "win32") {
    return { command: "bash", toolDir: void 0 };
  }
  for (const candidate of [...harnessBashCandidates(), ...GIT_BASH_PATHS]) {
    if (isWindowsBashStub(candidate)) continue;
    if (isExecutableFile(candidate)) return { command: candidate, toolDir: dirname3(candidate) };
  }
  return void 0;
}
function pathForShell(toolDir, existing) {
  if (typeof toolDir !== "string" || toolDir === "") return existing;
  const current = typeof existing === "string" ? existing : "";
  const separator = current.includes(";") ? ";" : ":";
  return current === "" ? toolDir : `${toolDir}${separator}${current}`;
}

// src/host/task/delivery.js
import { posix, win32 } from "node:path";
var DEPLOY_TARGETS = ["docker", "none"];
var DEFAULT_DELIVERY_POLICY = Object.freeze({
  version: 1,
  deploy: Object.freeze({ target: "none" })
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
function buildPolicy(input, { strict }) {
  const source = isPlainObject(input) ? input : {};
  const sourceDeploy = isPlainObject(source.deploy) ? source.deploy : {};
  const target = oneOf(DEPLOY_TARGETS, sourceDeploy.target, "deploy.target", { strict }) ?? DEFAULT_DELIVERY_POLICY.deploy.target;
  return {
    version: 1,
    deploy: { target }
  };
}
function normalizeDeliveryPolicy(input) {
  return buildPolicy(input, { strict: true });
}
function coerceDeliveryPolicy(input) {
  return buildPolicy(input, { strict: false });
}
function resolveDeliveryPolicy(explicit) {
  return explicit === void 0 || explicit === null ? coerceDeliveryPolicy(void 0) : normalizeDeliveryPolicy(explicit);
}
function deliveryPolicyOf(recorded) {
  return coerceDeliveryPolicy(isPlainObject(recorded) ? recorded.delivery : void 0);
}
function applyStraysPolicy(request, archive, taskPath) {
  const choice = request.strays === "keep" || request.strays === "discard" ? request.strays : "archive";
  const keep = Array.isArray(request.keepEntries) ? request.keepEntries : [];
  const named = typeof request.documentsDirectory === "string" ? request.documentsDirectory.trim() : "";
  if (choice === "keep") {
    return { cleanStray: false, discardDocuments: false, documentsDirectory: "", keep };
  }
  if (choice === "discard") {
    return { cleanStray: true, discardDocuments: true, documentsDirectory: "", keep };
  }
  if (named !== "" && isAbsoluteDirectory(named)) {
    return { cleanStray: true, discardDocuments: false, documentsDirectory: named, keep };
  }
  const configured = archive && archive.strategy === "custom" ? String(archive.directory ?? "").trim() : "";
  const custom = configured !== "" && isAbsoluteDirectory(configured) ? configured : "";
  const strategy = custom !== "" ? custom : containerRootOf(taskPath);
  const now = /* @__PURE__ */ new Date();
  const pad = (value) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const parts = String(taskPath).split(/[\\/]+/).filter((part) => part !== "");
  const task = parts[parts.length - 1] ?? "task";
  const project = parts[parts.length - 2] ?? "project";
  const flavour = flavourOf(custom !== "" ? custom : taskPath);
  return {
    cleanStray: true,
    discardDocuments: false,
    documentsDirectory: flavour.join(strategy, "archived-docs", project, `${task}-${stamp}`),
    keep
  };
}
function flavourOf(value) {
  return String(value ?? "").includes("\\") ? win32 : posix;
}
function isAbsoluteDirectory(value) {
  const text = String(value ?? "").trim();
  return text !== "" && (win32.isAbsolute(text) || posix.isAbsolute(text));
}
function containerRootOf(taskPath) {
  const flavour = flavourOf(taskPath);
  const up = flavour.dirname(flavour.dirname(String(taskPath ?? "")));
  return up === "" ? "." : up;
}

// src/host/task/shared.js
import { mkdir as mkdir2, readdir as readdir2, readFile as readFile3, stat as stat3, writeFile as writeFile2 } from "node:fs/promises";
import { dirname as dirname4, isAbsolute, join as join6, resolve as resolve3 } from "node:path";

// src/host/task/git.js
import { tmpdir } from "node:os";
import { join as join4 } from "node:path";
var GIT_HOOKS_PATH = join4(tmpdir(), "dsh-worktree-space-no-hooks");
var GIT_CONFIG_HARDENING = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  `core.hooksPath=${GIT_HOOKS_PATH}`,
  "-c",
  "protocol.file.allow=never",
  "-c",
  "protocol.ext.allow=never"
];
var GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_COUNT: "0",
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_PAGER: "cat",
  GIT_EDITOR: "true",
  LC_ALL: "C"
};
function gitArgv(cwd, args) {
  return ["git", ...GIT_CONFIG_HARDENING, "-C", cwd, ...args];
}
function parseGitArgv(argv) {
  const rest = Array.isArray(argv) ? [...argv] : [];
  if (rest[0] === "git") rest.shift();
  let cwd = "";
  const args = [];
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value === "-c") {
      index += 1;
      continue;
    }
    if (value === "-C") {
      cwd = rest[index + 1] ?? "";
      index += 1;
      continue;
    }
    args.push(value);
  }
  return { cwd, args };
}
function diagnosticOf(text) {
  const lines = String(text ?? "").split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
  const marker = /^(fatal|error|warning):/i;
  const report = /^[A-Z][A-Z0-9 _-]{3,}(\s*\(.*\))?:/;
  const from = lines.findIndex((line) => marker.test(line) || report.test(line));
  return (from === -1 ? lines : lines.slice(from)).join("\n");
}
function gitFailureCode(stderr) {
  const text = String(stderr ?? "");
  if (/not a git repository/i.test(text)) return "E3004";
  if (/is not a working tree|No such file or directory/i.test(text)) return "E3005";
  return "E3003";
}
var GIT_TIMEOUT_MS = 3e4;
async function runGit(subprocess, cwd, args, { log = true, timeoutMs = GIT_TIMEOUT_MS, signal } = {}) {
  const deadlineMs = typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : void 0;
  const controller = deadlineMs === void 0 && signal === void 0 ? void 0 : new AbortController();
  let expired = false;
  const forward = () => controller.abort();
  if (controller !== void 0 && signal !== void 0) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", forward, { once: true });
  }
  const timer = controller === void 0 || deadlineMs === void 0 ? void 0 : setTimeout(() => {
    expired = true;
    controller.abort();
  }, deadlineMs);
  const startedAt = Date.now();
  let outcome;
  let stdout = "";
  let stderr = "";
  try {
    const handle = subprocess.spawn({
      // The hardening settings go before `-C`, because `-c` is applied in the order it is
      // written and `-C` changes the repository the rest of the command line is read
      // against. See {@link GIT_CONFIG_HARDENING} for what each one is for, and for why
      // this is defence in depth rather than a boundary.
      argv: gitArgv(cwd, args),
      cwd,
      stdio: {
        stdin: "ignore",
        stdout: { maxBytes: 2 * 1024 * 1024 },
        stderr: { maxBytes: 512 * 1024 }
      },
      graceMs: 1e3,
      // Merged onto the seam's own scrubbed base rather than replacing it: `env` adds
      // these and cannot remove what the harness already decided to keep. See
      // {@link GIT_ENV}.
      env: GIT_ENV,
      ...controller === void 0 ? {} : { signal: controller.signal }
    });
    outcome = await handle.done;
    stdout = handle.collected.stdout?.readFrom(0).text ?? "";
    stderr = handle.collected.stderr?.readFrom(0).text ?? "";
  } finally {
    if (timer !== void 0) clearTimeout(timer);
    if (controller !== void 0 && signal !== void 0) signal.removeEventListener("abort", forward);
  }
  const elapsed = Date.now() - startedAt;
  if (log || outcome.exitCode !== 0 || (outcome.signal ?? null) !== null) {
    await recordGitCall({
      cwd,
      args,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      stdout,
      stderr,
      ms: elapsed
    });
  }
  if (expired) {
    const error = new Error(`E3003: git ${args.join(" ")} exceeded its deadline of ${deadlineMs}ms and was stopped`);
    error.code = "E3003";
    throw error;
  }
  if (outcome.exitCode !== 0 || outcome.signal !== null) {
    const code = gitFailureCode(stderr);
    const detail = diagnosticOf(stderr.trim() === "" ? stdout : stderr);
    const error = new Error(`${code}: git ${args.join(" ")} failed${outcome.signal ? ` (${outcome.signal})` : ` (exit ${outcome.exitCode})`}${detail === "" ? "" : `: ${detail}`}`);
    error.code = code;
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
import { basename as basename2, resolve as resolve2 } from "node:path";
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
var WINDOWS_RESERVED_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;
function taskNameProblem(name2) {
  if (name2 === "") return "a task name is required";
  if (name2 === "." || name2 === "..") return `task name must not be '.' or '..': ${name2}`;
  if (name2.endsWith(".")) return `task name must not end with a dot: ${name2}`;
  if (name2.endsWith(" ")) return `task name must not end with a space: ${name2}`;
  if (FORBIDDEN.test(name2)) return `task name must not contain /, \\ or whitespace: ${name2}`;
  if (ILLEGAL_BRANCH_CHARACTERS.test(name2)) {
    return `task name must not contain a character git refuses in a branch name (space, ~ ^ : ? * [ ] \\ or a control character): ${name2}`;
  }
  if (name2.includes("..")) return `task name must not contain '..': ${name2}`;
  if (name2.includes("@{")) return `task name must not contain '@{': ${name2}`;
  if (name2.endsWith(".lock")) return `task name must not end with '.lock': ${name2}`;
  if (WINDOWS_RESERVED_NAME.test(name2)) return `task name must not be a Windows reserved device name: ${name2}`;
  return "";
}
var TASK_OWNED_ENTRY_NAMES = [".worktree-space", "README.en.md", "worktree-space.md"];
function validateRepositoryDirectoryName(name2) {
  const value = String(name2 ?? "");
  if (value === "") throw new TaskNameError("a repository directory name is required");
  if (TASK_OWNED_ENTRY_NAMES.includes(value)) {
    throw new TaskNameError(`a repository directory cannot be named '${value}': that name belongs to this plugin inside a task space`);
  }
  if (value === "." || value === "..") {
    throw new TaskNameError(`a repository directory name must not be '.' or '..': ${value}`);
  }
  if (FORBIDDEN_IN_PROJECT.test(value)) {
    throw new TaskNameError(`a repository directory name must not contain / or \\: ${value}`);
  }
  return value;
}
function validateTaskName(task) {
  const name2 = String(task ?? "");
  const problem = taskNameProblem(name2);
  if (problem !== "") throw new TaskNameError(problem);
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
  return validateProjectName(basename2(resolve2(String(sourceRoot ?? ""))));
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
function isUsableTaskName(task) {
  const name2 = String(task ?? "");
  if (name2 === "" || name2 === "." || name2 === "..") return false;
  return !FORBIDDEN.test(name2);
}
function isUsableBranchName(branch) {
  const value = String(branch ?? "");
  if (value === "" || value === "@") return false;
  if (ILLEGAL_BRANCH_CHARACTERS.test(value)) return false;
  if (value.includes("..") || value.includes("@{") || value.includes("//")) return false;
  if (value.startsWith("/") || value.startsWith("-") || value.endsWith("/") || value.endsWith(".")) return false;
  if (value.endsWith(".lock")) return false;
  return true;
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

// src/host/task/source-index.js
import { existsSync as existsSync2 } from "node:fs";
import { mkdir, readFile as readFile2, readdir, rm, stat as stat2, writeFile } from "node:fs/promises";
import { join as join5 } from "node:path";
var PLUGIN_ROOT = ".worktree-space";
var SOURCE_TASKS_DIR = "tasks";
function sourceTaskIndexPath(sourceRoot, project, task) {
  return join5(sourceRoot, PLUGIN_ROOT, SOURCE_TASKS_DIR, project, `${task}.json`);
}
function indexOf(taskPath, metadata, sessions, previous) {
  const created = stampToLocal(previous?.createdAt) ?? stampToLocal(metadata?.createdAt) ?? localStamp();
  return {
    version: 1,
    task: metadata?.task,
    project: metadata?.project,
    taskPath,
    tasksRoot: metadata?.tasksRoot,
    sourceRoot: metadata?.sourceRoot,
    branch: metadata?.branch,
    // The repositories, trimmed to what a reader needs to find them again - the same
    // three facts a record keeps for the same reason.
    repositories: (Array.isArray(metadata?.repositories) ? metadata.repositories : []).map((entry) => ({
      name: entry?.name,
      sourcePath: entry?.sourcePath,
      ...entry?.branch === void 0 ? {} : { branch: entry.branch }
    })),
    sessions: sessions.map((entry) => ({
      sessionId: entry.sessionId,
      at: entry.at,
      role: entry.role,
      // Carried through, like every other field here, and for a sharper reason than the
      // rest: this file is what a finish archives, so a `reportedAt` dropped here is the
      // one that matters most - the archived copy is all a reader has once the task space
      // is gone, and its absence reads as "this session never reported".
      ...entry.reportedAt === void 0 ? {} : { reportedAt: entry.reportedAt }
    })),
    createdAt: created,
    updatedAt: localStamp()
  };
}
function stampToLocal(value) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return value;
  if (typeof value !== "string" || value.trim() === "") return void 0;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? void 0 : localStamp(date);
}
async function writeSourceTaskIndex(taskPath, metadata, sessions = []) {
  const sourceRoot = typeof metadata?.sourceRoot === "string" ? metadata.sourceRoot.trim() : "";
  const project = typeof metadata?.project === "string" ? metadata.project.trim() : "";
  const task = typeof metadata?.task === "string" ? metadata.task.trim() : "";
  if (sourceRoot === "" || project === "" || task === "") return false;
  const file = sourceTaskIndexPath(sourceRoot, project, task);
  const previous = await readSourceTaskIndex(file);
  await mkdir(join5(sourceRoot, PLUGIN_ROOT, SOURCE_TASKS_DIR, project), { recursive: true });
  await ensureIgnoreFile(sourceRoot);
  await writeFile(file, `${JSON.stringify(indexOf(taskPath, metadata, sessions, previous), null, 2)}
`, "utf8");
  return true;
}
async function ensureIgnoreFile(sourceRoot) {
  const file = join5(sourceRoot, PLUGIN_ROOT, ".gitignore");
  if (existsSync2(file)) return;
  if (!existsSync2(join5(sourceRoot, ".git"))) return;
  await writeFile(file, `${SOURCE_TASKS_DIR}/
${SOURCE_TASKS_ARCHIVE_DIR}/
`, "utf8");
}
async function readSourceTaskIndex(file) {
  const text = await readFile2(file, "utf8").catch(() => "");
  if (text.trim() === "") return void 0;
  try {
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : void 0;
  } catch {
    return void 0;
  }
}
var SOURCE_TASKS_ARCHIVE_DIR = "tasks-archive";
var SOURCE_TASKS_KEEP = 10;
function fileStamp(date = /* @__PURE__ */ new Date()) {
  return localStamp(date).replace(/[: ]/g, "-");
}
async function archiveSourceTaskIndex(taskPath, metadata, keep = SOURCE_TASKS_KEEP) {
  const sourceRoot = typeof metadata?.sourceRoot === "string" ? metadata.sourceRoot.trim() : "";
  const project = typeof metadata?.project === "string" ? metadata.project.trim() : "";
  const task = typeof metadata?.task === "string" ? metadata.task.trim() : "";
  if (sourceRoot === "" || project === "" || task === "") return false;
  const live = sourceTaskIndexPath(sourceRoot, project, task);
  const record = await readSourceTaskIndex(live);
  if (record === void 0) return false;
  const directory = join5(sourceRoot, PLUGIN_ROOT, SOURCE_TASKS_ARCHIVE_DIR, project);
  await mkdir(directory, { recursive: true });
  const finishedAt = localStamp();
  let file = join5(directory, `${fileStamp()}-${task}.json`);
  for (let counter = 1; existsSync2(file); counter += 1) {
    file = join5(directory, `${fileStamp()}-${task}-${counter}.json`);
  }
  await writeFile(file, `${JSON.stringify({ ...record, finishedAt }, null, 2)}
`, "utf8");
  await rm(live, { force: true });
  await pruneSourceTaskArchive(sourceRoot, project, keep);
  return true;
}
async function pruneSourceTaskArchive(sourceRoot, project, keep = SOURCE_TASKS_KEEP) {
  const root = typeof sourceRoot === "string" ? sourceRoot.trim() : "";
  const layer = typeof project === "string" ? project.trim() : "";
  if (root === "" || layer === "" || !Number.isInteger(keep) || keep < 1) return [];
  const directory = join5(root, PLUGIN_ROOT, SOURCE_TASKS_ARCHIVE_DIR, layer);
  const names = (await readdir(directory).catch(() => [])).filter((name2) => name2.endsWith(".json"));
  const dated = [];
  for (const name2 of names) {
    const info = await stat2(join5(directory, name2)).catch(() => void 0);
    dated.push({ name: name2, at: info === void 0 ? 0 : info.mtimeMs });
  }
  dated.sort((left, right) => right.at - left.at || right.name.localeCompare(left.name));
  const doomed = dated.slice(Math.max(0, keep)).map((entry) => entry.name);
  for (const name2 of doomed) await rm(join5(directory, name2), { force: true });
  return doomed;
}
async function readArchivedTaskSession(sourceRoot, project, task, sessionId) {
  const root = typeof sourceRoot === "string" ? sourceRoot.trim() : "";
  const layer = typeof project === "string" ? project.trim() : "";
  const name2 = typeof task === "string" ? task.trim() : "";
  const id = typeof sessionId === "string" ? sessionId.trim() : "";
  if (root === "" || layer === "" || name2 === "" || id === "") return void 0;
  const directory = join5(root, PLUGIN_ROOT, SOURCE_TASKS_ARCHIVE_DIR, layer);
  const files = (await readdir(directory).catch(() => [])).filter((file) => file.endsWith(".json"));
  files.sort((left, right) => right.localeCompare(left));
  for (const file of files) {
    const record = await readSourceTaskIndex(join5(directory, file));
    if (record === void 0 || record.task !== name2) continue;
    const sessions = Array.isArray(record.sessions) ? record.sessions : [];
    const entry = sessions.find((one) => one !== null && typeof one === "object" && one.sessionId === id);
    if (entry !== void 0) return entry;
  }
  return void 0;
}

// src/host/task/shared.js
var PLUGIN_ROOT2 = ".worktree-space";
var DEPLOY_ROOT = "deploy";
var BREADCRUMB = "README.en.md";
var TASK_METADATA = "worktree-space.json";
var TASK_README = "worktree-space.md";
var TASK_OWNED_ENTRIES = [PLUGIN_ROOT2, BREADCRUMB];
async function isLinkedWorktree(directory) {
  try {
    return (await stat3(join6(directory, ".git"))).isFile();
  } catch {
    return false;
  }
}
function resolveTasksRoot(sourceRoot, requestedRoot, configuredRoot) {
  const requested = typeof requestedRoot === "string" ? requestedRoot.trim() : "";
  if (requested !== "") return resolve3(requested);
  const configured = typeof configuredRoot === "string" ? configuredRoot.trim() : "";
  return configured === "" ? recommendTasksRoot(sourceRoot) : resolve3(configured);
}
function taskSpacePath(tasksRoot, project, task) {
  const root = String(tasksRoot ?? "").trim();
  if (!isAbsolute(root) || dirname4(root) === root) {
    throw coded(
      "E1004",
      `a tasks root is required, and it must be an absolute directory that is not a volume root: ${root === "" ? "(empty)" : root}`
    );
  }
  const path = join6(root, validateProjectName(project), validateTaskName(task));
  assertTaskSpaceShape(root, path);
  return path;
}
function pluginRootPath(taskPath) {
  return join6(taskPath, PLUGIN_ROOT2);
}
function taskMetadataPath(taskPath) {
  return join6(pluginRootPath(taskPath), TASK_METADATA);
}
function taskDeployRootPath(taskPath) {
  return join6(pluginRootPath(taskPath), DEPLOY_ROOT);
}
var DEPLOY_DIR = `${PLUGIN_ROOT2}/${DEPLOY_ROOT}`;
var DEFAULT_DEPLOY_ENTRY = `${DEPLOY_DIR}/deploy.sh`;
function sourceDeployRootPath(sourceRoot) {
  return join6(sourceRoot, PLUGIN_ROOT2, DEPLOY_ROOT);
}
async function listTaskWorktrees(subprocess, taskPath) {
  let entries;
  try {
    entries = await readdir2(taskPath, { withFileTypes: true });
  } catch {
    return [];
  }
  const repositories = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const worktreePath = join6(taskPath, entry.name);
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
  const { task, project, tasksRoot, sourceRoot, branch, baseRef, repositories = [], delivery, sessions, deployScript } = details;
  const known = normalizeSessions(sessions);
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
    // Optional, and absent rather than empty on a record that has no session yet:
    // every reader treats a missing key as "unknown", which is what a record made
    // before this field existed says, and an empty array would claim the task has
    // no session where the truth is that nobody wrote one down.
    ...known.length === 0 ? {} : { sessions: known },
    // Which script under `.worktree-space/deploy/` is this task's entry, when the create
    // named one. Absent means `.worktree-space/deploy/deploy.sh`, which is what every record
    // made before this field existed means too - so a reader falls back rather than refusing.
    ...typeof deployScript === "string" && deployScript.trim() !== "" ? { deployScript: deployScript.trim() } : {},
    repositories: repositories.map((entry) => ({
      name: entry.name,
      sourcePath: entry.sourcePath,
      ...entry.sourceBranch === void 0 ? {} : { sourceBranch: entry.sourceBranch },
      ...entry.startCommit === void 0 ? {} : { startCommit: entry.startCommit },
      branch: entry.branch ?? branch
    }))
  };
}
var TASK_SESSION_ROLES = ["task", "handoff", "leader"];
function normalizeSessions(value) {
  const entries = Array.isArray(value) ? value : value === void 0 || value === null ? [] : [value];
  const normalized = [];
  for (const raw of entries) {
    const entry = typeof raw === "string" ? { sessionId: raw } : raw;
    if (entry === null || typeof entry !== "object") continue;
    const sessionId = typeof entry.sessionId === "string" ? entry.sessionId.trim() : "";
    if (sessionId === "") continue;
    const role = TASK_SESSION_ROLES.includes(entry.role) ? entry.role : "task";
    const at = typeof entry.at === "string" && entry.at !== "" ? entry.at : void 0;
    const reportedAt = typeof entry.reportedAt === "string" && entry.reportedAt !== "" ? entry.reportedAt : void 0;
    normalized.push({
      sessionId,
      ...at === void 0 ? {} : { at },
      ...reportedAt === void 0 ? {} : { reportedAt },
      role
    });
  }
  return normalized;
}
function taskSessionsOf(metadata) {
  if (metadata === null || metadata === void 0 || typeof metadata !== "object") return [];
  if (Array.isArray(metadata.sessions)) return normalizeSessions(metadata.sessions);
  return normalizeSessions(metadata.sessionId);
}
async function recordTaskSession(taskPath, metadata, sessionId, role = "task") {
  const id = typeof sessionId === "string" ? sessionId.trim() : "";
  if (id === "" || metadata === null || metadata === void 0 || typeof metadata !== "object") return false;
  const known = taskSessionsOf(metadata);
  if (known.some((entry) => entry.sessionId === id)) return true;
  const written = {
    ...metadata,
    sessions: [...known, { sessionId: id, at: (/* @__PURE__ */ new Date()).toISOString(), role: TASK_SESSION_ROLES.includes(role) ? role : "task" }]
  };
  try {
    await writeTaskMetadata(taskPath, written);
  } catch {
    return false;
  }
  await writeSourceTaskIndex(taskPath, written, taskSessionsOf(written)).catch(() => false);
  return true;
}
async function markSessionReported(taskPath, sessionId) {
  const id = typeof sessionId === "string" ? sessionId.trim() : "";
  if (id === "") return false;
  const metadata = await readTaskMetadata(taskPath).catch(() => void 0);
  if (metadata === null || metadata === void 0 || typeof metadata !== "object") return false;
  const known = taskSessionsOf(metadata);
  const target = known.findIndex((entry) => entry.sessionId === id);
  if (target === -1) return false;
  const stamp = localStamp();
  const written = {
    ...metadata,
    sessions: known.map((entry, index) => index === target ? { ...entry, reportedAt: stamp } : entry)
  };
  try {
    await writeTaskMetadata(taskPath, written);
  } catch {
    return false;
  }
  await writeSourceTaskIndex(taskPath, written, taskSessionsOf(written)).catch(() => false);
  return true;
}
async function readTaskMetadata(taskPath) {
  const text = await readFile3(taskMetadataPath(taskPath), "utf8").catch(() => "");
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
  const text = await readFile3(join6(taskPath, BREADCRUMB), "utf8").catch(() => "");
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
  const { task, project, branch, baseRef, createdAt, sourceRoot, repositories = [], deploymentEnvId, delivery, deployScript } = metadata;
  const deployEntry = typeof deployScript === "string" && deployScript.trim() !== "" ? deployScript.trim() : DEFAULT_DEPLOY_ENTRY;
  const sessions = [...taskSessionsOf(metadata)].reverse();
  const lines = [
    `# Task: ${task}`,
    "",
    ...typeof project === "string" && project !== "" ? [`- Project: \`${project}\``] : [],
    `- Branch: \`${branch}\` (one branch per repository below)`,
    `- Base: ${baseRef === void 0 || baseRef === null || `${baseRef}`.trim() === "" ? "each repository's current HEAD" : `\`${baseRef}\``}`,
    ...typeof createdAt === "string" && createdAt !== "" ? [`- Created: ${createdAt}`] : [],
    `- Source root: \`${sourceRoot}\``,
    ...sessions.length === 0 ? [] : [`- Sessions: ${sessions.map((entry) => `\`${entry.sessionId}\` (${entry.role})`).join(", ")}`],
    "- This folder is the agent session working directory.",
    `- The facts above are stored in \`${PLUGIN_ROOT2}/${TASK_METADATA}\`; this file is generated from it.`,
    "",
    ...sessions.length === 0 ? [] : [
      "## Sessions",
      "- The sessions above were opened for this task; the newest is the one that was working most recently.",
      '- Watch one with `wts_session_tool status` (its `lastActivity` tells "stuck" from "busy with a long step"), read it with `wts_session_tool read`, and correct it with `wts_session_tool send` \u2014 pass `mode: "steer"` for anything time-sensitive, because `queue` is only read at a turn boundary.',
      ""
    ],
    "## Repositories",
    ...repositories.map((entry) => `- \`${entry.name}\``),
    "",
    "## Conventions",
    "- Commit in each repository separately (the same branch name everywhere).",
    "- Source repositories are read-only for editing: do the work in this task space, not in the source checkouts.",
    // Who finishes is the user's choice, so this states the two shapes and what each one
    // costs rather than naming one. A note that picked a side would be the plugin deciding an
    // authorisation question it has no standing on, and a session that read the wrong side of
    // it would either strand a finished task or merge without the user having asked.
    "- **Who finishes is the user's decision, and both flows work.** Either you call `done` yourself once the work is complete, or you report back and the session that dispatched you - or the user - calls it. Ask which is wanted when the task brief does not say.",
    // The reporting contract, in the note the session reads from disk. The dispatched session
    // is handed the same requirement in its brief, and the two have to agree: a note that
    // stayed quiet about it would leave the one artifact a later reader trusts saying less
    // than the prompt that started the work.
    '- **Report back as you go, and report when you stop.** The session that dispatched you is invisible to you in reverse: it sees nothing - not your commands, not your commits - until you send it something with `wts_session_tool send` (`mode: "steer"` for anything time-sensitive). Report when each unit that can be committed and handed over on its own has landed, when you are stuck on something only the caller or the user can settle, and when the task is finished - including when you finished it yourself with `done`, which never replaces the report. A final report states the commit hash of each repository, the acceptance URL when there is one, what passed and the evidence for it, and **what you did not verify**. Between those moments, use your own judgement: report what changes what comes next, and skip the reports that would only say nothing happened.',
    "- Finishing is atomic: `done` merges, removes the worktrees and clears the task space in one call. `merge: true` lands the task branch on the target; `merge: false` leaves the branch alone - the commits are kept, but the worktree is removed, so a conflict left over would have to be resolved in the source repository instead of here.",
    "- A merge that lands is the one step a finish cannot take back, so `merge: true` is an authorisation rather than a formality: pass it when the user asked for the work to land, and not otherwise.",
    "",
    ...typeof deploymentEnvId === "string" && deploymentEnvId !== "" ? [
      "## Deployment",
      `- If this space holds deployable services \u2014 a repository with its own \`deploy/deploy.sh\`, or the \`${PLUGIN_ROOT2}/${DEPLOY_ROOT}/\` orchestration root this space was created with \u2014 deploy them to an isolated Docker environment rather than starting them on the host.`,
      `- Environment id for this task: \`DEPLOY_ENV_ID=${deploymentEnvId}\`. Pass it to every deploy command: it is what keeps this task's containers, images and acceptance URL apart from every other task's. A command run without it builds containers under the entry's own default id, and the panel then cannot see them: the smoke and destroy buttons disappear, and a finish cannot take the environment down.`,
      // The entry this task actually runs, as the command this task space runs it with.
      // A create that named one says so in the record, and the note has to repeat it:
      // the agent's commands are `./<entry> up`, and a `./deploy.sh up` would run a
      // different script when the two disagree.
      //
      // The id rides along as the entry's second argument, which is not decoration: the
      // line above tells the session to pass it, and a command printed here without it
      // contradicts that instruction with a string the session can copy verbatim. A copy
      // is what sessions actually run, and the entry takes the id from either the
      // environment or this argument - so the printed form has to carry it. An entry that
      // was written before the second argument existed reads it as a service name and
      // falls back to its own default, which is the shape this whole line is preventing.
      `- This task's deploy entry is \`./${deployEntry}\`. Run \`./${deployEntry} up ${deploymentEnvId}\` to build and start the environment; it prints the acceptance URL. Run \`./${deployEntry} smoke ${deploymentEnvId}\` and let it pass before handing the URL to the user.`,
      `- \`./${deployEntry} status --json\` is the machine-readable view. The panel's destroy button finds this task's containers by their \`dsh.env-id\` label and takes them down without the script, so a \`destroy\` subcommand is optional - and if the entry has one, it must set \`url\` to null and stamp \`destroyedAt\`, or the panel will show a dead acceptance URL as if it worked.`,
      `- **The deploy root owns its own delivery state, at a path the plugin names.** The file is \`<task space>/${PLUGIN_ROOT2}/${DEPLOY_ROOT}/.state.json\` \u2014 fixed, whatever the entry is called and wherever under \`${DEPLOY_ROOT}/\` it sits. Every script this plugin runs is handed that absolute path as \`DEPLOY_STATE_FILE\`, so write \`\${DEPLOY_STATE_FILE}\` and never work out the deploy root yourself. \`./${deployEntry} up ${deploymentEnvId}\` must write \`url\` (one line, plus \`services\` if it likes) once the environment is up, and \`./${deployEntry} smoke ${deploymentEnvId}\` must merge \`lastSmoke: {result, at}\` into that same file **without dropping what is already in it**. Neither \`up\` nor \`smoke\` may write \`destroyedAt\` - that stamp is the plugin's to clear, and only the entry's own optional \`destroy\` writes it. Without the file the panel can show neither the acceptance URL nor the smoke state, and \`done\` refuses to merge (E5006).`,
      "- Write that state from the script that ran the step and from nothing else: not by hand, not from a transcript of a run that happened elsewhere. The merge gate reads the file as the evidence that the step happened.",
      `- A space this plugin scaffolded (no \`${DEPLOY_ROOT}/\` of its own was copied in) carries \`${PLUGIN_ROOT2}/${DEPLOY_ROOT}/write-state.sh\`, run from that directory: \`./write-state.sh url <url>\`, \`./write-state.sh smoke pass|fail\` and \`./write-state.sh services <json>\` each merge one field into \`$DEPLOY_STATE_FILE\`.`,
      `- **A slow step is not a hung step.** The plugin waits at most 10 minutes for \`up\` and 5 minutes for \`smoke\`, and stops the script at that point. If either genuinely needs longer, add a third subcommand to the entry printing one JSON line \u2014 \`echo '{"upSeconds":1200,"smokeSeconds":900}'\` \u2014 and the plugin runs it before each step and uses those budgets instead. Both keys are in seconds and may be left out, in which case that step keeps its default; anything the plugin cannot parse also keeps the default, so this is optional and never a thing to get right for the step to run. Values outside 1\u20133600 seconds are ignored for the same reason.`,
      ""
    ] : [],
    ...delivery === void 0 ? [] : [
      "## Delivery",
      `- Deployment target: \`${delivery.deploy.target}\`.`,
      "- `done` enforces this: with a target of `docker`, a merge is refused while the deployment state records no passing smoke (E5006 - either no state file at all, or one whose smoke is missing or red). With `none` there is no gate.",
      "- Everything else a finish decides \u2014 whether to merge, which branch, whether to delete it, and what happens to untracked files \u2014 is passed on the `done` call, not recorded here. `merge` is required; `strays` defaults to `archive`.",
      ""
    ]
  ];
  return lines.join("\n");
}
async function writeTaskMetadata(taskPath, metadata) {
  await mkdir2(pluginRootPath(taskPath), { recursive: true });
  await writeFile2(taskMetadataPath(taskPath), `${JSON.stringify(metadata, null, 2)}
`, "utf8");
  await writeFile2(join6(pluginRootPath(taskPath), TASK_README), renderTaskMetadata(metadata), "utf8");
}

// src/host/task/deploy.js
var STATE_NAME = ".state.json";
var DOCKER_MAX_BYTES = 512 * 1024;
var DOCKER_TIMEOUT_MS = 15e3;
var DEPLOY_UP_TIMEOUT_MS = 10 * 60 * 1e3;
var DEPLOY_SMOKE_TIMEOUT_MS = 5 * 60 * 1e3;
var DEPLOY_TIMEOUT_MAX_SECONDS = 3600;
var DEPLOY_TIMEOUT_MIN_SECONDS = 1;
var DEPLOY_TIMEOUTS_QUERY_MS = 1e4;
async function runProcess(subprocess, argv, { cwd, maxBytes = DOCKER_MAX_BYTES, timeoutMs, env, signal } = {}) {
  const deadlineMs = typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : void 0;
  const controller = deadlineMs === void 0 && signal === void 0 ? void 0 : new AbortController();
  let expired = false;
  const forward = () => controller.abort();
  if (controller !== void 0 && signal !== void 0) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", forward, { once: true });
  }
  const timer = controller === void 0 || deadlineMs === void 0 ? void 0 : setTimeout(() => {
    expired = true;
    controller.abort();
  }, deadlineMs);
  try {
    const handle = subprocess.spawn({
      argv,
      cwd,
      stdio: { stdin: "ignore", stdout: { maxBytes }, stderr: { maxBytes } },
      graceMs: 1e3,
      ...env === void 0 ? {} : { env },
      ...controller === void 0 ? {} : { signal: controller.signal }
    });
    const outcome = await handle.done;
    const timedOut = expired;
    return {
      ok: !timedOut && outcome.exitCode === 0,
      exitCode: outcome.exitCode,
      timedOut,
      stdout: handle.collected.stdout?.readFrom(0).text ?? "",
      stderr: handle.collected.stderr?.readFrom(0).text ?? ""
    };
  } finally {
    if (timer !== void 0) clearTimeout(timer);
    if (controller !== void 0 && signal !== void 0) signal.removeEventListener("abort", forward);
  }
}
async function deployTimeouts(subprocess, found, taskPath, envId, { signal } = {}) {
  const defaults = { upMs: DEPLOY_UP_TIMEOUT_MS, smokeMs: DEPLOY_SMOKE_TIMEOUT_MS };
  let command;
  try {
    command = deployEntryCommand(found.script, "timeouts", envId);
  } catch {
    return defaults;
  }
  let out;
  try {
    out = await runProcess(subprocess, command.argv, {
      cwd: found.dir,
      // Short on purpose: this is a lookup, and a script that treats an unknown
      // subcommand by starting a build would otherwise hold up the build it is being
      // asked about. One tenth of the `up` budget it can raise is enough for a
      // subcommand that is meant to print two numbers and nothing else.
      timeoutMs: DEPLOY_TIMEOUTS_QUERY_MS,
      env: { ...deployEnvironmentFor(taskPath, envId), ...command.env },
      ...signal === void 0 ? {} : { signal }
    });
  } catch {
    return defaults;
  }
  if (!out.ok) return defaults;
  const budget = (value, fallback) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
    const seconds = Math.trunc(value);
    return seconds >= DEPLOY_TIMEOUT_MIN_SECONDS && seconds <= DEPLOY_TIMEOUT_MAX_SECONDS ? seconds * 1e3 : fallback;
  };
  let parsed;
  try {
    parsed = JSON.parse(out.stdout);
  } catch {
    return defaults;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return defaults;
  return {
    upMs: budget(parsed.upSeconds, defaults.upMs),
    smokeMs: budget(parsed.smokeSeconds, defaults.smokeMs)
  };
}
async function runDocker(subprocess, args, { signal } = {}) {
  return runProcess(subprocess, ["docker", ...args], {
    cwd: process.cwd(),
    timeoutMs: DOCKER_TIMEOUT_MS,
    ...signal === void 0 ? {} : { signal }
  });
}
function deployEntryCommand(script, subcommand, envId) {
  const bash = bashInterpreter();
  if (bash === void 0) {
    throw coded(
      "E5008",
      `no usable bash was found to run this task space's deploy entry with, so it was not started.
  Deploy entries are shell scripts, and on Windows the \`bash.exe\` in System32 (and the one in WindowsApps) is a forwarding stub for WSL rather than a shell: it starts a Linux distribution, which cannot read a Windows path such as \`${script}\`, and reports the entry as missing.
  Install Git for Windows, or restart DSH after installing it; the shell is searched for on every call.`,
      { path: script, reason: "no-bash" }
    );
  }
  return {
    argv: [bash.command, script, subcommand, ...envId === "" ? [] : [envId]],
    env: { PATH: pathForShell(bash.toolDir, process.env.PATH) }
  };
}
async function tryDocker(subprocess, args, { signal } = {}) {
  try {
    return await runDocker(subprocess, args, { signal });
  } catch {
    return { ok: false, exitCode: null, timedOut: false, stdout: "", stderr: "" };
  }
}
async function askDocker(subprocess, args, { signal } = {}) {
  try {
    const out = await runDocker(subprocess, args, { signal });
    if (out.timedOut) return { answered: false, reason: "timed-out", out };
    return { answered: true, reason: "", out };
  } catch (error) {
    return { answered: false, reason: String(error?.message ?? error) || "not-runnable", out: void 0 };
  }
}
async function requireRecorded(taskPath) {
  const recorded = await readTaskMetadata(taskPath);
  if (recorded === void 0) throw coded("E2003", `no such task space: ${taskPath}`, { path: taskPath });
  return recorded;
}
async function deliveryStateFiles(taskPath) {
  const files = [];
  const entries = await readdir3(taskPath, { withFileTypes: true }).catch(() => []);
  const candidates = [join7(taskDeployRootPath(taskPath), STATE_NAME)];
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name !== PLUGIN_ROOT2) candidates.push(join7(taskPath, entry.name, DEPLOY_ROOT, STATE_NAME));
  }
  for (const path of candidates) {
    if (existsSync3(path)) files.push(path);
  }
  return files;
}
function stateFilePath(taskPath) {
  return join7(taskDeployRootPath(taskPath), STATE_NAME);
}
function deployEnvironmentFor(taskPath, envId) {
  return {
    ...envId === "" ? {} : { DEPLOY_ENV_ID: envId },
    DEPLOY_STATE_FILE: stateFilePath(taskPath)
  };
}
async function readDeliveryState(taskPath) {
  for (const path of await deliveryStateFiles(taskPath)) {
    try {
      const parsed = JSON.parse(await readFile4(path, "utf8"));
      if (parsed !== null && typeof parsed === "object") return { path, state: parsed };
    } catch {
    }
  }
  return void 0;
}
async function containersFor(subprocess, envId, { signal } = {}) {
  const out = await tryDocker(subprocess, [
    "ps",
    "-a",
    "--filter",
    `label=dsh.env-id=${envId}`,
    "--format",
    "{{.Names}}	{{.State}}"
  ], { signal });
  if (!out.ok || out.stdout.trim() === "") return [];
  return out.stdout.trim().split(/\r?\n/).map((line) => {
    const [name2, state] = line.split("	");
    return { name: name2 ?? "", state: state ?? "unknown" };
  }).filter((row) => row.name !== "");
}
async function askedContainerIds(subprocess, envId, { signal } = {}) {
  const answer = await askDocker(subprocess, ["ps", "-a", "-q", "--filter", `label=dsh.env-id=${envId}`], { signal });
  if (!answer.answered) return { answered: false, ids: [], reason: answer.reason };
  if (!answer.out.ok) {
    return { answered: false, ids: [], reason: answer.out.stderr.trim() !== "" ? answer.out.stderr.trim() : `docker ps exited ${answer.out.exitCode}` };
  }
  return { answered: true, ids: answer.out.stdout.trim().split(/\r?\n/).filter((one) => one !== ""), reason: "" };
}
function acceptanceUrl(value) {
  if (typeof value !== "string" || value === "") return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:" ? value : null;
}
async function deploymentStatus(subprocess, taskPath, { signal } = {}) {
  const recorded = await requireRecorded(taskPath);
  const envId = typeof recorded.deploymentEnvId === "string" ? recorded.deploymentEnvId : "";
  const policy = deliveryPolicyOf(recorded);
  const found = await readDeliveryState(taskPath);
  const stateUrl = acceptanceUrl(found?.state?.url);
  return {
    envId,
    target: policy.deploy.target,
    url: stateUrl,
    urlSource: stateUrl !== null ? "state" : "none",
    lastSmoke: found?.state?.lastSmoke ?? null,
    destroyedAt: found?.state?.destroyedAt ?? null,
    stateFound: found !== void 0,
    statePath: found?.path ?? null,
    containers: envId === "" ? [] : await containersFor(subprocess, envId, { signal })
  };
}
async function deliveryStateSummary(taskPath) {
  const found = await readDeliveryState(taskPath);
  const smoke = found?.state?.lastSmoke;
  return {
    url: acceptanceUrl(found?.state?.url),
    lastSmoke: smoke === null || smoke === void 0 || typeof smoke !== "object" ? null : {
      result: typeof smoke.result === "string" ? smoke.result : "unknown",
      ...typeof smoke.at === "string" && smoke.at !== "" ? { at: smoke.at } : {}
    },
    statePath: found?.path ?? null
  };
}
async function assertDeliveryGate(recorded, taskPath, { merge = false, bypass = false } = {}) {
  if (merge !== true) return void 0;
  const policy = deliveryPolicyOf(recorded);
  if (policy.deploy.target === "none") return void 0;
  const envId = typeof recorded?.deploymentEnvId === "string" ? recorded.deploymentEnvId : "";
  const found = await readDeliveryState(taskPath);
  const smoke = found?.state?.lastSmoke;
  const passing = smoke !== null && typeof smoke === "object" && smoke.result === "pass";
  const deployedAt = typeof found?.state?.deployedAt === "string" ? found.state.deployedAt : "";
  const smokeAt = smokeTime(smoke);
  const stale = deployedAt !== "" && smokeAt !== void 0 && smokeAt < Date.parse(deployedAt);
  if (passing && !stale) return void 0;
  const missing = found === void 0 ? ["deployment", "smoke"] : ["smoke"];
  if (bypass) {
    return warned("delivery-gate-bypassed", "the user acknowledged finishing without a passing smoke", { missing });
  }
  const because = found === void 0 ? "`<deploy root>/.state.json` is absent" : stale ? `the recorded smoke (${smoke.at}) is older than the last deployment this side ran (${deployedAt}), so it says nothing about the environment standing now` : 'it carries no `lastSmoke` with `result: "pass"`';
  throw coded(
    "E5006",
    `the deployment records no passing smoke, so the merge is refused: ${because}${envId === "" ? "" : ` (environment ${envId})`}. Deploy the task space and run its smoke, having that script merge \`lastSmoke: { result, at }\` into the state file, then merge.`,
    { target: policy.deploy.target, envId, missing }
  );
}
function smokeTime(smoke) {
  const at = smoke !== null && typeof smoke === "object" ? smoke.at : void 0;
  if (typeof at !== "string" || at.trim() === "") return void 0;
  const parsed = Date.parse(at);
  return Number.isFinite(parsed) ? parsed : void 0;
}
async function deliveryGatePreview(recorded, taskPath) {
  const policy = deliveryPolicyOf(recorded);
  if (policy.deploy.target === "none") return { applies: false, missing: [], target: "none" };
  const found = await readDeliveryState(taskPath);
  if (found === void 0) return { applies: true, missing: ["deployment", "smoke"], target: policy.deploy.target };
  const missing = [];
  const smoke = found.state?.lastSmoke;
  const deployedAt = typeof found.state.deployedAt === "string" ? found.state.deployedAt : "";
  const smokeAt = smokeTime(smoke);
  const stale = deployedAt !== "" && smokeAt !== void 0 && smokeAt < Date.parse(deployedAt);
  if (smoke === null || typeof smoke !== "object" || smoke.result !== "pass" || stale) missing.push("smoke");
  return { applies: true, missing, target: policy.deploy.target };
}
async function destroyDeployment(subprocess, taskPath, envId, { signal } = {}) {
  let id = typeof envId === "string" ? envId.trim() : "";
  let recordedForTarget;
  if (id === "") {
    recordedForTarget = await readTaskMetadata(taskPath).catch(() => void 0);
    if (recordedForTarget !== void 0 && typeof recordedForTarget.deploymentEnvId === "string") id = recordedForTarget.deploymentEnvId;
  }
  if (id === "") {
    return { removed: false, containers: 0, warning: warned("no-deployment-recorded", "no deployment environment is recorded for this task space, so there is nothing named to remove") };
  }
  const found = await askedContainerIds(subprocess, id, { signal });
  if (!found.answered) {
    return {
      removed: false,
      containers: 0,
      unknown: true,
      warning: warned(
        "deploy-containers-unchecked",
        `the environment's containers could not be looked up, so it is unknown whether any are still standing: docker could not be asked (${found.reason})`,
        { envId: id, reason: found.reason }
      )
    };
  }
  const ids = found.ids;
  if (ids.length === 0) {
    return { removed: false, containers: 0 };
  }
  const inspect = await tryDocker(subprocess, [
    "inspect",
    ...ids,
    "--format",
    '{{index .Config.Labels "com.docker.compose.project.config_files"}}	{{index .Config.Labels "com.docker.compose.project.working_dir"}}'
  ], { signal });
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
      ], { signal });
      if (down.ok) {
        composed = true;
        break;
      }
    }
  }
  const warnings = [];
  let removed = composed;
  const left = await askedContainerIds(subprocess, id, { signal });
  if (!left.answered) {
    warnings.push(warned(
      "deploy-containers-unchecked",
      `whether the environment's containers are gone could not be checked: docker could not be asked (${left.reason})`,
      { envId: id, reason: left.reason, after: "teardown" }
    ));
  } else if (left.ids.length > 0) {
    const removedForce = await tryDocker(subprocess, ["rm", "-f", ...left.ids], { signal });
    if (removedForce.ok) {
      removed = true;
    } else {
      warnings.push(warned("deploy-containers-left", `could not remove ${left.ids.length} container${left.ids.length === 1 ? "" : "s"} of environment ${id}: ${removedForce.stderr.trim() !== "" ? removedForce.stderr.trim() : "docker failed"}`, { count: left.ids.length, envId: id, reason: removedForce.stderr.trim() }));
    }
  }
  await preserveStates(taskPath);
  return { removed, containers: ids.length, ...warnings.length > 0 ? { warning: warnings[0] } : {} };
}
async function preserveStates(taskPath) {
  const destroyedAt = (/* @__PURE__ */ new Date()).toISOString();
  for (const path of await deliveryStateFiles(taskPath)) {
    try {
      const state = JSON.parse(await readFile4(path, "utf8"));
      if (state !== null && typeof state === "object") {
        await writeFile3(path, `${JSON.stringify({ ...state, url: null, destroyedAt })}
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
function describeBudget(ms) {
  if (ms >= 6e4 && ms % 6e4 === 0) return `${Math.round(ms / 6e4)} minutes`;
  if (ms >= 6e4) return `${Math.floor(ms / 6e4)} minutes ${Math.round(ms % 6e4 / 1e3)} seconds`;
  return `${ms}ms`;
}
function deployEntryRefusal(script, root) {
  if (!isInside(resolve4(root), resolve4(script))) return "outside";
  let stats;
  try {
    stats = statSync2(script);
  } catch {
    return "missing";
  }
  return stats.isFile() ? "" : "not-a-file";
}
async function findDeployScript(taskPath, recorded) {
  const named = typeof recorded?.deployScript === "string" ? recorded.deployScript.trim() : "";
  const deployRoot = taskDeployRootPath(taskPath);
  if (named !== "") {
    const script = resolve4(taskPath, ...named.split("/").filter((part) => part !== ""));
    const refusal2 = deployEntryRefusal(script, deployRoot);
    if (refusal2 !== "") {
      const because = refusal2 === "outside" ? `it is not inside the task space's own deploy root (${deployRoot})` : refusal2 === "not-a-file" ? "it is a directory, not a file" : "it is not there";
      throw coded(
        "E5008",
        `the deploy script this task's record names cannot be run: ${because}. The record is ${named}.
  The record lives inside the task space, so the session working there can write it, and the path is re-checked here rather than trusted; put the entry under \`${DEPLOY_DIR}/\` inside the task space, or clear the record's \`deployScript\` to fall back to that directory's own \`deploy.sh\`.`,
        { path: taskPath, deployScript: named, reason: refusal2 }
      );
    }
    return { script, dir: dirname5(script) };
  }
  const entries = await readdir3(taskPath, { withFileTypes: true }).catch(() => []);
  const candidates = [{ dir: deployRoot, root: deployRoot }];
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name !== PLUGIN_ROOT2) {
      candidates.push({ dir: join7(taskPath, entry.name, DEPLOY_ROOT), root: taskPath });
    }
  }
  for (const candidate of candidates) {
    const script = join7(candidate.dir, "deploy.sh");
    if (deployEntryRefusal(script, candidate.root) !== "") continue;
    return { script, dir: candidate.dir };
  }
  return void 0;
}
async function smokeEnvironment(subprocess, taskPath, { signal } = {}) {
  const recorded = await requireRecorded(taskPath);
  const envId = typeof recorded.deploymentEnvId === "string" ? recorded.deploymentEnvId.trim() : "";
  const found = await findDeployScript(taskPath, recorded);
  if (found === void 0) {
    throw coded("E5008", `no deploy script exists in this task space, so there is nothing to smoke: ${taskPath}`);
  }
  const command = deployEntryCommand(found.script, "smoke", envId);
  const timeouts = await deployTimeouts(subprocess, found, taskPath, envId, { signal });
  let out;
  try {
    out = await runProcess(subprocess, command.argv, {
      cwd: found.dir,
      maxBytes: 2 * 1024 * 1024,
      // A smoke runs a test suite, so it is allowed minutes - but not forever. Without
      // this the handler that asked for it waits on a script that may never exit. The
      // script's own `timeouts` may raise or lower it; the point past which this side
      // stops waiting is a fact about the machine either way.
      timeoutMs: timeouts.smokeMs,
      // Where the script must merge `lastSmoke`. Handed over rather than left to a
      // convention, so a script in a subdirectory writes the same file as one at the top.
      env: { ...deployEnvironmentFor(taskPath, envId), ...command.env },
      ...signal === void 0 ? {} : { signal }
    });
  } catch (error) {
    throw coded("E5008", `the deploy script could not be started (${error.message}); bash must be on the PATH the server runs with`);
  }
  return {
    output: outputTail(out.stderr, out.stdout),
    exitCode: out.exitCode,
    // Reported rather than folded into the exit code, because a script this side stopped
    // has no exit code to read: the smoke did not fail, it did not finish, and the card
    // has to be able to say which. A red badge over a timeout would read as a real
    // verdict on the environment.
    timedOut: out.timedOut,
    status: await deploymentStatus(subprocess, taskPath),
    // The smoke is what the gate waits for, so this is the moment its answer is
    // most useful: a red one says so here, while the user is still on the card,
    // rather than as an E5006 refusal at the finish.
    gate: await deliveryGatePreview(recorded, taskPath)
  };
}
async function deployEnvironment(subprocess, taskPath, { signal } = {}) {
  const recorded = await requireRecorded(taskPath);
  const envId = typeof recorded.deploymentEnvId === "string" ? recorded.deploymentEnvId.trim() : "";
  const found = await findDeployScript(taskPath, recorded);
  if (found === void 0) {
    throw coded("E5008", `no deploy script exists in this task space, so there is nothing to deploy: ${taskPath}`);
  }
  const command = deployEntryCommand(found.script, "up", envId);
  const timeouts = await deployTimeouts(subprocess, found, taskPath, envId, { signal });
  let out;
  try {
    out = await runProcess(subprocess, command.argv, {
      cwd: found.dir,
      maxBytes: 2 * 1024 * 1024,
      // A rebuild pulls images and starts services, so this is the longest deadline here
      // - and still a deadline. A build that has not answered in ten minutes is one that
      // is not going to, and the person who pressed the button is owed the answer. A
      // script that knows its build is slower than that says so through `timeouts`.
      timeoutMs: timeouts.upMs,
      // Where the script must write `url`. Handed over rather than left to a convention, so
      // a script in a subdirectory writes the same file as one at the top.
      env: { ...deployEnvironmentFor(taskPath, envId), ...command.env },
      ...signal === void 0 ? {} : { signal }
    });
  } catch (error) {
    throw coded("E5008", `the deploy script could not be started (${error.message}); bash must be on the PATH the server runs with`);
  }
  if (out.timedOut) {
    throw coded(
      "E5008",
      `the deploy script did not finish within ${describeBudget(timeouts.upMs)} and was stopped:
${outputTail(out.stderr, out.stdout)}`
    );
  }
  if (!out.ok) {
    throw coded("E5008", `the deploy script failed with exit code ${out.exitCode}:
${outputTail(out.stderr, out.stdout)}`);
  }
  await stampDeployedAt(taskPath);
  return {
    output: outputTail(out.stdout),
    status: await deploymentStatus(subprocess, taskPath),
    // What a finish would still be waiting for, read now rather than discovered as
    // an E5006 refusal at the very end. The deploy has just run, so this is
    // the first moment the question can be answered at all.
    gate: await deliveryGatePreview(recorded, taskPath),
    // Asked after `up` exited zero, which is the only moment it can be asked: the
    // script has run, so whatever it started either carries the label or does not.
    ...await labelledContainerWarning(subprocess, envId, { signal })
  };
}
async function labelledContainerWarning(subprocess, envId, { signal } = {}) {
  if (envId === "") return {};
  const found = await askedContainerIds(subprocess, envId, { signal });
  if (!found.answered || found.ids.length > 0) return {};
  return {
    warning: warned(
      "deploy-no-labelled-containers",
      `the deploy script exited successfully but no container carries this environment's label (\`dsh.env-id=${envId}\`), so the finish will not be able to tear the environment down; check that the script labels its containers with \`$DEPLOY_ENV_ID\`, or take them down yourself`,
      { envId, label: `dsh.env-id=${envId}` }
    )
  };
}
async function stampDeployedAt(taskPath) {
  const deployedAt = (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
  for (const path of await deliveryStateFiles(taskPath)) {
    try {
      const state = JSON.parse(await readFile4(path, "utf8"));
      if (state !== null && typeof state === "object") {
        await writeFile3(path, `${JSON.stringify({ ...state, deployedAt })}
`, "utf8");
      }
    } catch {
    }
  }
}

// src/host/task/concurrency.js
var SCAN_CONCURRENCY = 6;
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
import { existsSync as existsSync5 } from "node:fs";
import { readdir as readdir5, stat as stat5 } from "node:fs/promises";
import { basename as basename4, dirname as dirname6, join as join10 } from "node:path";

// src/host/task/container.js
import { existsSync as existsSync4 } from "node:fs";
import { mkdir as mkdir3, writeFile as writeFile4 } from "node:fs/promises";
import { join as join8 } from "node:path";
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
  if (existsSync4(join8(root, ".git"))) {
    throw coded(
      "E1005",
      `the tasks root ${root} is a git repository
  worktree spaces must be filed under a directory that is not one, or every task would be committed into it; put the container beside the repositories instead`
    );
  }
  await mkdir3(root, { recursive: true });
  const notice = join8(root, CONTAINER_README);
  if (!existsSync4(notice)) await writeFile4(notice, CONTAINER_NOTICE, "utf8");
}

// src/host/task/discover.js
import { readdir as readdir4, stat as stat4 } from "node:fs/promises";
import { basename as basename3, join as join9, resolve as resolve5 } from "node:path";

// src/host/task/scan-bounds.js
var MAX_SCAN_DIRECTORIES = 2e3;
var MAX_SCAN_DIRECTORIES_CEILING = 1e4;
var MIN_SCAN_DEPTH = 1;
var MAX_SCAN_DEPTH = 5;
var DEFAULT_SCAN_DEPTH = 3;
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
  "DerivedDataCache",
  // This plugin's own task container, under both of the names it takes.
  //
  // Registering the container root as a Workspace is how the sessions a finish hands
  // an agent end up under one group rather than in Ungrouped, and that puts the
  // container in the set of roots a scan walks. What is in it is task spaces, which
  // are linked worktrees of repositories the scan has already found elsewhere, and
  // archived documents - so walking it spends budget on directories that hold no
  // repository of their own. Named rather than skipped by path because a scan is
  // handed Workspace roots and walks them: the name is the only thing left to compare.
  // A user whose own directory is called this and does hold repositories can take the
  // name back off this list on the Plugins page, which is what that setting is for.
  "worktree-space",
  "dsh-worktree-space"
];
var DEFAULT_IGNORED_SCAN_DIRECTORY_SET = new Set(
  DEFAULT_IGNORED_SCAN_DIRECTORIES.map((name2) => name2.toLowerCase())
);

// src/host/task/discover.js
var DEFAULT_MAX_DIRECTORIES = MAX_SCAN_DIRECTORIES;
async function isSourceRepository(directory) {
  try {
    return (await stat4(join9(directory, ".git"))).isDirectory();
  } catch {
    return false;
  }
}
async function discoverSourceRepos(sourceRoot, {
  signal,
  maxDepth = 1,
  maxDirectories = DEFAULT_MAX_DIRECTORIES,
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
        entries = await readdir4(path, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith(".")) continue;
        if (entry.name.endsWith(".worktrees")) continue;
        if (ignored.has(entry.name.toLowerCase())) continue;
        queue.push({ path: join9(path, entry.name), depth: depth + 1 });
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
    const candidate = await rootAnswersForItself(entry) ? resolve5(sourceRoot) : resolve5(sourceRoot, entry);
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
    return (await stat5(directory)).isDirectory();
  } catch {
    return false;
  }
}
async function suggestTaskRoot(subprocess, sourceRoot, { tasksRoot, branchPrefix = DEFAULT_BRANCH_PREFIX, configuredRoot = "", signal, ...bounds } = {}) {
  const requested = typeof tasksRoot === "string" ? tasksRoot.trim() : "";
  const suggested = resolveTasksRoot(sourceRoot, requested, configuredRoot);
  assertIsolated(sourceRoot, suggested);
  const repositories = await discoverSourceRepos(sourceRoot, { signal, ...bounds });
  return {
    sourceRoot,
    suggested,
    explicit: requested !== "",
    // The same resolution a create performs, so the preview the dialog shows and
    // the branch the host would make cannot disagree.
    branchPrefix: validateBranchPrefix(branchPrefix),
    // One git call per repository, a few at a time: the dialog's cards name the
    // branch each HEAD is on, which is the fact the repository view shows for its
    // main worktree.
    //
    // Bounded rather than `Promise.all`, and that is not a detail. A repository is
    // one `git rev-parse`, and this used to spawn all of them at once: with forty
    // repositories that was forty `git.exe` processes alive together, spending their
    // time in process creation competing with each other - the same mistake the scan
    // was fixed for, and the sibling function above already reads its repositories
    // through the same pool. The two entry points funnel here (`task.suggest-root`
    // and the agent tool's `suggest-root`), so this one line is the ceiling for both.
    repositories: await mapWithLimit(repositories, SCAN_CONCURRENCY, async (repoPath) => {
      const branch = await currentBranchOf(subprocess, repoPath);
      return {
        name: basename4(repoPath),
        path: repoPath,
        ...branch === void 0 ? {} : { branch }
      };
    })
  };
}
async function currentBranchOf(subprocess, repoPath) {
  const branch = await tryRunGit(subprocess, repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return branch === "" || branch === "HEAD" ? void 0 : branch;
}
async function inspectTask(taskPath) {
  const path = String(taskPath ?? "").trim();
  const name2 = basename4(path);
  const containerRoot = dirname6(dirname6(path));
  const notATask = { path, isTask: false, task: name2, project: basename4(dirname6(path)), tasksRoot: containerRoot, repositories: [] };
  if (path === "") return notATask;
  let entries;
  try {
    entries = await readdir5(path, { withFileTypes: true });
  } catch {
    return notATask;
  }
  const repositories = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (await isLinkedWorktree(join10(path, entry.name))) repositories.push(entry.name);
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
    project: typeof details?.project === "string" && details.project !== "" ? details.project : basename4(dirname6(path)),
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
  if (!existsSync5(root)) return { tasksRoot: root, tasks: [] };
  if (existsSync5(join10(root, ".git"))) {
    throw coded(
      "E1001",
      `the tasks root must not be a git repository itself: ${root}
  a container root is a directory this plugin created, and a repository's subdirectories are its source layout rather than projects`,
      { path: root }
    );
  }
  const projects = await readdir5(root, { withFileTypes: true });
  const tasks = [];
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    if (project.name === CONTAINER_ARCHIVE_FOLDER) continue;
    const projectPath = join10(root, project.name);
    for (const entry of await readdir5(projectPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const taskPath = join10(projectPath, entry.name);
      const recorded = await readTaskMetadata(taskPath);
      const sessions = taskSessionsOf(recorded);
      tasks.push({
        name: entry.name,
        project: project.name,
        path: taskPath,
        // A container that holds no record and no worktree is not a task this
        // plugin made; it is still listed (the dialog needs to see it to offer
        // recovery), and it simply answers with no sessions and no deployment.
        ...sessions.length === 0 ? {} : { sessions },
        delivery: await deliveryStateSummary(taskPath),
        repositories: await listTaskWorktrees(subprocess, taskPath)
      });
    }
  }
  tasks.sort((left, right) => left.project.localeCompare(right.project) || left.name.localeCompare(right.name));
  return { tasksRoot: root, tasks };
}

// src/host/task/create.js
import { existsSync as existsSync6, statSync as statSync3 } from "node:fs";
import { cp, mkdir as mkdir4, readdir as readdir8, rm as rm3, writeFile as writeFile5 } from "node:fs/promises";
import { basename as basename5, isAbsolute as isAbsolute2, join as join13, resolve as resolve6 } from "node:path";

// src/host/task/e2e.js
import { readFile as readFile5, readdir as readdir6 } from "node:fs/promises";
import { join as join11, relative } from "node:path";
var E2E_CONFIG_STEMS = ["playwright.config", "cypress.config"];
var SKIP_DIRECTORIES = /* @__PURE__ */ new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  "target",
  "vendor",
  "__pycache__",
  ".venv",
  "venv"
]);
var E2E_CONFIG_DEPTH = 2;
var E2E_NAMES_SHOWN = 3;
function isE2eConfig(name2) {
  const dot = name2.lastIndexOf(".");
  if (dot <= 0) return false;
  return E2E_CONFIG_STEMS.includes(name2.slice(0, dot));
}
async function findE2eConfigs(worktreePath) {
  const found = [];
  const queue = [{ path: worktreePath, depth: 0 }];
  while (queue.length > 0) {
    const { path, depth } = queue.shift();
    let entries;
    try {
      entries = await readdir6(path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && isE2eConfig(entry.name)) found.push(relative(worktreePath, join11(path, entry.name)));
      else if (entry.isDirectory() && depth < E2E_CONFIG_DEPTH && !SKIP_DIRECTORIES.has(entry.name)) {
        queue.push({ path: join11(path, entry.name), depth: depth + 1 });
      }
    }
  }
  return found;
}
async function inspectE2eConfigs(worktreePath) {
  const findings = [];
  for (const rel of await findE2eConfigs(worktreePath)) {
    let text;
    try {
      text = await readFile5(join11(worktreePath, rel), "utf8");
    } catch {
      continue;
    }
    const { reusesExistingServer, fixedUrls } = inspectE2eConfig(text);
    if (!reusesExistingServer && fixedUrls.length === 0) continue;
    findings.push({ path: rel, reusesExistingServer, fixedUrls });
  }
  return findings;
}
function inspectE2eConfig(text) {
  const source = String(text ?? "");
  const reuses = /reuseExistingServer\s*:\s*true\b/.test(source);
  const urls = /* @__PURE__ */ new Set();
  for (const match of source.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::(\d+))?/g)) {
    urls.add(match[0]);
  }
  return { reusesExistingServer: reuses, fixedUrls: [...urls] };
}

// src/host/task/links.js
import { mkdtemp, readdir as readdir7, rm as rm2, symlink } from "node:fs/promises";
import { tmpdir as tmpdir2 } from "node:os";
import { join as join12, relative as relative2 } from "node:path";
function symlinksRefused() {
  linkProbe ??= (async () => {
    const probe = await mkdtemp(join12(tmpdir2(), "dsh-worktree-link-"));
    try {
      await symlink(join12(probe, "target"), join12(probe, "link"));
      return false;
    } catch {
      return true;
    } finally {
      await rm2(probe, { recursive: true, force: true }).catch(() => {
      });
    }
  })();
  return linkProbe;
}
var linkProbe;
async function findLinks(directory, { maxEntries = 2e3 } = {}) {
  const found = [];
  const queue = [directory];
  let seen = 0;
  let truncated = false;
  while (queue.length > 0 && seen < maxEntries) {
    const current = queue.shift();
    let children;
    try {
      children = await readdir7(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      seen += 1;
      if (seen > maxEntries) {
        truncated = true;
        break;
      }
      const path = join12(current, child.name);
      if (child.isSymbolicLink()) {
        found.push(relative2(directory, path));
        continue;
      }
      if (child.isDirectory()) queue.push(path);
    }
  }
  if (queue.length > 0 && seen >= maxEntries) truncated = true;
  return { links: found, truncated };
}

// src/host/task/create.js
var LINK_NAMES_SHOWN = 3;
var WRITE_STATE_SCRIPT = String.raw`#!/bin/sh
# Merge one deployment fact into this deploy root's .state.json.
#
# Why a script: that file is the handshake with the Worktree Space plugin, and
# every writer of it has to keep the fields it does not own. destroyedAt is
# written by the plugin when the environment is destroyed; a deploy that rewrote
# the file from scratch would forget that it is down. So this merges: it reads
# whatever is there, replaces only the one top-level field it was asked for, and
# writes the whole object back as one line - the shape every reader of it expects.
#
# There is no jq on this machine, so the merge is done with awk, which is.
#
#   ./write-state.sh url <url>          after up, the acceptance URL
#   ./write-state.sh smoke pass|fail    after smoke, stamped with the UTC now
#   ./write-state.sh services <json>    optional service list, as raw JSON
#
# The file it writes is the one the plugin names in DEPLOY_STATE_FILE, so a script
# in a subdirectory writes the same file as one at the top: nothing here has to know
# where the deploy root is. Without that variable it falls back to the file beside
# this script, which is where a deploy root at the top puts it.
#
# It never writes destroyedAt: that is the plugin's own.
set -eu

state="${"${"}DEPLOY_STATE_FILE:-$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/.state.json}"

usage() {
  echo "usage: write-state.sh url <url> | smoke pass|fail | services <json>" >&2
  exit 2
}

# A value is data, not JSON: quote and escape it so it can sit in the object.
json_string() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/^/"/' -e 's/$/"/'
}

# Rewrite the object with top-level key replaced, or added when it was absent.
# value is raw JSON. It travels by environment rather than awk -v, because -v
# would eat the backslashes inside it.
merge() {
  key="$1"
  value="$2"
  [ -f "$state" ] || printf '{}\n' > "$state"
  # A file that is not an object cannot be merged into. Refusing leaves the
  # bytes alone, which is the one outcome that cannot lose somebody's ack.
  if [ "$(sed -e 's/^[[:space:]]*//' "$state" | cut -c1)" != "{" ]; then
    echo "write-state.sh: $state is not a JSON object; left untouched" >&2
    exit 1
  fi
  tmp="$state.$$.tmp"
  VALUE="$value" awk -v want="$key" '
    { text = text $0 }
    END {
      n = length(text)
      i = index(text, "{") + 1
      out = ""
      found = 0
      while (i <= n) {
        while (i <= n) {
          c = substr(text, i, 1)
          if (c == "," || c == " " || c == "\t" || c == "\r") i++; else break
        }
        if (i > n) break
        if (substr(text, i, 1) != "\"") break
        ks = i
        i++
        while (i <= n) {
          c = substr(text, i, 1)
          if (c == "\\") { i += 2; continue }
          if (c == "\"") { i++; break }
          i++
        }
        kraw = substr(text, ks, i - ks)
        while (i <= n && substr(text, i, 1) ~ /[ \t\r\n]/) i++
        if (substr(text, i, 1) != ":") break
        i++
        while (i <= n && substr(text, i, 1) ~ /[ \t\r\n]/) i++
        vs = i
        c = substr(text, i, 1)
        if (c == "\"") {
          i++
          while (i <= n) {
            c = substr(text, i, 1)
            if (c == "\\") { i += 2; continue }
            if (c == "\"") { i++; break }
            i++
          }
        } else if (c == "{" || c == "[") {
          opener = c
          closer = (c == "{") ? "}" : "]"
          d = 0
          instr = 0
          while (i <= n) {
            c = substr(text, i, 1)
            if (instr) {
              if (c == "\\") { i += 2; continue }
              if (c == "\"") instr = 0
              i++
              continue
            }
            if (c == "\"") { instr = 1; i++; continue }
            if (c == opener) d++
            else if (c == closer) { d--; if (d == 0) { i++; break } }
            i++
          }
        } else {
          while (i <= n) {
            c = substr(text, i, 1)
            if (c == "," || c == "}") break
            i++
          }
        }
        vraw = substr(text, vs, i - vs)
        sub(/[ \t\r\n]+$/, "", vraw)
        if (substr(kraw, 2, length(kraw) - 2) == want) { vraw = ENVIRON["VALUE"]; found = 1 }
        if (out != "") out = out ","
        out = out kraw ":" vraw
      }
      if (!found) {
        if (out != "") out = out ","
        out = out "\"" want "\":" ENVIRON["VALUE"]
      }
      printf "{%s}\n", out
    }
  ' "$state" > "$tmp" || { rm -f "$tmp"; exit 1; }
  mv "$tmp" "$state"
}

[ "$#" -ge 1 ] || usage

case "$1" in
  url)
    [ "$#" -ge 2 ] || usage
    merge url "$(json_string "$2")"
    ;;
  smoke)
    [ "$#" -ge 2 ] || usage
    case "$2" in
      pass|fail) ;;
      *) usage ;;
    esac
    merge lastSmoke "{\"result\":\"$2\",\"at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"
    ;;
  services)
    [ "$#" -ge 2 ] || usage
    merge services "$2"
    ;;
  *)
    usage
    ;;
esac
`;
var STATE_EXAMPLE = '{"url":"http://localhost:5173","services":["web","api"],"lastSmoke":{"result":"pass","at":"2026-01-01T00:00:00Z"}}\n';
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
function holdsOnlyOurs(leftovers, created, owned) {
  return leftovers.every((name2) => owned.includes(name2) || created.some((entry) => basename5(entry.path) === name2));
}
async function rollbackTask(subprocess, tasksRoot, taskPath, branch, created) {
  const owned = TASK_OWNED_ENTRIES;
  const stranded = [];
  for (const entry of created) {
    const refused2 = refuseDelete(tasksRoot, entry.path, `the worktree '${entry.name}'`);
    if (refused2 !== "") {
      stranded.push(entry.name);
      continue;
    }
    const removed = await gitSucceeded(subprocess, entry.repoPath, ["worktree", "remove", "--force", entry.path]);
    if (!removed && await isLinkedWorktree(entry.path)) {
      stranded.push(entry.name);
      continue;
    }
    if (!removed) {
      if (await gitSucceeded(subprocess, entry.repoPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]) && !await gitSucceeded(subprocess, entry.repoPath, ["branch", "-D", "--", branch])) {
        stranded.push(`${entry.name}'s branch ${branch}`);
      }
      continue;
    }
    if (!await gitSucceeded(subprocess, entry.repoPath, ["branch", "-D", "--", branch])) {
      stranded.push(`${entry.name}'s branch ${branch}`);
    }
  }
  if (stranded.length > 0) return stranded;
  const container = `the task space ${basename5(taskPath)}`;
  const refused = refuseDelete(tasksRoot, taskPath, container);
  if (refused !== "") {
    stranded.push(container);
    return stranded;
  }
  let leftovers;
  try {
    leftovers = await readdir8(taskPath);
  } catch (error) {
    if (error?.code !== "ENOENT") stranded.push(container);
    return stranded;
  }
  if (!holdsOnlyOurs(leftovers, created, owned)) {
    stranded.push(container);
    return stranded;
  }
  try {
    await rm3(taskPath, { recursive: true, force: true });
  } catch {
    stranded.push(container);
  }
  return stranded;
}
function resolveDeployScript(sourceRoot, requested) {
  const value = String(requested ?? "").trim();
  if (value === "") return "";
  if (isAbsolute2(value)) {
    throw coded("E4014", `the deploy script must be a path relative to the source root, not an absolute one: ${value}`);
  }
  const resolved = resolve6(sourceRoot, value);
  if (!isInside(sourceRoot, resolved)) {
    throw coded("E4014", `the deploy script must name a file inside the source root, not one outside it: ${value}`);
  }
  const deployRoot = sourceDeployRootPath(sourceRoot);
  if (!isInside(deployRoot, resolved)) {
    throw coded("E4014", `the deploy script must live under the workspace's \`${DEPLOY_DIR}/\` directory: ${value}`);
  }
  if (!existsSync6(resolved) || !statSync3(resolved).isFile()) {
    throw coded("E4014", `the deploy script must name a file that exists inside the source root: ${value}`);
  }
  return value.replace(/^\.\//, "").replace(/\\/g, "/");
}
async function createTask(subprocess, options) {
  const {
    sourceRoot,
    task,
    tasksRoot: requestedRoot,
    repos,
    baseRef,
    branchPrefix = DEFAULT_BRANCH_PREFIX,
    // A file path relative to the workspace, naming the entry under its
    // `.worktree-space/deploy/` directory. It travels into the task space under its own
    // name and the record remembers it as this task's entry. Empty means the entry is
    // `.worktree-space/deploy/deploy.sh`, which is what the create would produce anyway.
    deployScript = "",
    configuredRoot = "",
    // How far to look for the repositories a task covers. The same bounds the
    // classification and the suggestion used, so the count on the Workspace card,
    // the list in the create dialog, and what this actually takes are one number
    // rather than three that happen to disagree.
    scanBounds: scanBounds2 = {},
    // The delivery policy as this request stated it. One field now: whether this
    // task expects a deployment. Resolved below, once, before anything is made.
    delivery
  } = options;
  const name2 = validateTaskName(task);
  const prefix = validateBranchPrefix(branchPrefix);
  const tasksRoot = resolveTasksRoot(sourceRoot, requestedRoot, configuredRoot);
  assertIsolated(sourceRoot, tasksRoot);
  const project = projectNameFor(sourceRoot);
  const policy = resolveDeliveryPolicy(delivery);
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
  const names = selected.map((repoPath) => validateRepositoryDirectoryName(basename5(repoPath)));
  const duplicate = names.find((entry, index) => names.indexOf(entry) !== index);
  if (duplicate !== void 0) {
    throw coded("E4002", `two selected repositories are both named '${duplicate}'; select repositories with distinct names`);
  }
  const deployScriptPath = resolveDeployScript(sourceRoot, deployScript);
  if (policy.deploy.target !== "none") {
    const named = deployScriptPath !== "";
    const sourceEntry = existsSync6(join13(sourceDeployRootPath(sourceRoot), "deploy.sh"));
    const repoEntry = selected.some((repoPath) => existsSync6(join13(repoPath, DEPLOY_ROOT, "deploy.sh")));
    if (!named && !sourceEntry && !repoEntry) {
      throw coded(
        "E4015",
        `the task is set to deploy (deployTarget docker), but nothing can deploy it: no deploy script was named, ${sourceRoot} carries no \`${DEPLOY_DIR}/deploy.sh\`, and none of the selected repositories carries its own. Add that file, name an existing one under \`${DEPLOY_DIR}/\` with deployScript, or create the task with deployTarget none and deploy it by hand.`,
        { sourceRoot }
      );
    }
  }
  const branch = branchNameFor(name2, prefix);
  const taskPath = taskSpacePath(tasksRoot, project, name2);
  auditEnter({ task: name2, project, tasksRoot });
  if (existsSync6(taskPath)) {
    const existing = await readTaskMetadata(taskPath).catch(() => void 0);
    const ours = existing !== void 0 && existing.task === name2 && existing.project === project && existing.branch === branch;
    const error = coded("E2001", `task space already exists: ${taskPath}`, { path: taskPath });
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
  await mkdir4(join13(tasksRoot, project), { recursive: true });
  await mkdir4(taskPath);
  const created = [];
  const warnings = [];
  try {
    const sourceDeploy = sourceDeployRootPath(sourceRoot);
    if (existsSync6(sourceDeploy)) {
      await cp(sourceDeploy, taskDeployRootPath(taskPath), { recursive: true, force: true });
    }
    if (!existsSync6(taskDeployRootPath(taskPath))) {
      await mkdir4(taskDeployRootPath(taskPath), { recursive: true });
      await writeFile5(join13(taskDeployRootPath(taskPath), "write-state.sh"), WRITE_STATE_SCRIPT, { mode: 493 });
      await writeFile5(join13(taskDeployRootPath(taskPath), ".state.json.example"), STATE_EXAMPLE);
    }
    for (const [index, repoPath] of selected.entries()) {
      const worktreePath = join13(taskPath, names[index]);
      const facts = await sourceFacts(subprocess, repoPath);
      const args = baseRef === void 0 || `${baseRef}`.trim() === "" ? ["worktree", "add", worktreePath, "-b", branch] : ["worktree", "add", worktreePath, "-b", branch, `${baseRef}`];
      created.push({ name: names[index], path: worktreePath, repoPath, ...facts });
      await runGit(subprocess, repoPath, args);
    }
    await writeTaskMetadata(taskPath, taskMetadata({
      task: name2,
      project,
      tasksRoot,
      sourceRoot,
      branch,
      baseRef: baseRef === void 0 || `${baseRef}`.trim() === "" ? void 0 : `${baseRef}`,
      delivery: policy,
      // Which entry under `.worktree-space/deploy/` this task runs, when the create named
      // one. Absent means `.worktree-space/deploy/deploy.sh`, so a record made before this
      // field existed reads the same way it always did.
      deployScript: deployScriptPath === "" ? void 0 : deployScriptPath,
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
  const links = [];
  let linksTruncated = false;
  if (await symlinksRefused()) {
    for (const entry of created) {
      const found = await findLinks(entry.path);
      links.push(...found.links);
      if (found.truncated) linksTruncated = true;
    }
  }
  if (linksTruncated) {
    warnings.push(warned(
      "workspace-holds-links",
      `this machine will not recreate a symbolic link, and a worktree holds more entries than the link scan will walk - so the links in this task space could not be counted (${links.length} were found before the scan stopped). They cannot be filed when this task is finished; move or delete them before then, or the finish will leave them in place and stop.`,
      { count: links.length, links: links.slice(0, LINK_NAMES_SHOWN), shown: LINK_NAMES_SHOWN, truncated: true }
    ));
  } else if (links.length > 0) {
    const named = links.slice(0, LINK_NAMES_SHOWN).join(", ");
    const more = links.length > LINK_NAMES_SHOWN ? ` (and ${links.length - LINK_NAMES_SHOWN} more)` : "";
    warnings.push(warned(
      "workspace-holds-links",
      `this machine will not recreate a symbolic link, and the worktrees hold ${links.length} of them: ${named}${more}. They cannot be filed when this task is finished; move or delete them before then, or the finish will leave them in place and stop.`,
      { count: links.length, links: links.slice(0, LINK_NAMES_SHOWN), shown: LINK_NAMES_SHOWN }
    ));
  }
  const stacks = [];
  for (const entry of created) {
    for (const finding of await inspectE2eConfigs(entry.path)) {
      stacks.push({ repo: entry.name, ...finding });
    }
  }
  if (stacks.length > 0) {
    const named = stacks.slice(0, E2E_NAMES_SHOWN).map((one) => `${one.repo}: ${one.path}`).join(", ");
    const more = stacks.length > E2E_NAMES_SHOWN ? ` (and ${stacks.length - E2E_NAMES_SHOWN} more)` : "";
    const reused = stacks.some((one) => one.reusesExistingServer);
    warnings.push(warned(
      "workspace-e2e-points-elsewhere",
      `the repositories' own end-to-end configuration names the stack it runs against: ${named}${more}. ` + (reused ? "At least one of them reuses a server that is already running" : "They name fixed local addresses") + ", so a suite run from this task space may verify whatever is already listening rather than this task's own instance. Point it at this task's acceptance address, or bring a configuration that does, before reading its result as a regression.",
      { configs: stacks.slice(0, E2E_NAMES_SHOWN), count: stacks.length, shown: E2E_NAMES_SHOWN, reused }
    ));
  }
  return {
    task: name2,
    project,
    branch,
    path: taskPath,
    tasksRoot,
    baseRef: baseRef === void 0 || `${baseRef}`.trim() === "" ? void 0 : `${baseRef}`,
    repositories: created.map((entry) => ({ name: entry.name, path: entry.path })),
    warnings
  };
}

// src/host/task/add.js
import { existsSync as existsSync7 } from "node:fs";
import { readFile as readFile6, rm as rm4, writeFile as writeFile6 } from "node:fs/promises";
import { basename as basename6, join as join14 } from "node:path";
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
async function rollbackAdded(subprocess, tasksRoot, branch, created) {
  const stranded = [];
  for (const entry of created) {
    const refused = refuseDelete(tasksRoot, entry.path, `the worktree '${entry.name}'`);
    if (refused !== "") {
      stranded.push(entry.name);
      continue;
    }
    const removed = await gitSucceeded(subprocess, entry.repoPath, ["worktree", "remove", "--force", entry.path]);
    if (!removed && await isLinkedWorktree(entry.path)) {
      stranded.push(entry.name);
      continue;
    }
    if (!removed) {
      if (await gitSucceeded(subprocess, entry.repoPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]) && !await gitSucceeded(subprocess, entry.repoPath, ["branch", "-D", "--", branch])) {
        stranded.push(`${entry.name}'s branch ${branch}`);
      }
      continue;
    }
    if (!await gitSucceeded(subprocess, entry.repoPath, ["branch", "-D", "--", branch])) {
      stranded.push(`${entry.name}'s branch ${branch}`);
    }
  }
  return stranded;
}
async function restoreMetadata(taskPath, previousJson, previousReadme) {
  for (const [name2, before] of [[TASK_METADATA, previousJson], [TASK_README, previousReadme]]) {
    try {
      if (before === void 0) {
        await rm4(join14(pluginRootPath(taskPath), name2), { force: true });
      } else {
        await writeFile6(join14(pluginRootPath(taskPath), name2), before, "utf8");
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
  if (!existsSync7(taskPath)) throw coded("E2003", `no such task space: ${taskPath}`, { path: taskPath });
  auditEnter({ task, project: projectName, tasksRoot: tasksRoot.trim() });
  const worktrees = await listTaskWorktrees(subprocess, taskPath);
  if (worktrees.length === 0) {
    throw coded("E2004", `no git worktrees found in ${taskPath}, so there is no branch this task can be extended on`, { path: taskPath, reason: "no-worktrees-to-extend" });
  }
  const metadata = await readTaskMetadata(taskPath);
  const branch = await branchOf(subprocess, metadata, worktrees);
  if (branch === void 0) {
    throw coded("E2004", `the worktrees in ${taskPath} do not agree on a branch, so this task cannot be extended; finish it or name a new task`, { path: taskPath, reason: "branches-disagree" });
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
    const name2 = validateRepositoryDirectoryName(basename6(repoPath));
    if (selected.some((entry) => entry.name === name2)) {
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
    selected.push({ repoPath, name: name2 });
  }
  const previousJson = await readFile6(join14(pluginRootPath(taskPath), TASK_METADATA), "utf8").catch(() => void 0);
  const previousReadme = await readFile6(join14(pluginRootPath(taskPath), TASK_README), "utf8").catch(() => void 0);
  const created = [];
  try {
    for (const { repoPath, name: name2 } of selected) {
      const worktreePath = join14(taskPath, name2);
      const facts = await sourceFacts(subprocess, repoPath);
      const args = start === void 0 ? ["worktree", "add", worktreePath, "-b", branch] : ["worktree", "add", worktreePath, "-b", branch, start];
      created.push({ name: name2, path: worktreePath, repoPath, ...facts });
      await runGit(subprocess, repoPath, args);
    }
    await writeTaskMetadata(taskPath, {
      ...recorded,
      branch,
      // The task's `baseRef` is NOT rewritten by an add, and that is the whole of this
      // line's job. It used to read `start ?? recorded.baseRef ?? null`, which let one
      // add that named a base overwrite the fact the CREATE recorded - so a task created
      // from `main` and later extended with `baseRef: v1.2.0` would have its record say
      // it was based on `v1.2.0`, and the repositories added at create time would be
      // described by a base they were never cut from.
      //
      // It is not that both values are unknowable; it is that the field answers one
      // question - "where did this task start" - and an add does not change the answer.
      // What this call used is a fact about the repositories *this call* added, and it is
      // already recorded on those entries: `startCommit` is the commit each checkout was
      // actually cut from, which is a stronger statement than the ref that named it. A
      // separate per-entry `baseRef` is deliberately NOT written - nothing reads it, and a
      // field that is only ever written is one no test can hold to an interpretation.
      //
      // The field has exactly one writer (the create) and one reader (the note rendered
      // for a session), which is what makes "one question, one writer" true here rather
      // than aspirational. The base this call used is reported to the caller as
      // `result.baseRef` and recorded in the audit line, so the fact is not lost - it is
      // just not written into the task's identity, where it would be a second answer to a
      // question the create already answered.
      //
      // `recorded.baseRef ?? null` is kept rather than dropped: it normalises a record
      // that predates the field, and `null` is what `taskMetadata` writes for "no base was
      // named", so a rewritten record keeps the same shape it was read with.
      baseRef: recorded.baseRef ?? null,
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
    const stranded = await rollbackAdded(subprocess, tasksRoot, branch, created);
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
import { existsSync as existsSync8 } from "node:fs";
import { cp as cp2, mkdir as mkdir5, mkdtemp as mkdtemp2, open as open2, readdir as readdir9, rename as rename2, rmdir, rm as rm5 } from "node:fs/promises";
import { tmpdir as tmpdir3 } from "node:os";
import { basename as basename7, join as join15, relative as relative3 } from "node:path";

// src/host/task/session-guard.js
function sessionsWorkingIn(ctx, taskPath) {
  if (typeof ctx?.get !== "function") return [];
  let agents;
  try {
    agents = ctx.get("agents");
  } catch {
    return [];
  }
  if (agents === void 0 || agents === null || typeof agents.list !== "function") return [];
  let listed;
  try {
    listed = agents.list();
  } catch {
    return [];
  }
  const found = [];
  for (const agent of Array.isArray(listed) ? listed : []) {
    const cwd = agent?.session?.header?.cwd;
    if (typeof cwd !== "string" || cwd === "") continue;
    if (canonicalPath(cwd) !== canonicalPath(taskPath) && !isInside(taskPath, cwd)) continue;
    const running = agent.status === "running";
    const openTurn = turnIsOpen(agent.session);
    const inbox = agent.inbox;
    const queued = inbox?.hasPending === true || (inbox?.nextTurn?.length ?? 0) + (inbox?.nextStep?.length ?? 0) > 0;
    if (!running && !openTurn && !queued) continue;
    found.push({ sessionId: String(agent.id), running, openTurn, queued });
  }
  return found;
}
function turnIsOpen(session) {
  if (session === void 0 || session === null || typeof session.snapshotEvents !== "function") return false;
  let events;
  try {
    events = session.snapshotEvents();
  } catch {
    return false;
  }
  let open4 = false;
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type === "turn/start") open4 = true;
    if (event?.type === "turn/end") open4 = false;
  }
  return open4;
}
function refuseWhileSessionsWork(ctx, taskPath, callerSessionId = "") {
  const caller = typeof callerSessionId === "string" ? callerSessionId : "";
  const working = sessionsWorkingIn(ctx, taskPath).filter((entry) => caller === "" || entry.sessionId !== caller);
  if (working.length === 0) return;
  const described = working.map((entry) => {
    const why = [
      entry.running ? "running" : "",
      entry.openTurn ? "mid-turn" : "",
      entry.queued ? "with work queued" : ""
    ].filter(Boolean).join(", ");
    return `${entry.sessionId}${why === "" ? "" : ` (${why})`}`;
  }).join("; ");
  throw coded(
    "E5012",
    `a session is still working in this task space: ${described}. Finishing removes the worktrees and the task space, so a session that is mid-turn would lose the directory it is writing into and the work it has not committed. Stop those sessions first - \`wts_session_tool cancel\` stops one, and \`wts_session_tool status\` says what each is doing - then call done again. If the work is not meant to stop, leave the task space standing: it is still there, and nothing has been removed.`,
    // Structured as well as spoken, so the panel can say it in the reader's language the way it
    // already does for E5011. The English above is the model's and the log's copy.
    { sessions: working }
  );
}

// src/host/task/archive.js
async function mergeInProgress(subprocess, site) {
  return gitSucceeded(subprocess, site, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]);
}
async function conflictedFiles(subprocess, site) {
  const output = await tryRunGit(subprocess, site, ["diff", "--name-only", "-z", "--diff-filter=U"]);
  return output.split("\0").filter((line) => line !== "");
}
var MARKER_SCAN_MAX_BYTES = 1024 * 1024;
async function readHead(path) {
  const handle = await open2(path, "r");
  try {
    const buffer = Buffer.alloc(MARKER_SCAN_MAX_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}
async function conflictMarkers(subprocess, site) {
  const changed = await tryRunGit(subprocess, site, ["diff", "--name-only", "-z", "HEAD"]);
  const listed = [.../* @__PURE__ */ new Set([...changed.split("\0"), ...await conflictedFiles(subprocess, site)])].filter((line) => line !== "");
  const marked = [];
  for (const file of listed) {
    let text = "";
    try {
      text = await readHead(join15(site, file));
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
    (await tryRunGit(subprocess, site, ["diff", "--name-only", "-z", base, branch])).split("\0").filter((path) => path !== "")
  );
  return dirty.filter((path) => written.has(path));
}
async function resolveMergeTarget(subprocess, mainRepo, requested, taskBranch, knownCheckedOut) {
  const name2 = basename7(mainRepo);
  const checkedOut = typeof knownCheckedOut === "string" ? knownCheckedOut : await tryRunGit(subprocess, mainRepo, ["rev-parse", "--abbrev-ref", "HEAD"]);
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
    if (await mergeInProgress(subprocess, mainRepo)) {
      throw coded(
        "E5004",
        `the checkout at ${mainRepo} has a merge of its own in progress, so this merge was not started and nothing there was aborted: ${mainRepo}. Conclude or abort that merge yourself, then finish the task.`
      );
    }
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
  const holder = await mkdtemp2(join15(tmpdir3(), "dsh-worktree-space-merge-"));
  const worktree = join15(holder, "worktree");
  const drop = async ({ aborted }) => {
    if (aborted) await gitSucceeded(subprocess, worktree, ["merge", "--abort"]);
    if (!await gitSucceeded(subprocess, mainRepo, ["worktree", "remove", "--force", worktree])) {
      await gitSucceeded(subprocess, mainRepo, ["worktree", "prune"]);
    }
    await rm5(holder, { recursive: true, force: true });
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
  if (!existsSync8(taskPath)) throw coded("E2003", `no such task space: ${taskPath}`, { path: taskPath });
  auditEnter({ task, project: projectName, tasksRoot });
  const recorded = await readTaskMetadata(taskPath);
  const recordedSourceRoot = typeof recorded?.sourceRoot === "string" ? recorded.sourceRoot.trim() : "";
  const recordedRepos = (Array.isArray(recorded?.repositories) ? recorded.repositories : []).map((entry) => typeof entry?.sourcePath === "string" ? entry.sourcePath.trim() : "").filter((path) => path !== "");
  const ownsRepo = (mainRepo) => {
    if (recordedRepos.some((path) => samePathLocation(path, mainRepo))) return true;
    if (recordedSourceRoot === "") return recordedRepos.length === 0;
    return samePathLocation(recordedSourceRoot, mainRepo) || isInside(recordedSourceRoot, mainRepo);
  };
  const entries = await readdir9(taskPath, { withFileTypes: true });
  const classified = await mapWithLimit(entries, SCAN_CONCURRENCY, async (entry) => {
    const entryPath = join15(taskPath, entry.name);
    if (entry.isDirectory() && await isLinkedWorktree(entryPath)) {
      return { worktree: entryPath };
    }
    if (TASK_OWNED_ENTRIES.includes(entry.name)) return void 0;
    const kind = strayKind(entry.name, entry.isDirectory());
    return {
      // Only the user's own directories are worth walking: nobody needs a
      // document count of `node_modules`.
      documents: kind !== "content" ? 0 : entry.isDirectory() ? await countDocuments(entryPath) : isDocument(entry.name) ? 1 : 0,
      stray: { name: entry.name, directory: entry.isDirectory(), kind }
    };
  });
  const worktrees = classified.filter((row) => row?.worktree !== void 0).map((row) => row.worktree);
  const strays = classified.filter((row) => row?.stray !== void 0).map((row) => ({ ...row.stray, documents: row.documents }));
  if (worktrees.length === 0) throw coded("E2004", `no git worktrees found in ${taskPath}`, { path: taskPath, reason: "none" });
  const repositories = await mapWithLimit(worktrees, SCAN_CONCURRENCY, async (worktreePath) => {
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
    else if (!ownsRepo(mainRepo)) {
      throw coded(
        "E1006",
        `${worktreePath} is a worktree of ${mainRepo}, which is not one of the repositories this task recorded${recordedSourceRoot === "" ? "" : ` (source root ${recordedSourceRoot})`}
  a task may only merge and delete inside the repositories it was created from or added`,
        { path: worktreePath, mainRepo, sourceRoot: recordedSourceRoot, repositories: recordedRepos }
      );
    } else {
      const checkedOut = await tryRunGit(subprocess, mainRepo, ["rev-parse", "--abbrev-ref", "HEAD"]);
      if (checkedOut !== "" && checkedOut !== "HEAD") plan.checkedOut = checkedOut;
      plan.branches = await mergeCandidates(subprocess, mainRepo, listed, branch, plan.checkedOut);
      try {
        plan.target = await resolveMergeTarget(subprocess, mainRepo, targets?.[name2], branch, checkedOut);
        const ahead = await tryRunGit(subprocess, worktreePath, ["rev-list", "--count", `${plan.target}..HEAD`]);
        const counted = Number.parseInt(ahead, 10);
        if (Number.isFinite(counted)) plan.commits = counted;
      } catch (error) {
        plan.error = error.message;
      }
    }
    return plan;
  });
  const mergeTarget = repositories.find((row) => row.target !== void 0)?.target;
  const changedFiles = repositories.reduce((sum, row) => sum + row.changedFiles, 0);
  const commits = repositories.reduce((sum, row) => sum + (row.commits ?? 0), 0);
  await auditOutcome(repositories, [], "plan");
  const gate = await deliveryGatePreview(await readTaskMetadata(taskPath), taskPath);
  return { task, project: projectName, path: taskPath, tasksRoot: tasksRoot.trim(), mergeTarget, changedFiles, commits, repositories, strays, gate };
}
var DOCUMENT_EXTENSIONS = /* @__PURE__ */ new Set([".md", ".markdown", ".mdx", ".txt", ".rst", ".adoc"]);
var LINK_NAMES_SHOWN2 = 3;
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
async function removeCopiedLeavingLinks(directory) {
  let kept = false;
  let children;
  try {
    children = await readdir9(directory, { withFileTypes: true });
  } catch {
    return true;
  }
  for (const child of children) {
    const path = join15(directory, child.name);
    if (child.isSymbolicLink()) {
      kept = true;
      continue;
    }
    if (child.isDirectory()) {
      if (await removeCopiedLeavingLinks(path)) kept = true;
      else await rmdir(path).catch(() => {
      });
      continue;
    }
    await rm5(path, { force: true }).catch(() => {
    });
  }
  return kept;
}
async function worktreeRegistered(subprocess, mainRepo, worktreePath) {
  const porcelain = await tryRunGit(subprocess, mainRepo, ["worktree", "list", "--porcelain"]);
  return parseWorktrees(porcelain).some((row) => samePathLocation(row.path, worktreePath));
}
var REMOVAL_PROBE_SUFFIX = ".dsh-removal-probe";
async function recoverRemovalProbes(taskPath) {
  let entries;
  try {
    entries = await readdir9(taskPath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.endsWith(REMOVAL_PROBE_SUFFIX)) continue;
    const name2 = entry.name.slice(0, -REMOVAL_PROBE_SUFFIX.length);
    if (name2 === "") continue;
    await rename2(join15(taskPath, entry.name), join15(taskPath, name2)).catch(() => {
    });
  }
}
async function removableNow(directory) {
  const probe = `${directory}${REMOVAL_PROBE_SUFFIX}`;
  try {
    await rename2(directory, probe);
  } catch (error) {
    return `${error?.code ?? "unremovable"}: ${error?.message ?? error}`;
  }
  let putBack = "";
  try {
  } finally {
    try {
      await rename2(probe, directory);
    } catch (error) {
      putBack = `the check renamed it and could not put it back: it is now at ${probe} (${error?.message ?? error})`;
    }
  }
  return putBack;
}
async function countDocuments(directory, { maxEntries = 200 } = {}) {
  let seen = 0;
  let found = 0;
  const queue = [directory];
  while (queue.length > 0 && seen < maxEntries) {
    const current = queue.shift();
    let children;
    try {
      children = await readdir9(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      seen += 1;
      if (seen > maxEntries) break;
      if (child.isDirectory()) queue.push(join15(current, child.name));
      else if (isDocument(child.name)) found += 1;
    }
  }
  return found;
}
async function finishTask(subprocess, options) {
  const { ctx, callerSessionId = "", ...rest } = options ?? {};
  if (typeof rest.tasksRoot !== "string" || rest.tasksRoot.trim() === "") throw coded("E1004", "a tasks root is required");
  const projectName = validateProjectName(rest.project);
  const taskPath = taskSpacePath(rest.tasksRoot, projectName, rest.task);
  if (ctx !== void 0) refuseWhileSessionsWork(ctx, taskPath, callerSessionId);
  return withTaskLock(taskPath, async () => {
    if (ctx !== void 0) refuseWhileSessionsWork(ctx, taskPath, callerSessionId);
    return finishTaskLocked(subprocess, options);
  });
}
async function finishTaskLocked(subprocess, options) {
  const {
    task,
    project,
    tasksRoot,
    merge: askedMerge,
    target,
    targets,
    deleteBranch: askedDeleteBranch,
    force = false,
    // The caller's choice for what happens to untracked files. Bound to a distinct
    // name here because `strays` below is the list of entries themselves, and a
    // parameter and a local of one name in one scope is a collision the parser
    // refuses - which is the language catching what would otherwise read as one
    // variable doing two jobs.
    strays: strayChoice,
    keepEntries = [],
    documentsDirectory,
    cause,
    acknowledgeDelivery = false,
    deliveryArchive
  } = options;
  if (typeof tasksRoot !== "string" || tasksRoot.trim() === "") throw coded("E1004", "a tasks root is required");
  const projectName = validateProjectName(project);
  const taskPath = taskSpacePath(tasksRoot, projectName, task);
  if (!existsSync8(taskPath)) throw coded("E2003", `no such task space: ${taskPath}`, { path: taskPath });
  auditEnter({ task, project: projectName, tasksRoot });
  if (!existsSync8(taskMetadataPath(taskPath))) {
    throw coded(
      "E2005",
      `${taskPath} holds no ${PLUGIN_ROOT2}/${TASK_METADATA}, so this plugin has no record of creating it and nothing in it will be deleted.
  What is missing: ${taskMetadataPath(taskPath)}
  If this really is a task space this plugin made and its record was removed by hand, restore the file from a backup before finishing it.`,
      { path: taskPath, missing: taskMetadataPath(taskPath) }
    );
  }
  const warnings = [];
  const recorded = await readTaskMetadata(taskPath);
  if (typeof recorded?.task === "string" && recorded.task !== "" && recorded.task !== task) {
    throw coded(
      "E2007",
      `${taskPath} holds the record of task '${recorded.task}', not of '${task}', so nothing in it will be deleted.
  Recorded: ${recorded.task}
  Requested: ${task}
  If you meant that task, ask for it under the name its record uses.`,
      { path: taskPath, recorded: recorded.task, requested: task }
    );
  }
  if (typeof recorded?.project === "string" && recorded.project !== "" && recorded.project !== projectName) {
    throw coded(
      "E2007",
      `${taskPath} holds the record of a task in project '${recorded.project}', not in '${projectName}', so nothing in it will be deleted.
  Recorded: ${recorded.project}
  Requested: ${projectName}`,
      { path: taskPath, recorded: recorded.project, requested: projectName }
    );
  }
  const merge = askedMerge === true;
  const deleteBranch = askedDeleteBranch === true;
  if (deleteBranch && !merge && !force) {
    throw coded("E4007", "deleting a branch that was never merged requires force");
  }
  const taskBranch = typeof recorded?.branch === "string" ? recorded.branch : "";
  if (taskBranch === "") {
    warnings.push(warned("no-task-branch", `no task branch is recorded in ${taskPath}; no branch was deleted in any repository`, { path: taskPath }));
  }
  const strayed = applyStraysPolicy({
    strays: strayChoice,
    documentsDirectory,
    keepEntries
  }, deliveryArchive, taskPath);
  const strayCleanStray = strayed.cleanStray;
  const strayDiscardDocuments = strayed.discardDocuments;
  const strayDestination = strayed.documentsDirectory;
  const keep = strayed.keep;
  if (strayDestination !== "") assertIsolated(taskPath, strayDestination);
  const gateWarning = await assertDeliveryGate(recorded, taskPath, { merge, bypass: acknowledgeDelivery === true });
  if (gateWarning !== void 0) warnings.push(gateWarning);
  await recoverRemovalProbes(taskPath);
  const entries = await readdir9(taskPath, { withFileTypes: true });
  const recordedNames = new Set(
    (Array.isArray(recorded?.repositories) ? recorded.repositories : []).map((entry) => typeof entry?.name === "string" ? entry.name : "").filter((name2) => name2 !== "")
  );
  const worktrees = [];
  const remains = [];
  const classifiedEntries = await mapWithLimit(entries, SCAN_CONCURRENCY, async (entry) => {
    if (!entry.isDirectory()) return void 0;
    const worktreePath = join15(taskPath, entry.name);
    if (await isLinkedWorktree(worktreePath)) return { worktree: worktreePath };
    return recordedNames.has(entry.name) ? { remains: worktreePath } : void 0;
  });
  for (const row of classifiedEntries) {
    if (row?.worktree !== void 0) worktrees.push(row.worktree);
    else if (row?.remains !== void 0) remains.push(row.remains);
  }
  if (worktrees.length === 0 && remains.length === 0) throw coded("E2004", `no git worktrees found in ${taskPath}`, { path: taskPath, reason: "none" });
  const probes = await mapWithLimit(worktrees, SCAN_CONCURRENCY, async (worktreePath) => ({
    path: worktreePath,
    reason: await removableNow(worktreePath)
  }));
  const held = probes.filter((entry) => entry.reason !== "");
  if (held.length > 0) {
    throw coded(
      "E5011",
      `${held.length === 1 ? "one worktree is" : `${held.length} worktrees are`} held by something outside this process and cannot be removed, so nothing has been merged, removed or filed yet:
` + held.map((entry) => `  ${entry.path}
    ${entry.reason}`).join("\n") + "\n  A dev server, a browser or an editor started in the task space is the usual one; close it, then finish the task again.",
      { held }
    );
  }
  const repositories = [];
  let failed = false;
  const strandedByRemoval = /* @__PURE__ */ new Set();
  const probesByPath = /* @__PURE__ */ new Map();
  await mapWithLimit(worktrees, SCAN_CONCURRENCY, async (worktreePath) => {
    const branch = await tryRunGit(subprocess, worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const porcelain = await tryRunGit(subprocess, worktreePath, ["worktree", "list", "--porcelain"]);
    const midMerge = await mergeInProgress(subprocess, worktreePath);
    const uncommitted = (merge || !deleteBranch) && !force && !midMerge ? await uncommittedCount(subprocess, worktreePath) : 0;
    probesByPath.set(worktreePath, { branch, porcelain, midMerge, uncommitted });
  });
  for (const worktreePath of worktrees) {
    const name2 = basename7(worktreePath);
    const probed = probesByPath.get(worktreePath) ?? { branch: "", porcelain: "", midMerge: false, uncommitted: 0 };
    const { branch, porcelain, midMerge } = probed;
    const mainRepo = parseWorktrees(porcelain).find((row) => row.isMain)?.path ?? "";
    const outcome = { name: name2, path: worktreePath, mainRepo, branch, merged: false, removed: false, branchDeleted: false, conflict: false, mergeInProgress: false, mergeSite: "", conflictedFiles: [], needsCommit: false, dirtyCheckout: false };
    if (mainRepo === "") {
      outcome.error = "cannot locate the source repository";
      repositories.push(outcome);
      failed = true;
      continue;
    }
    if ((merge || !deleteBranch) && !force && !midMerge && probed.uncommitted > 0) {
      outcome.needsCommit = true;
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
        const mergeTarget = await resolveMergeTarget(subprocess, mainRepo, targets?.[name2] ?? target, branch);
        outcome.target = mergeTarget;
        if (!await gitSucceeded(subprocess, worktreePath, ["merge-base", "--is-ancestor", mergeTarget, branch])) {
          const rehearsalBase = await runGit(subprocess, worktreePath, ["rev-parse", "HEAD"]);
          try {
            await runGit(subprocess, worktreePath, ["merge", "--no-ff", "--no-edit", mergeTarget]);
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
        await mergeIntoBranch(subprocess, mainRepo, branch, mergeTarget);
        outcome.merged = true;
      } catch (error) {
        const dirtyCheckout = error?.code === "E5004" || /would be overwritten by merge/i.test(String(error?.message ?? ""));
        outcome.dirtyCheckout = dirtyCheckout;
        const standingInWorktree = !dirtyCheckout && await mergeInProgress(subprocess, worktreePath);
        const standingInMain = !dirtyCheckout && !standingInWorktree && mainRepo !== "" && await mergeInProgress(subprocess, mainRepo);
        outcome.mergeInProgress = standingInWorktree || standingInMain;
        outcome.conflict = outcome.mergeInProgress;
        if (outcome.mergeInProgress) {
          outcome.mergeSite = standingInWorktree ? worktreePath : mainRepo;
          outcome.conflictedFiles = await conflictedFiles(subprocess, outcome.mergeSite);
        }
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
      if (await worktreeRegistered(subprocess, mainRepo, worktreePath)) {
        outcome.error = "failed to remove the worktree (uncommitted changes? force it deliberately)";
        repositories.push(outcome);
        failed = true;
        continue;
      }
      try {
        await rm5(worktreePath, { recursive: true, force: true });
      } catch (error) {
        outcome.error = `git unregistered this worktree but could not delete it, and the plugin could not either (${error.message}); it is still on disk at ${worktreePath} and has to be removed by hand`;
        repositories.push(outcome);
        failed = true;
        strandedByRemoval.add(name2);
        continue;
      }
      await gitSucceeded(subprocess, mainRepo, ["worktree", "prune", "--expire", "now"]);
    }
    outcome.removed = true;
    if (deleteBranch) {
      if (branch !== taskBranch) {
        outcome.branchDeleted = false;
        warnings.push(warned(
          "branch-left-alone",
          branch === "" ? `'${name2}' has no branch checked out, so no branch was deleted in '${mainRepo}'` : `'${name2}' is on '${branch}', not on the task branch '${taskBranch}', so that branch was left alone in '${mainRepo}'`,
          { name: name2, mainRepo, branch, taskBranch }
        ));
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
        if (!deleted) warnings.push(warned("branch-not-deleted", `branch '${branch}' was not deleted in '${name2}'`, { branch, name: name2 }));
      }
    }
    repositories.push(outcome);
  }
  for (const worktreePath of remains) {
    const name2 = basename7(worktreePath);
    strandedByRemoval.add(name2);
    failed = true;
    repositories.push({
      name: name2,
      path: worktreePath,
      mainRepo: "",
      branch: "",
      merged: false,
      removed: false,
      branchDeleted: false,
      mergeInProgress: false,
      mergeSite: "",
      conflictedFiles: [],
      error: `this worktree is no longer registered in its source repository and is still on disk at ${worktreePath}; git unregistered it but could not delete it, so it has to be removed by hand before the task space can be cleared`
    });
  }
  const leftovers = await readdir9(taskPath, { withFileTypes: true });
  let stillOpen = false;
  for (const entry of leftovers) {
    if (!entry.isDirectory()) continue;
    if (strandedByRemoval.has(entry.name) || await isLinkedWorktree(join15(taskPath, entry.name))) {
      stillOpen = true;
      break;
    }
  }
  const latest = await readTaskMetadata(taskPath).catch(() => void 0);
  if (latest !== void 0 && latest !== null && typeof latest === "object") {
    await writeSourceTaskIndex(taskPath, latest, taskSessionsOf(latest)).catch(() => false);
  }
  if (!stillOpen && strayCleanStray) {
    await rm5(pluginRootPath(taskPath), { recursive: true, force: true });
    await rm5(join15(taskPath, BREADCRUMB), { force: true });
  }
  const remainingEntries = await readdir9(taskPath, { withFileTypes: true });
  const strays = [];
  const content = /* @__PURE__ */ new Set();
  for (const entry of remainingEntries) {
    if (entry.isDirectory() && await isLinkedWorktree(join15(taskPath, entry.name))) continue;
    if (entry.isDirectory() && strandedByRemoval.has(entry.name)) continue;
    if (TASK_OWNED_ENTRIES.includes(entry.name)) continue;
    strays.push(entry.name);
    if (strayKind(entry.name, entry.isDirectory()) === "content") content.add(entry.name);
    if (entry.isDirectory()) {
      const refused = refuseDelete(tasksRoot, join15(taskPath, entry.name), `the leftover '${entry.name}'`);
      if (refused !== "") {
        keep.push(entry.name);
        warnings.push(warned("leftover-refused", refused, { name: entry.name, path: join15(taskPath, entry.name) }));
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
      const source = join15(taskPath, name2);
      const destination = join15(strayDestination, name2);
      const seenLinks = await symlinksRefused() ? await findLinks(source) : { links: [], truncated: false };
      const links = seenLinks.truncated ? [] : seenLinks.links;
      try {
        await mkdir5(strayDestination, { recursive: true });
        if (seenLinks.truncated) {
          warnings.push(warned(
            "leftover-holds-links",
            `could not archive '${name2}' into '${strayDestination}': it holds more entries than the link scan will walk, so whether it holds a link could not be settled - and a copy that cannot account for every link may stop part-way on one. It is left in the task space exactly as it stands.`,
            { name: name2, destination: strayDestination, links: [], truncated: true }
          ));
          keptByFailure.push(name2);
          continue;
        }
        if (links.length === 0) {
          await cp2(source, destination, { recursive: true, force: false, errorOnExist: true });
        } else {
          const skip = new Set(links.map((entry) => join15(source, entry)));
          await cp2(source, destination, {
            recursive: true,
            force: false,
            errorOnExist: true,
            filter: (from) => !skip.has(from)
          });
        }
      } catch (error) {
        if (error?.code !== "EEXIST") await rm5(destination, { recursive: true, force: true }).catch(() => {
        });
        warnings.push(warned("leftover-copy-failed", `could not archive '${name2}' to '${strayDestination}': ${error.message}`, { name: name2, destination: strayDestination, reason: error.message }));
        keptByFailure.push(name2);
        continue;
      }
      if (links.length > 0) {
        const named = links.slice(0, LINK_NAMES_SHOWN2).join(", ");
        const more = links.length > LINK_NAMES_SHOWN2 ? `, and ${links.length - LINK_NAMES_SHOWN2} more` : "";
        warnings.push(warned(
          "leftover-holds-links",
          `filed '${name2}' into '${strayDestination}' except for ${links.length === 1 ? "a link" : `${links.length} links`} (${named}${more}): this machine will not let DSH create one, so the link and the directories holding it were left in the task space exactly as they stand - removing or moving those entries out is what lets the finish complete`,
          { name: name2, destination: strayDestination, links, shown: LINK_NAMES_SHOWN2 }
        ));
        await removeCopiedLeavingLinks(source);
        keptByFailure.push(name2);
        archivedStrays.push(name2);
        continue;
      }
      archivedStrays.push(name2);
    }
    await rm5(join15(taskPath, name2), { recursive: true, force: true });
    if (strayDestination === "") removedStrays.push(name2);
  }
  if (strayCleanStray) {
    for (const name2 of strays) {
      if (keep.includes(name2) || keptByFailure.includes(name2)) continue;
      if (archivedStrays.includes(name2) || removedStrays.includes(name2)) continue;
      await rm5(join15(taskPath, name2), { recursive: true, force: true });
      removedStrays.push(name2);
    }
  }
  const remaining = await readdir9(taskPath);
  let containerRemoved = false;
  if (remaining.length === 0) {
    containerRemoved = true;
    try {
      await rmdir(taskPath);
    } catch {
      containerRemoved = false;
    }
  }
  if (containerRemoved) {
    const recordedSourceRoot = typeof recorded?.sourceRoot === "string" ? recorded.sourceRoot : "";
    const recordedProject = typeof recorded?.project === "string" && recorded.project !== "" ? recorded.project : projectName;
    const recordedTask = typeof recorded?.task === "string" && recorded.task !== "" ? recorded.task : task;
    const indexFile = sourceTaskIndexPath(recordedSourceRoot, recordedProject, recordedTask);
    try {
      await archiveSourceTaskIndex(taskPath, {
        ...recorded,
        sourceRoot: recordedSourceRoot,
        project: recordedProject,
        task: recordedTask
      });
    } catch {
      warnings.push(warned(
        "task-index-left",
        `the task space was removed but its index could not be filed into the archive: ${indexFile} still points at a directory that is gone`,
        { path: indexFile, sourceRoot: recordedSourceRoot }
      ));
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
          warnings.push(warned("deploy-cleanup-failed", `deployment cleanup failed for ${envId}: ${error.message}`, { envId, reason: error.message }));
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
    // What is left in the task space: kept because a copy failed, kept because a link could
    // not be recreated and only part of it could be filed, kept because the fence refused to
    // remove it, or simply never disposed of. A partly filed stray belongs here even though
    // it is also in `archivedStrays` - the link it could not file is still on disk.
    strays: strays.filter((name2) => keptByFailure.includes(name2) || !removedStrays.includes(name2) && !archivedStrays.includes(name2)),
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
var statusKey = (value) => canonicalPath(absolutePath(value));
var scans = /* @__PURE__ */ new Map();
var statuses = /* @__PURE__ */ new Map();
var remember = (map, key, value, limit) => {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value);
};
function scanKey(paths, bounds = {}) {
  const pathsKey = canonicalPathSet(paths);
  if (pathsKey === "") return "";
  const depth = Number.isFinite(bounds.depth) ? String(bounds.depth) : "";
  const ignored = [...bounds.ignored ?? []].map((name2) => String(name2).toLowerCase()).sort().join(",");
  return `${pathsKey}\0${depth}\0${ignored}`;
}
function rememberScan(paths, repositories, bounds = {}) {
  const key = scanKey(paths, bounds);
  if (key === "") return;
  remember(scans, key, repositories, SCAN_CACHE_LIMIT);
}
function rememberStatus(path, status) {
  const key = statusKey(path);
  if (key === "") return;
  remember(statuses, key, status, STATUS_CACHE_LIMIT);
}
function recallScan(paths, bounds = {}) {
  const key = scanKey(paths, bounds);
  const repositories = key === "" ? void 0 : scans.get(key);
  if (repositories === void 0) return void 0;
  const remembered = {};
  for (const repository of repositories) {
    for (const worktree of repository.worktrees ?? []) {
      const status = statuses.get(statusKey(worktree.path));
      if (status !== void 0) remembered[worktree.path] = status;
    }
  }
  return { repositories, statuses: remembered };
}

// src/host/task/skill.js
import { closeSync, existsSync as existsSync9, openSync, readFileSync, readSync } from "node:fs";
import { open as open3 } from "node:fs/promises";
import { basename as basename8, dirname as dirname7, join as join16, resolve as resolve7 } from "node:path";
import { fileURLToPath } from "node:url";
var PROVIDER_NAME = "dsh-worktree-space";
var SKILL_NAME = "worktree-space";
var PACKAGE_NAME = "dsh-worktree-space";
var BUNDLED_SKILL_RANK = 600;
var SKILL_FILE = "SKILL.md";
function packageRoot() {
  let directory = dirname7(fileURLToPath(import.meta.url));
  for (; ; ) {
    const manifest = join16(directory, "package.json");
    if (existsSync9(manifest)) {
      try {
        if (JSON.parse(readFileSync(manifest, "utf8")).name === PACKAGE_NAME) return directory;
      } catch {
      }
    }
    const parent = dirname7(directory);
    if (parent === directory) {
      throw coded("E7001", `${PACKAGE_NAME}: cannot locate the package root for the bundled skill`);
    }
    directory = parent;
  }
}
var SKILL_MAX_BYTES = 256 * 1024;
async function readBounded(path, signal) {
  const handle = await open3(path, "r");
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
  const directory = join16(packageRoot(), "assets", "skill", SKILL_NAME);
  const skillPath = join16(directory, SKILL_FILE);
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
      if (asked !== "" && resolve7(asked) !== resolve7(skillPath)) {
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
import { randomUUID } from "node:crypto";
import { defineTool } from "@deepseek-ai/dsh-tools";
var DESCRIPTION = [
  "Create, list and finish a per-task Git worktree workspace spanning one or more repositories: one directory per project under the task space container, one directory per task, and under it a worktree of every selected repository on one branch. Drive it in order: suggest-root, then create, then list, then done. Ask the user for the task name and the container root before creating anything.",
  // The rule this tool exists to make reachable, stated as the default rather than as
  // one option among two: a caller that reads only this line and then does the work in
  // its own session has missed the point of the space it just made. The exception is
  // named in the same breath, because it is real - a user may say "do it here" - and a
  // default with no stated exception is read as a prohibition.
  "**The task is done by a session in the task space, not by this conversation.** Create the space with a `prompt` (or hand a later job over with `dispatch`) and the session that takes it does the work, with its own context and its own approval gate, while this conversation stays free to direct it. Implement the task in the current session only when the user explicitly asked for that - not because a prompt was easy to carry out here, and not because the space already exists. Every answer below repeats this where the next step is yours to choose.",
  '**Ask about the acceptance fence before you create a task space or dispatch a session into one, and never answer it for the user.** deployTarget "docker" means the task expects a deployment and **the smoke is the finish line** - the acceptance URL and a recorded pass are what a completion report carries, not the fact that the code is written - and "none" (the built-in default) means no deployment and no gate. The answer is settled on the create and cannot be added or changed afterwards, so never create a space, or open a session in one, with the question still open: a fence nobody chosen leaves the task with no acceptance record and no way to fit one. Where the task space goes is the user\'s question too - suggest-root answers with a recommendation, and never name a directory inside the source root or one that holds it. `references/deploying.md` says what a deploying space owes.',
  "done REQUIRES merge: true to land the branches, or false to leave the work where it is. There is no default and a finish without it is refused (E7006), because a merge is the one step here that cannot be walked back. This tool cannot do `force`: discarding uncommitted work, force-deleting a branch that never landed, and abandoning a task are the user's own decisions, on the management page - say so and send them there rather than retrying.",
  "A finish can stop on three things that are work rather than failures - `mergeInProgress`, `needsCommit` and `dirtyCheckout` - and each row says which by flag. None of them is this tool's to resolve by picking a side; references/finishing.md says what `needsCommit` needs, and `references/conflicts.md` what the other two do.",
  "Given a prompt, create and dispatch open a session in the task space and hand it that job. The id they answer with is written into the task's record and reported by list. Watch that session with wts_session_tool: it is NOT this session's child, so send_message cannot reach it. You are told when it dies mid-turn unless watchSession is false, because a session that dies cannot report itself - treat that notice as the task not being done.",
  "A deploying task is not finished until its smoke passes, and running that smoke needs no skill: read `.worktree-space/worktree-space.md` in the task space, which names this task's deploy entry, its DEPLOY_ENV_ID and the state file the gate reads. Its commands are the ones to run as written - `./<entry> up <env-id>` builds and prints the acceptance URL, `./<entry> smoke <env-id>` records the result. Pass the env id to every deploy command: without it the containers land under the entry's own id and the panel cannot see them. Then `done` with merge: true is refused (E5006) until that smoke is recorded as pass - never retry it, and never ask for an override, because this tool cannot send one. `references/deploying.md` is for writing or fixing an entry, not for running one that already works.",
  'When a task that already exists turns out to need another repository, add it with action "add" rather than creating a second task.',
  `strays says what happens to the files git never tracked: "archive" (the default) files them away so the finish can remove the space, "keep" leaves the space standing, and "discard" is refused here (E7007) - deleting the user's own writing is theirs to decide, on the panel.`
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
    conflict: false,
    mergeInProgress: false,
    mergeSite: "",
    conflictedFiles: [],
    needsCommit: false,
    dirtyCheckout: false,
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
    sessionId: { type: "string", required: true },
    /**
     * The sessions this task space has been worked in, newest first, as the
     * record carries them. Filled by `list`, and by the `create` / `dispatch`
     * that just opened one; empty when nothing has been recorded.
     */
    sessions: {
      type: "array",
      required: true,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          sessionId: { type: "string", required: true },
          role: { type: "string", required: true },
          at: { type: "string", required: true }
        }
      }
    },
    /**
     * What each task's deploy recorded, as `list` reads it: the acceptance URL and
     * the last smoke, so a caller does not have to open `.worktree-space/deploy/.state.json`.
     */
    deployment: {
      type: "array",
      required: true,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          task: { type: "string", required: true },
          url: { type: "string", required: true },
          smoke: { type: "string", required: true },
          smokeAt: { type: "string", required: true }
        }
      }
    },
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
          conflict: { type: "boolean", required: true },
          mergeInProgress: { type: "boolean", required: true },
          mergeSite: { type: "string", required: true },
          conflictedFiles: { type: "array", required: true, items: { type: "string" } },
          needsCommit: { type: "boolean", required: true },
          dirtyCheckout: { type: "boolean", required: true },
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
    sessionId: "",
    sessions: [],
    deployment: [],
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
  const explicit = absolutePath(tasksRoot);
  if (explicit !== "") return explicit;
  const source = absolutePath(sourceRoot);
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
async function stillRegistered(registry, taskPath) {
  try {
    const target = canonicalPath(taskPath);
    return registry.list().some((entry) => entry !== null && entry !== void 0 && canonicalPath(entry.path) === target);
  } catch {
    return true;
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
      if (!await stillRegistered(registry, taskPath)) continue;
      problems.push(String(error?.message ?? error));
    }
  }
  if (problems.length === 0) return "";
  return `the task space is gone but its DSH Workspace registration could not be dropped (${problems.join("; ")})${byHand}`;
}
function inheritedMode(ctx, exec) {
  const policy = typeof ctx.get === "function" ? ctx.get("sandboxPolicy") : void 0;
  const caller = exec?.agent?.session;
  if (policy === void 0 || policy === null || typeof policy.overrideOf !== "function" || caller === void 0) return void 0;
  try {
    const mode = policy.overrideOf(caller);
    return typeof mode === "string" && mode !== "" ? mode : void 0;
  } catch {
    return void 0;
  }
}
function taskBriefPreamble(facts) {
  const { tasksRoot, task, branch, callerSessionId, deployTarget } = facts;
  if (typeof task !== "string" || task === "") return "";
  const lines = [
    "# Standing instructions (added by Worktree Space)",
    "",
    `- You are working in a task space for **${task}**, at \`${tasksRoot}\`. Its repositories are`,
    `  separate checkouts on the branch \`${branch}\`; git commands run inside each repository`,
    "  subdirectory, not in the task space root.",
    "- **Never edit or commit in a source checkout, and never hand-merge there.** The task space is",
    "  where the work goes: `git push`, and a `git merge` you run yourself in a source repository, are",
    "  not yours to do. That is a different thing from finishing the task, which this plugin does for",
    "  you and which is the next point.",
    "- **Finishing is the user's decision, and either flow works.** Call `done` yourself once the work",
    "  is complete, or report back and let whoever dispatched you - or the user - call it. Ask which is",
    "  wanted when the task brief does not say, and never merge without that authorisation: `merge: true`",
    "  lands the work and is the one step a finish cannot take back. `merge: false` leaves the branch",
    "  where it is (the commits are kept, the worktree is still removed, so a leftover conflict would",
    "  have to be resolved in the source repository).",
    // Present only when the task space was created to deploy: the policy is settled at
    // create and this is the session that has to carry it out, so the one thing it must
    // not be able to say afterwards is that nobody told it the smoke was the finish line.
    ...deployTarget === "docker" ? [
      "- **This task is deployed for acceptance, so its smoke is the finish line.** Nothing is finished",
      "  until this task space's own deploy entry has run `smoke` and the result recorded is `pass`, and the",
      "  acceptance URL `up` wrote is what the report hands over. Code that is written is not the finish, and",
      "  a summary of it is not either: say what the smoke actually reported, or say that it has not run yet."
    ] : [],
    "- **The acceptance stack is this task's own.** Do not reuse a dev server or a stack that is",
    "  already running: a repository's own e2e configuration often points at one, and a suite run",
    "  against it reports green for code this task never built. Point it at this task's own",
    "  instance, or bring a configuration that does.",
    "- **Record delivery facts where the plugin reads them** (`.worktree-space/deploy/.state.json`): `url` after a",
    "  deploy, `lastSmoke` merged in after a smoke. Neither `up` nor `smoke` may write",
    "  `destroyedAt` - that stamp is the plugin's; only the entry's own optional `destroy`",
    "  writes it, together with nulling `url`.",
    "- **Long actions go to the background or a child session** (starting a stack, a full test run).",
    "  Do not hold the main flow on them."
  ];
  if (typeof callerSessionId === "string" && callerSessionId !== "") {
    lines.push(
      `- **Report back to \`${callerSessionId}\`** with \`wts_session_tool send\`. It is not your parent`,
      "  session, so `send_message` cannot reach it. The default `mode` is `steer`, which is what a",
      '  dispatched task needs - `mode: "queue"` is only read at a turn boundary, and a long task is',
      "  often one long turn, so name it only for something that may wait.",
      "  Your report is delivered attributed to this session and shown to the caller as an agent's",
      "  report, and the tool puts a header on it - the task, the workspace, the task-space path, the",
      "  branch and your session id - so write the body only: a self-contained account of what you did",
      "  and what you did not verify, not a note to yourself, and without repeating the header."
    );
  } else {
    lines.push(
      "- **Report with `wts_session_tool send`.** Its default `mode` is `steer`; name",
      '  `mode: "queue"` only for something that may wait for a turn boundary.'
    );
  }
  lines.push(
    "",
    "# Reporting back is required",
    "",
    "The session that dispatched you cannot see this one from the outside: your commands, your",
    "tests and your commits are invisible to it until you send it something. That is why the",
    "channel above is not a courtesy. **The four moments below are never optional.** Nor does",
    "finishing the work yourself replace reporting it: a session that calls `done` and then stops",
    "still leaves the caller with nothing but a task space that changed underneath it.",
    "",
    "- **Before you start work, once you understand the task.** A short report: what you take the",
    "  job to be, which repositories and files you expect to touch, and anything in the brief you",
    "  read differently from how it may have been meant. This is the moment an aim that was",
    "  misread is still cheap to correct - the caller learns what you are about to build before",
    "  you build it, and can redirect you in one message instead of reviewing a finished change",
    "  nobody asked for. Two or three sentences is the whole report; do not restate the brief, and",
    "  do not wait for an answer unless something is genuinely blocking.",
    "- **Every finished unit of delivery.** A unit is the smallest piece of the work that can be",
    "  committed and handed over on its own. If this task is really several of those - a plan of",
    "  independent steps, one repository done while another is still being written - report as each",
    "  one lands, not once at the end: that is what lets the caller redirect the next one before",
    "  it is built on an assumption nobody checked. A long stretch with no report is itself the",
    "  problem, so if you are unsure whether a moment counts, report it.",
    "- **The moment you are stuck.** A decision you cannot make alone, a question only the caller",
    "  or the user can answer, or a wall you cannot get past - an environment this plugin will not",
    "  give access to, a permission, a failing dependency, a design choice with a cost either way.",
    "  Say what you tried and what the options are. Report this **immediately**, not after a",
    "  second attempt and not only at the end: a session that silently grinds on a blocker wastes",
    "  the caller's time twice - once while it tries, and again while the caller assumes it is",
    '  working. "I am blocked on X, I think it needs Y" is a complete report.',
    "- **When the task is finished.** Even if you finished it, even if you called `done`, and",
    "  especially when it stopped short. A final report must state:",
    "  - the commit hash of each repository, and the subject line of each commit;",
    "  - the acceptance URL and where to look, when this task deployed something;",
    '  - what passed and what the evidence was (the command, and its result - not "tests pass");',
    "  - **what you did not verify**, and what a reader should not assume from your report;",
    "  - anything still in the way, or a decision of yours the caller may want to revisit.",
    "",
    "Between those four, report when you judge a report helps the caller act: something landed",
    "that changes what comes next, an assumption turned out false, or the shape of the work changed",
    "enough that the brief the caller wrote no longer describes it. Outside the four, a report",
    "that would only say nothing happened is one to skip."
  );
  lines.push(
    "",
    "# The work",
    ""
  );
  return lines.join("\n");
}
function setSessionPermission(session, mode) {
  if (session === void 0 || session === null || typeof session.append !== "function") return false;
  session.append("sandbox/mode", { mode, source: "delegation" });
  if (mode === "danger-full-access") session.append("approval/policy", { policy: "never", source: "delegation" });
  return true;
}
async function dispatchToSession(ctx, exec, request, watcher) {
  const service2 = (name2) => typeof ctx.get === "function" ? ctx.get(name2) : void 0;
  const controller = service2("sessionController");
  const sessions = service2("sessions");
  if (controller === void 0 || controller === null || typeof controller.create !== "function" || typeof controller.prompt !== "function") {
    return {
      sessionId: "",
      reason: 'this deployment serves no session service, so no session was opened; open one in the task space from the Worktree Space panel ("Create and open") instead'
    };
  }
  let place = request.place === void 0 ? { cwd: request.taskPath } : request.place;
  let reason = "";
  const registry = workspaceRegistryOf(ctx);
  if (request.place === void 0 && registry !== void 0) {
    const unregistered = await registerTaskWorkspace(registry, request.taskPath, request.sourceRoot, request.task);
    if (unregistered !== "") {
      reason = `the task space could not be registered as a DSH Workspace (${unregistered}), so the session may not appear in that group in the workspace list`;
    } else if (typeof registry.resolveByPath === "function") {
      const record = await registry.resolveByPath(request.taskPath);
      if (record !== void 0 && record !== null && typeof record.id === "string" && record.id !== "") {
        place = { workspaceId: record.id };
      }
    }
  }
  let sessionId = "";
  try {
    const created = await controller.create(place);
    sessionId = typeof created?.sessionId === "string" ? created.sessionId : "";
  } catch (error) {
    return { sessionId: "", reason: `the session could not be opened (${String(error?.message ?? error)})` };
  }
  if (sessionId === "") {
    return { sessionId: "", reason: "the session service answered without a session id, so no session was opened" };
  }
  const mode = request.requested === "inherit" ? inheritedMode(ctx, exec) : request.requested;
  if (mode !== void 0 && typeof sessions?.get === "function") {
    setSessionPermission(sessions.get(sessionId), mode);
  }
  try {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const recorded = await readTaskMetadata(request.taskPath);
    const deployTarget = recorded === void 0 ? "none" : deliveryPolicyOf(recorded).deploy.target;
    const preamble = taskBriefPreamble({
      tasksRoot: request.tasksRoot,
      task: request.task,
      branch: request.branch,
      callerSessionId: exec?.agent?.session?.id,
      deployTarget
    });
    await controller.prompt({
      requestId: randomUUID(),
      sessionId,
      mode: "queue",
      content: [{ type: "text", text: `${preamble}${request.prompt}` }],
      ...typeof timeZone === "string" && timeZone !== "" ? { clientTimeZone: timeZone } : {}
    }, new AbortController().signal);
  } catch (error) {
    return {
      sessionId,
      reason: `the session was opened but the work could not be handed to it (${String(error?.message ?? error)}); open it and say what to do`
    };
  }
  if (request.watch !== false) watchDispatchedSession(watcher, sessionId, request, exec);
  return { sessionId, reason };
}
async function recordDispatchLeader(taskPath, memberSessionId, exec, warnings) {
  const callerSessionId = exec?.agent?.session?.id ?? exec?.agent?.id ?? "";
  if (typeof callerSessionId !== "string" || callerSessionId === "") return;
  if (callerSessionId === memberSessionId) return;
  const current = await readTaskMetadata(taskPath).catch(() => void 0);
  if (!await recordTaskSession(taskPath, current, callerSessionId, "leader")) {
    warnings.push(`the dispatching session (${callerSessionId}) could not be written into the task's record at ${taskPath} as its leader, so a report from the member cannot name who it answers to; the session it dispatched is still recorded, and its id is in this answer`);
  }
}
function watchDispatchedSession(watcher, sessionId, request, exec) {
  if (sessionId === "") return;
  if (watcher === void 0 || watcher === null || typeof watcher.watch !== "function") return;
  const senderSessionId = exec?.agent?.session?.id ?? exec?.agent?.id ?? "";
  try {
    watcher.watch(
      sessionId,
      request.task,
      typeof senderSessionId === "string" ? senderSessionId : "",
      request.taskPath,
      request.sourceRoot
    );
  } catch {
  }
}
function refuseUngrantedFullAccess(requested, granted) {
  if (requested !== "danger-full-access" || granted === "on") return;
  throw coded(
    "E4012",
    "Full access for the sessions handed to an agent is switched off, so this call cannot open a session with `danger-full-access`. Turn the setting on first, or open the session at `workspace-write` (or leave the permission at `inherit`, which copies this session's own override and nothing more)."
  );
}
function refuseIrreversible(args) {
  if (args.strays === "discard") {
    throw coded(
      "E7007",
      `strays "discard" cannot be done from a tool call: it deletes the files in the task space that git never tracked, and nothing brings them back - there is no reflog behind them and no branch to recover them from. Deleting the user's own writing is theirs to decide, so ask them to do it from the Worktree Space panel, where the box says what it costs. Use "archive" to file the content away instead, or "keep" to leave the space exactly as it stands.`
    );
  }
  if (args.force !== true) return;
  throw coded(
    "E7007",
    "force cannot be done from a tool call: discarding uncommitted work, and force-deleting a branch whose commits landed nowhere, are irreversible and have to be the user's own decision. Abandoning a task (deleteBranch without merge) needs force too, so it is not available here either. Ask them to open the Worktree Space management page and finish this task space there. Merging, and removing a branch once it has landed, are both still available here."
  );
}
function sessionsWorkingIn2(ctx, taskPath) {
  if (typeof ctx?.get !== "function") return [];
  let agents;
  try {
    agents = ctx.get("agents");
  } catch {
    return [];
  }
  if (agents === void 0 || agents === null || typeof agents.list !== "function") return [];
  let listed;
  try {
    listed = agents.list();
  } catch {
    return [];
  }
  const found = [];
  for (const agent of Array.isArray(listed) ? listed : []) {
    const cwd = agent?.session?.header?.cwd;
    if (typeof cwd !== "string" || cwd === "") continue;
    if (canonicalPath(cwd) !== canonicalPath(taskPath) && !isInside(taskPath, cwd)) continue;
    const running = agent.status === "running";
    const openTurn = turnIsOpen2(agent.session);
    const inbox = agent.inbox;
    const queued = inbox?.hasPending === true || (inbox?.nextTurn?.length ?? 0) + (inbox?.nextStep?.length ?? 0) > 0;
    if (!running && !openTurn && !queued) continue;
    found.push({ sessionId: String(agent.id), running, openTurn, queued });
  }
  return found;
}
function turnIsOpen2(session) {
  if (session === void 0 || session === null || typeof session.snapshotEvents !== "function") return false;
  let events;
  try {
    events = session.snapshotEvents();
  } catch {
    return false;
  }
  let open4 = false;
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type === "turn/start") open4 = true;
    if (event?.type === "turn/end") open4 = false;
  }
  return open4;
}
function refuseWhileSessionsWork2(ctx, taskPath, callerSessionId = "") {
  const caller = typeof callerSessionId === "string" ? callerSessionId : "";
  const working = sessionsWorkingIn2(ctx, taskPath).filter((entry) => caller === "" || entry.sessionId !== caller);
  if (working.length === 0) return;
  const described = working.map((entry) => {
    const why = [
      entry.running ? "running" : "",
      entry.openTurn ? "mid-turn" : "",
      entry.queued ? "with work queued" : ""
    ].filter(Boolean).join(", ");
    return `${entry.sessionId}${why === "" ? "" : ` (${why})`}`;
  }).join("; ");
  throw coded(
    "E5012",
    `a session is still working in this task space: ${described}. Finishing removes the worktrees and the task space, so a session that is mid-turn would lose the directory it is writing into and the work it has not committed. Stop those sessions first - \`wts_session_tool cancel\` stops one, and \`wts_session_tool status\` says what each is doing - then call done again. If the work is not meant to stop, leave the task space standing: it is still there, and nothing has been removed.`,
    // Structured as well as spoken, so the panel can say it in the reader's language the way it
    // already does for E5011. The English above is the model's and the log's copy.
    { sessions: working }
  );
}
function summarize(action, value) {
  if (action === "suggest-root") {
    const names = value.repositories.map((row) => row.name).join(", ");
    return `Recommended task space for ${value.tasksRoot === "" ? "the source root" : value.tasksRoot}: ${value.suggested}. ${value.repositories.length} source repositor${value.repositories.length === 1 ? "y" : "ies"}${names === "" ? "" : `: ${names}`}.`;
  }
  if (action === "create") {
    const names = value.repositories.map((row) => row.name).join(", ");
    const working = value.sessionId === "" ? "" : ` Session '${value.sessionId}' is on the work; open it from the Worktree Space panel, or from the workspace list.`;
    return `Task '${value.task}' is ready at ${value.container} on branch '${value.branch}', with worktrees of: ${names}.${working}${value.warnings.length === 0 ? "" : ` Warnings: ${value.warnings.join("; ")}.`}`;
  }
  if (action === "add") {
    const names = value.repositories.map((row) => row.name).join(", ");
    return `Added to task '${value.task}' at ${value.container} on branch '${value.branch}': ${names}.${value.warnings.length === 0 ? "" : ` Warnings: ${value.warnings.join("; ")}.`}`;
  }
  if (action === "list") {
    if (value.repositories.length === 0 && value.container === "") return `No task space at ${value.tasksRoot}.`;
    const perTask = value.repositories.filter((row) => row.name !== "").length;
    const sessions = value.sessions.length === 0 ? "" : ` Sessions: ${value.sessions.map((entry) => entry.sessionId).join(", ")}.`;
    const deployed = value.deployment.filter((entry) => entry.url !== "");
    const acceptance = deployed.length === 0 ? "" : ` Acceptance: ${deployed.map((entry) => `${entry.task} -> ${entry.url}${entry.smoke === "" ? "" : ` (smoke ${entry.smoke})`}`).join("; ")}.`;
    return `${value.repositories.length} task${value.repositories.length === 1 ? "" : "s"} under ${value.tasksRoot} (${perTask} worktree${perTask === 1 ? "" : "s"}).${sessions}${acceptance}`;
  }
  if (action === "dispatch") {
    const opened = value.sessionId === "" ? `No session was opened in task '${value.task}' at ${value.container}.` : `Session '${value.sessionId}' is on the work in task '${value.task}' at ${value.container}; open it from the Worktree Space panel, or from the workspace list.`;
    return `${opened}${value.warnings.length === 0 ? "" : ` Warnings: ${value.warnings.join("; ")}.`}`;
  }
  const failed = value.failed ? " Some repositories need attention:" : "";
  const conflicted = value.repositories.filter((row) => row.conflict === true);
  const uncommitted = value.repositories.filter((row) => row.needsCommit === true);
  const blocked = value.repositories.filter((row) => row.dirtyCheckout === true);
  const settled = /* @__PURE__ */ new Set([...conflicted, ...uncommitted, ...blocked]);
  const attention = value.repositories.filter((row) => row.error !== "" && !settled.has(row)).map((row) => `${row.name}: ${row.error}`).join("; ");
  const handedOn = value.repositories.filter((row) => row.mergeInProgress);
  const stranded = value.repositories.filter((row) => row.error !== "" && row.merged !== true && row.removed !== true);
  const headline = handedOn.length > 0 ? `Task '${value.task}' is unfinished: a merge is waiting to be resolved in ${handedOn.map((row) => row.mergeSite).join(", ")}.` : stranded.length > 0 ? `Task '${value.task}' is unfinished: ${stranded.length === 1 ? "one repository" : `${stranded.length} repositories`} could not be finished and ${stranded.length === 1 ? "is" : "are"} still on disk at ${stranded.map((row) => row.path).join(", ")}.` : `Task '${value.task}' finished. Task space ${value.container === "" ? "removed" : `kept at ${value.container}`}.`;
  const who = value.sessionId === "" ? " No session is recorded for this task space, so open one (wts_session_tool create, cwd at the task space or the checkout) and hand it the job." : ` Hand it to session '${value.sessionId}' (wts_session_tool send, mode "steer"), or do it yourself in the checkout.`;
  const handoff = handedOn.length === 0 ? "" : ` Resolve ${handedOn.map((row) => row.conflictedFiles.join(", ")).filter((list) => list !== "").join("; ") || "the conflict"}, commit the merge there, then call done again.${who}`;
  const commit = uncommitted.length === 0 ? "" : ` Uncommitted work is waiting in ${uncommitted.map((row) => row.path).join(", ")}: have it committed on ${uncommitted.length === 1 ? "that repository's branch" : "each repository's own branch"}, then call done again.${who}`;
  const dirty = blocked.length === 0 ? "" : ` The checkout the user works in (${blocked.map((row) => row.mainRepo || row.path).join(", ")}) has uncommitted work this merge would overwrite. That work is theirs to commit or stash - do not commit it for them - then call done again.`;
  return `${headline}${failed}${attention}${handoff}${commit}${dirty}${value.warnings.length === 0 ? "" : ` Warnings: ${value.warnings.join("; ")}.`}`;
}
function nextSteps(value) {
  const implement = "Do the work in a session of the task space, not in this conversation: ";
  if (value.action === "suggest-root") {
    return [
      'Next: one `create` with a `prompt` builds the space **and** puts a session on the first job in a single call - the panel\'s "Create and open", already working. ' + implement + "`create` alone, then implementing the task in this conversation, is the flow this tool exists to replace."
    ];
  }
  if (value.action === "create" && value.sessionId === "") {
    return [
      '**No session is on this task space yet, and the work belongs to one.** Hand the first job over with `wts_worktree_space({ action: "dispatch", task: "' + value.task + '", tasksRoot: "' + (value.tasksRoot || value.container) + '", prompt: "..." })` \u2014 write the prompt as a brief that stands alone, because the session that reads it shares none of this conversation. Then watch it with `wts_session_tool` (status, send, read); it reports its own progress and a turn that ends badly is pushed to you, so there is nothing to wait on.',
      "Implement the task in this conversation only if the user explicitly asked for that. Creating the space without a prompt is not that instruction, and neither is the task looking small from here: the space was made so the work would run in its own checkout on its own branch, and doing it here leaves that branch empty."
    ];
  }
  if (value.action === "add" && value.sessionId === "") {
    return [
      "Next: " + implement + "`dispatch` a job if this repository needs one. Commits are made inside each repository subdirectory, never in the task space root."
    ];
  }
  if (value.action === "list" && value.sessions.length === 0 && value.repositories.length > 0) {
    return [
      'None of these has a session on it yet. Put one on the task that needs work with `wts_worktree_space({ action: "dispatch", ... })` rather than implementing it here.'
    ];
  }
  return [];
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
  const configuredFullAccess = () => typeof options.configuredFullAccess === "function" ? options.configuredFullAccess() : "off";
  const configuredArchive = () => typeof options.configuredArchive === "function" ? options.configuredArchive() : void 0;
  const sessionWatch = options.sessionWatch;
  return tools.register(defineTool({
    name: "wts_worktree_space",
    description: DESCRIPTION,
    parameters: {
      action: { type: "string", required: true, enum: ["suggest-root", "create", "add", "list", "dispatch", "done"], description: "suggest-root, create, add, list, dispatch, or done." },
      task: { type: "string", description: "Name (create, add, done): the task space directory and branch suffix, with no separators or spaces." },
      project: { type: "string", description: "Project layer (add, list, done): the source root's own directory name. Omit when sourceRoot is given, since it is derived from it." },
      sourceRoot: { type: "string", description: "Directory holding the repositories. Required for suggest-root and create." },
      tasksRoot: { type: "string", description: "Container for task spaces: beside the repositories' directory, never inside it or a parent of it. Omit for the recommendation." },
      repos: { type: "array", items: { type: "string" }, description: "Repository paths as suggest-root reports them (create, add). Omit for every discovered. A bare name is read as relative to sourceRoot, so it only names a repository sitting directly in it." },
      baseRef: { type: "string", description: "Start point (create, add). Omit for each repository HEAD." },
      branchPrefix: { type: "string", description: "Branch prefix (create, suggest-root): the branch is this plus the task name. Omit for task/." },
      deployTarget: { type: "string", enum: ["docker", "none"], description: 'Deployed for acceptance (create). Ask the user before anything is created or dispatched: it is settled on the create and cannot be added or changed afterwards. "none" is the default and has no gate; "docker" needs something to deploy with, or the create is refused (E4015).' },
      deployScript: { type: "string", description: "Deploy entry (create): a path relative to the workspace, under its .worktree-space/deploy/ directory; anything outside is refused (E4014). Omitted it is .worktree-space/deploy/deploy.sh. Only with deployTarget docker." },
      registerWorkspace: { type: "boolean", description: "Register what this create made as a DSH Workspace (create, default true)." },
      merge: { type: "boolean", description: "REQUIRED for done: true lands the branches, false leaves them. There is no default (E7006)." },
      prompt: { type: "string", description: "The work itself (create, dispatch): what to do, where, and what counts as done. It must stand alone - the session shares no context with this conversation. Leave out reporting requirements, source-checkout rules and deploy-acceptance steps: those are supplied for every dispatched task, and repeating them only makes the brief harder to read." },
      permission: { type: "string", enum: ["inherit", "workspace-write", "danger-full-access"], description: "What the session opened here may write (create, dispatch). Default inherit; danger-full-access is refused (E4012) unless the user granted it." },
      watchSession: { type: "boolean", description: "Report back when this session's turn ends abnormally (create, dispatch). True by default." },
      target: { type: "string", description: "Branch to merge into (done). Omit for each source repository's checked-out branch." },
      deleteBranch: { type: "boolean", description: "Delete each branch after a merge (done). Needs merge: true." },
      strays: { type: "string", enum: ["archive", "keep", "discard"], description: 'Untracked files (done): "archive" (default), "keep", or "discard" (REFUSED here, E7007).' },
      keepEntries: { type: "array", items: { type: "string" }, description: "Task space entries to leave alone whatever strays says (done)." },
      force: { type: "boolean", description: "Discard uncommitted changes (done). Refused here, always - the user's own decision." },
      unregisterWorkspace: { type: "boolean", description: "Unregister the Workspace a finish removed (done, default true)." }
    },
    output: {
      schema: OUTPUT_SCHEMA,
      // The summary first, then the steering - as its own block, so it reads as an
      // instruction about what to do next rather than as part of the answer. It is
      // appended rather than folded into the summary because the summary is also
      // the card's text: keeping them apart is what leaves the interface alone
      // while the model gets the guidance.
      render: (_args, value) => {
        const steps = nextSteps(value);
        return steps.length === 0 ? [{ type: "text", text: value.summary }] : [{ type: "text", text: value.summary }, { type: "text", text: steps.join("\n\n") }];
      },
      // The card's own projection, bounded here as well as at the card: a
      // hundred-repository task must neither bloat the session log nor a card.
      // `total` stays in place, so a capped list can never be read as the whole
      // answer. Deliberately carries no `nextSteps`: that guidance is addressed to
      // the model, and a card is read by a person who already knows what to press.
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
    async execute(args, exec) {
      const action = args.action;
      if (action === "suggest-root") {
        const sourceRoot = absolutePath(required(args.sourceRoot, "sourceRoot"));
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
        const sourceRoot = absolutePath(required(args.sourceRoot, "sourceRoot"));
        if (typeof args.prompt === "string" && args.prompt.trim() !== "") {
          const requested = typeof args.permission === "string" && args.permission.trim() !== "" ? args.permission.trim() : "inherit";
          refuseUngrantedFullAccess(requested, configuredFullAccess());
        }
        const deployTarget = typeof args.deployTarget === "string" && args.deployTarget.trim() !== "" ? args.deployTarget.trim() : void 0;
        const result = await createTask(ctx.subprocess, {
          sourceRoot,
          task: required(args.task, "task"),
          tasksRoot: args.tasksRoot,
          repos: Array.isArray(args.repos) ? args.repos : void 0,
          baseRef: typeof args.baseRef === "string" ? args.baseRef : void 0,
          branchPrefix: typeof args.branchPrefix === "string" ? args.branchPrefix : void 0,
          deployScript: typeof args.deployScript === "string" ? args.deployScript : void 0,
          configuredRoot: configuredRoot(),
          // Stated by this call, or nothing: create.js resolves it once, before
          // anything is made. An invalid target is refused there, with E4010.
          delivery: deployTarget === void 0 ? void 0 : { deploy: { target: deployTarget } }
        });
        const value = envelope(action);
        value.task = result.task;
        value.project = result.project;
        value.branch = result.branch;
        value.container = result.path;
        value.tasksRoot = result.tasksRoot;
        const leaveToThePanel = args.registerWorkspace === false;
        for (const warning of result.warnings ?? []) value.warnings.push(warning.message);
        const registry = leaveToThePanel ? void 0 : workspaceRegistryOf(ctx);
        const unregistered = leaveToThePanel ? "" : registry === void 0 ? NO_WORKSPACE_REGISTRY : await registerTaskWorkspace(registry, result.path, sourceRoot, result.task);
        if (leaveToThePanel) {
          value.warnings.push(
            `the task space is on disk but not registered as a DSH Workspace, because this call asked for one that stays out of the workspace list. Register it from the Worktree Space panel - "Create and open", or "Register again" after a create is refused - and open the task's session there; until it is registered, creating this task again is refused as E2002`
          );
        } else if (unregistered !== "") {
          value.warnings.push(
            `the task space is on disk but not registered as a DSH Workspace (${unregistered}); register it from the Worktree Space panel - "Create and open", or "Register again" after a create is refused - and open the task's session there; until it is registered, creating this task again is refused as E2002`
          );
        }
        if (typeof args.prompt === "string" && args.prompt.trim() !== "") {
          const requested = typeof args.permission === "string" && args.permission.trim() !== "" ? args.permission.trim() : "inherit";
          const watch = args.watchSession !== false;
          const record = unregistered === "" && registry !== void 0 && typeof registry.resolveByPath === "function" ? await registry.resolveByPath(result.path) : void 0;
          const opened = await dispatchToSession(ctx, exec, {
            taskPath: result.path,
            task: result.task,
            tasksRoot: result.tasksRoot,
            branch: result.branch,
            sourceRoot,
            prompt: args.prompt,
            requested,
            watch,
            ...record === void 0 || record === null || typeof record.id !== "string" || record.id === "" ? {} : { place: { workspaceId: record.id } }
          }, sessionWatch);
          value.sessionId = opened.sessionId;
          if (opened.reason !== "") value.warnings.push(opened.reason);
          if (opened.sessionId !== "") {
            const recorded = await readTaskMetadata(result.path);
            if (!await recordTaskSession(result.path, recorded, opened.sessionId, "task")) {
              value.warnings.push(`the session id (${opened.sessionId}) could not be written into the task's record at ${result.path}; find it again with wts_session_tool find, by the task space directory`);
            }
            await recordDispatchLeader(result.path, opened.sessionId, exec, value.warnings);
          }
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
          // directory to resolve a name against. Each is resolved all the same,
          // because `addTaskRepositories` compares it against the task space.
          repositories: Array.isArray(args.repos) ? args.repos.map(absolutePath) : [],
          baseRef: typeof args.baseRef === "string" && args.baseRef.trim() !== "" ? args.baseRef.trim() : void 0
        });
        const value = envelope(action);
        value.task = result.task;
        value.project = result.project;
        value.branch = result.branch;
        value.container = result.path;
        value.tasksRoot = result.tasksRoot;
        value.repositories = result.repositories.map((entry) => ({ ...emptyRow(entry.name), path: entry.path, branch: result.branch }));
        const recorded = await readTaskMetadata(result.path).catch(() => void 0);
        const sessions = normalizeSessions(recorded?.sessions ?? recorded?.sessionId);
        if (sessions.length > 0) {
          value.sessionId = sessions[sessions.length - 1].sessionId;
          value.sessions = sessions.map((entry) => ({ sessionId: entry.sessionId, role: entry.role, at: entry.at ?? "" }));
        }
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
          for (const entry of [...task.sessions ?? []].reverse()) {
            value.sessions.push({ sessionId: entry.sessionId, role: entry.role, at: entry.at ?? "" });
          }
          const state = task.delivery ?? { url: null, lastSmoke: null };
          value.deployment.push({
            task: label,
            url: state.url ?? "",
            smoke: state.lastSmoke?.result ?? "",
            smokeAt: state.lastSmoke?.at ?? ""
          });
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
        if (typeof args.merge !== "boolean") {
          throw coded(
            "E7006",
            "merge is required for done: pass true to merge the task branches into their targets, or false to leave them where they are. This is the decision that cannot be taken back - a merge that landed has to be reverted by hand, and a branch that was not merged keeps its work where it is. Say which one the user wants; do not leave it to a default."
          );
        }
        const tasksRoot = await containerFor(ctx.subprocess, args.tasksRoot, args.sourceRoot, configuredRoot());
        const project = projectFor(args.project, args.sourceRoot);
        const callerSessionId = exec?.agent?.session?.id ?? exec?.agent?.id ?? "";
        refuseWhileSessionsWork2(ctx, taskSpacePath(tasksRoot, project, task), callerSessionId);
        const beforeFinish = await readTaskMetadata(taskSpacePath(tasksRoot, project, task)).catch(() => void 0);
        const result = await finishTask(ctx.subprocess, {
          task,
          project,
          tasksRoot,
          // The early refusal above is the cheap one. Handing the context on is what lets
          // the finish ask again inside its own lock, where no session can start working
          // between the question and the removal - see `finishTask`.
          ctx,
          callerSessionId,
          merge: args.merge,
          target: typeof args.target === "string" ? args.target : void 0,
          deleteBranch: typeof args.deleteBranch === "boolean" ? args.deleteBranch : void 0,
          force: args.force === true,
          // What happens to the files git never tracked. Absent means archive: the
          // answer that neither loses anything nor leaves the task space standing.
          strays: typeof args.strays === "string" ? args.strays : void 0,
          keepEntries: Array.isArray(args.keepEntries) ? args.keepEntries : [],
          deliveryArchive: configuredArchive()
        });
        const value = envelope(action);
        value.task = task;
        value.project = project;
        value.container = result.containerRemoved ? "" : result.path;
        value.tasksRoot = tasksRoot;
        value.failed = result.failed;
        value.warnings = result.warnings.map((entry) => entry.message);
        if (result.containerRemoved && args.unregisterWorkspace !== false) {
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
          // Whether this row stopped on a merge somebody has to reconcile, as opposed
          // to any other way a repository can fail. The distinction matters to a caller
          // that intends to act on it: a conflict has a place to go and files to fix,
          // while a dirty source checkout (E5004) is the user's own work and is not
          // this flow's to touch. Without the flag a caller has to match git's English
          // to tell them apart, which is exactly the reading this field replaces.
          conflict: entry.conflict === true,
          mergeInProgress: entry.mergeInProgress === true,
          mergeSite: entry.mergeSite ?? "",
          conflictedFiles: Array.isArray(entry.conflictedFiles) ? entry.conflictedFiles : [],
          // The two stops whose way forward is an agent rather than a retry: work in the
          // task space nobody has committed, and work in the user's own checkout that a
          // merge would overwrite. Flags rather than sentences, because a caller acting on
          // them has to tell them from a conflict and from a plain failure.
          needsCommit: entry.needsCommit === true,
          dirtyCheckout: entry.dirtyCheckout === true,
          error: entry.error ?? ""
        }));
        const recordedSessions = normalizeSessions(beforeFinish?.sessions ?? beforeFinish?.sessionId);
        if (recordedSessions.length > 0) {
          value.sessionId = recordedSessions[recordedSessions.length - 1].sessionId;
          value.sessions = recordedSessions.map((entry) => ({ sessionId: entry.sessionId, role: entry.role, at: entry.at ?? "" }));
        }
        value.summary = summarize(action, value);
        return value;
      }
      if (action === "dispatch") {
        const task = required(args.task, "task");
        const tasksRoot = await containerFor(ctx.subprocess, args.tasksRoot, args.sourceRoot, configuredRoot());
        const project = projectFor(args.project, args.sourceRoot);
        const prompt = required(args.prompt, "prompt");
        const taskPath = taskSpacePath(tasksRoot, project, task);
        const metadata = await readTaskMetadata(taskPath);
        if (metadata === void 0) throw coded("E2003", `no task space at ${taskPath}`);
        const requested = typeof args.permission === "string" && args.permission.trim() !== "" ? args.permission.trim() : "inherit";
        refuseUngrantedFullAccess(requested, configuredFullAccess());
        const watch = args.watchSession !== false;
        const value = envelope(action);
        value.task = task;
        value.project = project;
        value.container = taskPath;
        value.tasksRoot = tasksRoot;
        const opened = await dispatchToSession(ctx, exec, {
          taskPath,
          task,
          tasksRoot,
          // The branch the task is already on, read off its own record - a dispatch
          // must name it in the standing section, and the record is where it is.
          branch: typeof metadata.branch === "string" ? metadata.branch : "",
          sourceRoot: typeof args.sourceRoot === "string" ? args.sourceRoot : "",
          prompt,
          requested,
          watch
        }, sessionWatch);
        value.sessionId = opened.sessionId;
        if (opened.reason !== "") value.warnings.push(opened.reason);
        if (opened.sessionId !== "") {
          if (!await recordTaskSession(taskPath, metadata, opened.sessionId, "task")) {
            value.warnings.push(`the session id (${opened.sessionId}) could not be written into the task's record at ${taskPath}; find it again with wts_session_tool find, by the task space directory`);
          }
          await recordDispatchLeader(taskPath, opened.sessionId, exec, value.warnings);
        }
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
      title: `wts_worktree_space: ${args.action}`,
      kind: "other",
      // The task name is the one input a reader wants while the call runs; the
      // whole args object (paths, flags, an archive directory) is not.
      rawInput: typeof args?.task === "string" && args.task !== "" ? args.task : void 0
    }),
    presentResult: (args, result) => ({
      card: "generic",
      title: `wts_worktree_space: ${args?.action ?? "call"}`,
      content: [{ type: "text", text: cardText(result) }]
    })
  }));
}

// src/host/session-tools.js
import { randomUUID as randomUUID2 } from "node:crypto";
import { existsSync as existsSync10 } from "node:fs";
import { readdir as readdir10 } from "node:fs/promises";
import { dirname as dirname8, join as join17 } from "node:path";
import { defineTool as defineTool2 } from "@deepseek-ai/dsh-tools";

// src/host/session-turn.js
function withSessionTurn(sessionId, body) {
  return withTaskLock(`session:${String(sessionId ?? "")}`, body);
}

// src/host/session-tools.js
var DEFAULT_READ_LIMIT = 20;
var MAX_READ_LIMIT = 100;
var DEFAULT_FIND_LIMIT = 10;
var MAX_FIND_LIMIT = 50;
var DEFAULT_RECENT = 8;
var MAX_RECENT = 20;
var REASONING_TAIL_LIMIT = 4e3;
var OFFLINE_TITLE_BUDGET = 30;
var CARD_ROW_LIMIT2 = 8;
function service(ctx, name2) {
  if (ctx === null || ctx === void 0 || typeof ctx.get !== "function") return void 0;
  let value;
  try {
    value = ctx.get(name2);
  } catch {
    return void 0;
  }
  return value === null ? void 0 : value;
}
function agentsOf(ctx) {
  const agents = service(ctx, "agents");
  return agents !== void 0 && typeof agents.get === "function" ? agents : void 0;
}
var NO_AGENTS = "this deployment does not offer the session registry (the `agents` service), so no live session can be inspected, messaged or stopped";
var NO_SESSION_LISTING = "this deployment does not offer the session registry or session persistence, so no session can be located";
var NO_RESUME = "this deployment does not offer the live-agent registry (the `agents` service) or session persistence, so a session cannot be brought back online";
var NO_CREATE = "this deployment does not offer the session service (`sessionController`) or the live-agent registry (`agents`), so no session can be opened";
function refusal(reason) {
  return { offered: false, sessionId: "", summary: reason, reason };
}
function unavailable(sessionId, reason) {
  return { offered: true, sessionId, summary: reason, reason };
}
async function sessionInScope(ctx, sessionId, agent, exec, options = {}) {
  const reach = await reachOf(ctx, sessionId, agent, exec);
  if (options.destructive === true) return reach.inTaskSpace || reach.inRecordAsMember;
  return reach.inTaskSpace || reach.inRecordAsMember || reach.inRecordAsLeader || reach.inSourceCheckout;
}
async function reachOf(ctx, sessionId, agent, exec) {
  const none = { inTaskSpace: false, inRecordAsMember: false, inRecordAsLeader: false, inSourceCheckout: false };
  const liveCwd = typeof agent?.session?.header?.cwd === "string" ? agent.session.header.cwd : "";
  const targetCwd = liveCwd !== "" ? liveCwd : await persistedDirectory(ctx, sessionId);
  const inTaskSpace = targetCwd !== "" && await taskSpaceAbove(targetCwd) !== void 0;
  const callerSpace = await taskSpaceAbove(exec?.agent?.session?.header?.cwd);
  if (callerSpace === void 0) return { ...none, inTaskSpace };
  const named = taskSessionsOf(callerSpace.metadata).filter((entry) => entry.sessionId === sessionId);
  return {
    inTaskSpace,
    // The role is what separates the two directions. A record written before the role
    // existed answers `task` for every entry (see `TASK_SESSION_ROLES`), so an older
    // record keeps the older behaviour: the member it names is cancellable.
    inRecordAsMember: named.some((entry) => entry.role === "task" || entry.role === "handoff"),
    inRecordAsLeader: named.some((entry) => entry.role === "leader"),
    inSourceCheckout: isSourceCheckoutOf(callerSpace.metadata, targetCwd)
  };
}
var TASK_SPACE_WALK_LIMIT = 8;
async function taskSpaceAbove(directory) {
  if (typeof directory !== "string" || directory === "") return void 0;
  let current = directory;
  for (let level = 0; level < TASK_SPACE_WALK_LIMIT; level += 1) {
    const metadata = await safelyAsync(() => readTaskMetadata(current));
    if (metadata !== void 0 && metadata !== null && typeof metadata === "object") {
      return { path: current, metadata };
    }
    const parent = dirname8(current);
    if (parent === current) break;
    current = parent;
  }
  return void 0;
}
async function markReportedBy(senderSessionId, cwd) {
  try {
    if (typeof senderSessionId !== "string" || senderSessionId === "") return false;
    const space = await taskSpaceAbove(cwd);
    if (space === void 0) return false;
    return await markSessionReported(space.path, senderSessionId);
  } catch {
    return false;
  }
}
function isSourceCheckoutOf(metadata, directory) {
  if (typeof directory !== "string" || directory === "") return false;
  const repositories = Array.isArray(metadata?.repositories) ? metadata.repositories : [];
  for (const entry of repositories) {
    const source = typeof entry?.sourcePath === "string" ? entry.sourcePath.trim() : "";
    if (source === "") continue;
    if (canonicalPath(source) === canonicalPath(directory)) return true;
    if (isInside(source, directory)) return true;
  }
  return false;
}
async function persistedDirectory(ctx, sessionId) {
  const persistence = service(ctx, "sessionPersistence");
  if (persistence === void 0) return "";
  if (typeof persistence.inspect === "function") {
    const inspected = await safelyAsync(() => persistence.inspect(sessionId));
    const cwd = inspected?.meta?.cwd;
    if (typeof cwd === "string" && cwd !== "") return cwd;
  }
  if (typeof persistence.list === "function") {
    const rows = await safelyAsync(() => persistence.list());
    for (const row of Array.isArray(rows) ? rows : []) {
      const header = row?.header ?? row;
      if (header?.id === sessionId && typeof header.cwd === "string" && header.cwd !== "") return header.cwd;
    }
  }
  return "";
}
function outOfScopeReason(sessionId) {
  return `session ${JSON.stringify(sessionId)} is not one this plugin is responsible for: these tools reach the sessions a task space this plugin made runs in, the ones a caller's own task record names, and the sessions working in that task's source checkouts. A session elsewhere - one the user opened by hand - is out of reach on purpose: cancelling it would abort the conversation they are having, and reading it would hand over messages nobody asked this plugin to hold. Use wts_session_tool find with a cwd inside a task space to list the ones that are in scope.`;
}
function safely(read) {
  try {
    return read();
  } catch {
    return void 0;
  }
}
function toLosslessJson(value, seen = /* @__PURE__ */ new Set()) {
  if (value === null) return null;
  const type = typeof value;
  if (type === "string" || type === "boolean") return value;
  if (type === "number") return Number.isFinite(value) ? value : null;
  if (type === "bigint") return value.toString();
  if (type === "undefined" || type === "function" || type === "symbol") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (Array.isArray(value)) {
    if (seen.has(value)) return null;
    seen.add(value);
    const out = value.map((item) => {
      const kind = typeof item;
      if (item === void 0 || kind === "function" || kind === "symbol") return null;
      return toLosslessJson(item, seen);
    });
    seen.delete(value);
    return out;
  }
  if (type === "object") {
    if (seen.has(value)) return null;
    seen.add(value);
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === void 0) continue;
      const kind = typeof item;
      if (kind === "function" || kind === "symbol") continue;
      out[key] = toLosslessJson(item, seen);
    }
    seen.delete(value);
    return out;
  }
  return null;
}
function asJson(value) {
  return toLosslessJson(value);
}
function sessionEvents(session) {
  if (session === null || session === void 0) return [];
  if (Array.isArray(session.events)) return session.events;
  if (typeof session.snapshotEvents === "function") {
    const events = safely(() => session.snapshotEvents());
    return Array.isArray(events) ? events : [];
  }
  return [];
}
function blockText(content) {
  if (!Array.isArray(content)) return void 0;
  const parts = [];
  for (const raw of content) {
    if (raw !== null && typeof raw === "object" && raw.type === "text" && typeof raw.text === "string" && raw.text !== "") {
      parts.push(raw.text);
    }
  }
  return parts.length === 0 ? void 0 : parts.join("\n");
}
function blockTextByType(content, wanted) {
  if (!Array.isArray(content)) return void 0;
  const parts = [];
  for (const raw of content) {
    if (raw !== null && typeof raw === "object" && raw.type === wanted && typeof raw.text === "string" && raw.text !== "") {
      parts.push(raw.text);
    }
  }
  return parts.length === 0 ? void 0 : parts.join("\n");
}
function countImages(content) {
  if (!Array.isArray(content)) return 0;
  return content.filter((raw) => raw !== null && typeof raw === "object" && raw.type === "image").length;
}
function toolNamesOf(toolCalls) {
  if (!Array.isArray(toolCalls)) return [];
  const names = [];
  for (const raw of toolCalls) {
    if (raw !== null && typeof raw === "object" && typeof raw.name === "string" && !names.includes(raw.name)) names.push(raw.name);
  }
  return names;
}
function foldMessages(events) {
  const rows = [];
  for (const event of Array.isArray(events) ? events : []) {
    if (event.type === "user/message") {
      const source = event.data?.source;
      if (source !== void 0 && !CONVERSATIONAL_SOURCES.has(source.kind)) continue;
      const text = blockText(event.data?.content);
      if (text === void 0) continue;
      rows.push({ seq: event.seq, time: event.time, role: "user", text, images: countImages(event.data?.content) });
    } else if (event.type === "assistant/message") {
      const message = event.data?.message ?? null;
      const text = message === null ? void 0 : blockText(message.content);
      const reasoning = message === null ? void 0 : blockTextByType(message.content, "reasoning") ?? blockText(message.reasoning);
      const toolCalls = message === null ? [] : toolNamesOf(message.toolCalls);
      if (text === void 0 && reasoning === void 0 && toolCalls.length === 0) continue;
      const row = { seq: event.seq, time: event.time, role: "assistant", images: message === null ? 0 : countImages(message.content) };
      if (text !== void 0) row.text = text;
      if (reasoning !== void 0) row.reasoning = reasoning;
      if (toolCalls.length > 0) row.toolCalls = toolCalls;
      rows.push(row);
    }
  }
  return rows;
}
function titleOf(events) {
  let title;
  for (const event of Array.isArray(events) ? events : []) {
    if (event.type === "session/title" && typeof event.data?.title === "string" && event.data.title !== "") {
      title = event.data.title;
    }
  }
  if (title !== void 0) return title;
  for (const event of Array.isArray(events) ? events : []) {
    if (event.type !== "user/message") continue;
    const source = event.data?.source;
    if (source !== void 0 && !CONVERSATIONAL_SOURCES.has(source.kind)) continue;
    const text = blockText(event.data?.content);
    if (text === void 0) continue;
    const trimmed = text.replace(/\s+/g, " ").trim();
    return trimmed.length > 80 ? `${trimmed.slice(0, 80)}\u2026` : trimmed;
  }
  return void 0;
}
function maxSeq(events) {
  let largest = -1;
  for (const event of Array.isArray(events) ? events : []) {
    if (typeof event.seq === "number" && event.seq > largest) largest = event.seq;
  }
  return largest;
}
function liveReasoningSnapshot(events) {
  let lastFinalizedSeq = -1;
  let reasoning = "";
  let text = "";
  let found = false;
  for (const event of Array.isArray(events) ? events : []) {
    const type = event.type;
    if (type === "assistant/message" || type === "assistant/attempt") {
      const data = event.data ?? {};
      if (Array.isArray(data.stream)) {
        let streamedReasoning = "";
        let streamedText = "";
        for (const raw of data.stream) {
          if (raw === null || typeof raw !== "object") continue;
          if (raw.type === "reasoning-chunks" && Array.isArray(raw.texts)) {
            for (const piece of raw.texts) if (typeof piece === "string") streamedReasoning += piece;
          } else if (raw.type === "text-chunks" && Array.isArray(raw.texts)) {
            for (const piece of raw.texts) if (typeof piece === "string") streamedText += piece;
          } else if (raw.type === "chunk" && raw.chunk !== null && typeof raw.chunk === "object") {
            if (raw.chunk.type === "reasoning-delta" && typeof raw.chunk.text === "string") streamedReasoning += raw.chunk.text;
            else if (raw.chunk.type === "text-delta" && typeof raw.chunk.text === "string") streamedText += raw.chunk.text;
          }
        }
        if (streamedReasoning !== "" || streamedText !== "") {
          reasoning = streamedReasoning;
          text = streamedText;
          found = true;
        }
      }
      if (type === "assistant/message") lastFinalizedSeq = event.seq;
      continue;
    }
    if (type !== "assistant/chunk" || event.seq <= lastFinalizedSeq) continue;
    const chunk = event.data?.chunk;
    if (chunk === null || typeof chunk !== "object") continue;
    if (chunk.type === "reasoning-delta" && typeof chunk.text === "string") {
      reasoning += chunk.text;
      found = true;
    } else if (chunk.type === "text-delta" && typeof chunk.text === "string") {
      text += chunk.text;
      found = true;
    }
  }
  return found ? { reasoning, text } : null;
}
function reasoningTailOf(liveReasoning, lastReasoning) {
  const source = liveReasoning ?? lastReasoning;
  if (source === void 0 || source === "") return void 0;
  return source.length <= REASONING_TAIL_LIMIT ? source : `${source.slice(0, REASONING_TAIL_LIMIT)}\u2026`;
}
function lastTurnEndOf(events) {
  const retriesByTurn = /* @__PURE__ */ new Map();
  let last;
  for (const event of Array.isArray(events) ? events : []) {
    const type = event.type;
    if (type === "llm/retry") {
      const turn2 = event.data?.turn;
      if (typeof turn2 === "number") retriesByTurn.set(turn2, (retriesByTurn.get(turn2) ?? 0) + 1);
      continue;
    }
    if (type !== "turn/end") continue;
    const data = event.data ?? {};
    const turn = typeof data.turn === "number" ? data.turn : 0;
    const reason = data.reason ?? {};
    const kind = typeof reason.kind === "string" ? reason.kind : "unknown";
    const entry = { turn, seq: event.seq, time: event.time, kind, retriesScheduled: retriesByTurn.get(turn) ?? 0 };
    if (kind === "error" && reason.error !== null && typeof reason.error === "object" && typeof reason.error.code === "string") {
      entry.failure = {
        message: typeof reason.error.message === "string" ? reason.error.message : "",
        code: reason.error.code,
        ...typeof reason.error.status === "number" ? { status: reason.error.status } : {}
      };
    }
    if (kind === "aborted" && typeof reason.reason?.kind === "string") entry.cancelCause = reason.reason.kind;
    last = entry;
  }
  return last;
}
function statusSnapshot(ctx, agent, liveActivityAt) {
  const events = sessionEvents(agent.session);
  const rows = foldMessages(events);
  let lastActivityAt = null;
  let lastTurn = 0;
  let openTurn = false;
  let stepStartAt = null;
  let lastStepDurationMs = null;
  for (const event of events) {
    if (event.type === "turn/start" || event.type === "turn/end") {
      const turn = event.data?.turn;
      if (typeof turn === "number" && turn > 0) lastTurn = turn;
    }
    if (event.type === "turn/start") openTurn = true;
    if (event.type === "turn/end") openTurn = false;
    const closesStep = event.type === "assistant/message" || event.type === "assistant/attempt" || String(event.type).startsWith("tool/");
    if (closesStep && stepStartAt !== null) {
      lastStepDurationMs = Math.max(0, event.time - stepStartAt);
      stepStartAt = null;
    }
    if (event.type === "turn/start" || event.type === "user/message" || closesStep) stepStartAt = event.time;
    if (typeof event.time === "number" && event.time > (lastActivityAt ?? 0)) lastActivityAt = event.time;
  }
  let lastReply;
  let lastReasoning;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row.role !== "assistant") continue;
    if (lastReply === void 0 && row.text !== void 0) lastReply = row.text;
    if (lastReasoning === void 0 && row.reasoning !== void 0) lastReasoning = row.reasoning;
    if (lastReply !== void 0 && lastReasoning !== void 0) break;
  }
  const live = liveReasoningSnapshot(events);
  const liveReasoning = live !== null && live.reasoning !== "" ? live.reasoning : void 0;
  const liveText = live !== null && live.text !== "" ? live.text : void 0;
  const reasoningTail = reasoningTailOf(liveReasoning, lastReasoning);
  const lastTurnEnd = lastTurnEndOf(events);
  const inbox = agent.inbox;
  const cwd = agent.session?.header?.cwd;
  const rawIdle = lastActivityAt === null ? null : Date.now() - lastActivityAt;
  const stalledMs = rawIdle === null || liveActivityAt === void 0 || liveActivityAt <= 0 ? rawIdle : Math.min(rawIdle, Math.max(0, Date.now() - liveActivityAt));
  return {
    sessionId: agent.id,
    live: true,
    status: agent.status,
    running: agent.status === "running",
    ...titleOf(events) === void 0 ? {} : { title: titleOf(events) },
    ...cwd === void 0 ? {} : { cwd },
    ...workspaceByPath(ctx, cwd) === void 0 ? {} : { workspaceId: workspaceByPath(ctx, cwd) },
    openTurn,
    lastTurn,
    lastActivityAt,
    ...rawIdle === null ? {} : { rawStalledMs: rawIdle },
    stalledMs,
    ...lastStepDurationMs === null ? {} : { lastStepDurationMs },
    // Two inbox shapes: a `hasPending` getter (older dsh) and the two pending
    // arrays (current). Reading only one of them reports "nothing queued" on the
    // other, which is exactly the fact a caller is here to learn.
    pendingWork: inbox?.hasPending === true || (inbox?.nextTurn?.length ?? 0) + (inbox?.nextStep?.length ?? 0) > 0,
    nextTurnCount: inbox?.nextTurn?.length ?? 0,
    nextStepCount: inbox?.nextStep?.length ?? 0,
    ...lastReply === void 0 ? {} : { lastReply },
    ...lastReasoning === void 0 ? {} : { lastReasoning },
    ...liveReasoning === void 0 ? {} : { liveReasoning },
    ...liveText === void 0 ? {} : { liveText },
    ...reasoningTail === void 0 ? {} : { reasoningTail },
    messageCount: rows.length,
    // The rows a caller may ask for, which is `MAX_RECENT` and not `DEFAULT_RECENT`. This
    // used to slice to the default, and `status` then sliced again to whatever was asked
    // for - so `recent: 20` returned eight rows, the documented maximum was unreachable,
    // and the tool's own description promised a number it could not deliver.
    //
    // Cutting here is right and the caller's slice is not redundant: the ceiling belongs
    // beside the fold it bounds, and the caller still asks for fewer. What cannot work is
    // a ceiling here lower than the one the schema advertises, which is what this was.
    recent: rows.slice(-MAX_RECENT),
    ...lastTurnEnd === void 0 ? {} : { lastTurnEnd }
  };
}
async function offlineSnapshot(ctx, sessionId) {
  const events = await persistedEvents(ctx, sessionId);
  if (events === void 0) return void 0;
  const rows = foldMessages(events);
  let openTurn = false;
  let lastActivityAt = null;
  for (const event of events) {
    if (event.type === "turn/start") openTurn = true;
    if (event.type === "turn/end") openTurn = false;
    if (typeof event.time === "number" && event.time > (lastActivityAt ?? 0)) lastActivityAt = event.time;
  }
  let lastReply;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index].role === "assistant" && rows[index].text !== void 0) {
      lastReply = rows[index].text;
      break;
    }
  }
  const reasoningTail = reasoningTailOf(void 0, rows.filter((row) => row.reasoning !== void 0).pop()?.reasoning);
  return {
    live: false,
    openTurn,
    lastActivityAt,
    ...lastActivityAt === null ? {} : { lastActivityAgoMs: Date.now() - lastActivityAt },
    ...lastReply === void 0 ? {} : { lastReply },
    ...reasoningTail === void 0 ? {} : { reasoningTail },
    messageCount: rows.length,
    // Same ceiling as the live snapshot above, for the same reason: an offline session
    // asked for more rows must be answerable, and the caller is the one that decides how
    // many of the available rows it actually wanted.
    recent: rows.slice(-MAX_RECENT)
  };
}
async function persistedEvents(ctx, sessionId) {
  const persistence = service(ctx, "sessionPersistence");
  if (persistence === void 0) return void 0;
  if (typeof persistence.inspect === "function") {
    const inspected = await safelyAsync(() => persistence.inspect(sessionId));
    return inspected === void 0 ? void 0 : Array.isArray(inspected.events) ? inspected.events : [];
  }
  if (typeof persistence.open !== "function") return void 0;
  const handle = await safelyAsync(() => persistence.open(sessionId, "read"));
  if (handle === void 0 || handle === null) return void 0;
  try {
    const read = await safelyAsync(() => handle.read());
    return read !== void 0 && Array.isArray(read.events) ? read.events : [];
  } finally {
    await safelyAsync(() => handle.close());
  }
}
async function safelyAsync(read) {
  try {
    return await read();
  } catch {
    return void 0;
  }
}
async function knownSessions(ctx) {
  const agents = agentsOf(ctx);
  const persistence = service(ctx, "sessionPersistence");
  if (agents === void 0 && persistence === void 0) return void 0;
  const workspaceIds = workspaceBySession(ctx);
  const items = [];
  const seen = /* @__PURE__ */ new Set();
  if (agents !== void 0 && typeof agents.list === "function") {
    const listed = safely(() => agents.list());
    for (const agent of Array.isArray(listed) ? listed : []) {
      const header = agent?.session?.header;
      const cwd = header?.cwd;
      const workspaceId = workspaceIds.get(agent.id) ?? workspaceByPath(ctx, cwd);
      const title = titleOf(sessionEvents(agent.session));
      seen.add(agent.id);
      items.push({
        sessionId: agent.id,
        live: true,
        running: agent.status === "running",
        ...title === void 0 ? {} : { title },
        ...cwd === void 0 ? {} : { cwd },
        ...workspaceId === void 0 ? {} : { workspaceId },
        ...typeof header?.createdAt === "number" ? { createdAt: header.createdAt } : {},
        ...header?.agentPreset === void 0 ? {} : { agentPreset: header.agentPreset }
      });
    }
  }
  if (persistence !== void 0 && typeof persistence.list === "function") {
    const snapshots = await safelyAsync(() => persistence.list());
    for (const record of Array.isArray(snapshots) ? snapshots : []) {
      const header = record?.header ?? record;
      if (header === null || typeof header !== "object" || typeof header.id !== "string") continue;
      if (seen.has(header.id)) continue;
      seen.add(header.id);
      const workspaceId = workspaceIds.get(header.id);
      items.push({
        sessionId: header.id,
        live: false,
        ...header.cwd === void 0 ? {} : { cwd: header.cwd },
        ...workspaceId === void 0 ? {} : { workspaceId },
        ...typeof header.createdAt === "number" ? { createdAt: header.createdAt } : {},
        ...header.agentPreset === void 0 ? {} : { agentPreset: header.agentPreset }
      });
    }
  }
  return items;
}
function workspaceBySession(ctx) {
  const map = /* @__PURE__ */ new Map();
  const registry = service(ctx, "workspaceRegistry");
  if (registry === void 0 || typeof registry.list !== "function") return map;
  const workspaces = safely(() => registry.list());
  for (const workspace of Array.isArray(workspaces) ? workspaces : []) {
    for (const sessionId of workspace?.sessionIds ?? []) map.set(sessionId, String(workspace.id));
  }
  return map;
}
function workspaceByPath(ctx, cwd) {
  if (typeof cwd !== "string" || cwd === "") return void 0;
  const registry = service(ctx, "workspaceRegistry");
  if (registry === void 0 || typeof registry.list !== "function") return void 0;
  const workspaces = safely(() => registry.list());
  for (const workspace of Array.isArray(workspaces) ? workspaces : []) {
    if (workspace?.path === cwd) return workspace.id;
  }
  return void 0;
}
async function attachToWorkspace(ctx, sessionId, cwd) {
  if (typeof cwd !== "string" || cwd === "") return void 0;
  const registry = service(ctx, "workspaceRegistry");
  if (registry === void 0 || typeof registry.resolveByPath !== "function") return void 0;
  const workspace = await safelyAsync(() => registry.resolveByPath(cwd));
  if (workspace === void 0 || workspace === null || typeof workspace.attachSession !== "function") return void 0;
  const attached = await safelyAsync(() => workspace.attachSession(sessionId));
  return attached === void 0 ? void 0 : String(workspace.id);
}
async function fileSessionUnderWorkspace(ctx, sessionId, cwd) {
  if (typeof sessionId !== "string" || sessionId.trim() === "") {
    return { attached: false, reason: "no-session" };
  }
  if (typeof cwd !== "string" || cwd.trim() === "") return { attached: false, reason: "no-cwd" };
  const registry = service(ctx, "workspaceRegistry");
  if (registry === void 0 || typeof registry.resolveByPath !== "function") {
    return { attached: false, reason: "no-workspace-registry" };
  }
  const workspace = await safelyAsync(() => registry.resolveByPath(cwd));
  if (workspace === void 0 || workspace === null || typeof workspace.attachSession !== "function") {
    return { attached: false, reason: "no-workspace" };
  }
  const attached = await safelyAsync(() => workspace.attachSession(sessionId));
  if (attached === void 0) return { attached: false, reason: "attach-failed" };
  return { attached: true, workspaceId: String(workspace.id) };
}
function sessionIdOf(agent) {
  const id = agent === void 0 || agent === null ? void 0 : agent.id;
  return typeof id === "string" && id !== "" ? id : void 0;
}
var CONVERSATIONAL_SOURCES = /* @__PURE__ */ new Set(["user", "agent-message", "team-message"]);
function userMessage(text, senderSessionId) {
  return {
    id: randomUUID2(),
    role: "user",
    content: [{ type: "text", text }],
    source: sourceFor(senderSessionId)
  };
}
function sourceFor(senderSessionId) {
  return typeof senderSessionId === "string" && senderSessionId !== "" ? { kind: "agent-message", form: "relay", senderSessionId } : { kind: "user" };
}
function framedForModel(text, senderSessionId) {
  return typeof senderSessionId === "string" && senderSessionId !== "" ? `Agent ${senderSessionId} sent a message: ${text}` : text;
}
var REPORT_FIELDS = [
  ["workspace", "Workspace"],
  ["path", "Task space"],
  ["branch", "Branch"],
  ["directory", "Working directory"],
  // The role qualifies the session id that follows it, so the two are read together.
  ["role", "Role"],
  ["sender", "Session"]
];
async function senderRole(cwd, senderSessionId = "") {
  if (typeof cwd !== "string" || cwd === "" || typeof senderSessionId !== "string" || senderSessionId === "") return "unknown";
  const space = await taskSpaceAbove(cwd);
  if (space !== void 0) {
    const named = taskSessionsOf(space.metadata).find((entry) => entry.sessionId === senderSessionId);
    if (named !== void 0) return named.role;
  }
  return await roleUnderSourceRoot(cwd, senderSessionId);
}
async function roleUnderSourceRoot(cwd, senderSessionId) {
  let current = cwd;
  for (let level = 0; level < TASK_SPACE_WALK_LIMIT; level += 1) {
    const tasks = join17(current, PLUGIN_ROOT, SOURCE_TASKS_DIR);
    const projects = await readdir10(tasks, { withFileTypes: true }).catch(() => []);
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const layer = join17(tasks, project.name);
      const files = await readdir10(layer).catch(() => []);
      for (const name2 of files) {
        if (!name2.endsWith(".json")) continue;
        const entry = await readSourceTaskIndex(join17(layer, name2));
        if (entry === void 0) continue;
        if (typeof entry.taskPath !== "string" || entry.taskPath === "") continue;
        if (!existsSync10(entry.taskPath)) continue;
        const named = (Array.isArray(entry.sessions) ? entry.sessions : []).find((session) => session?.sessionId === senderSessionId);
        if (named !== void 0) return typeof named.role === "string" && named.role !== "" ? named.role : "unknown";
      }
    }
    const parent = dirname8(current);
    if (parent === current) break;
    current = parent;
  }
  return "unknown";
}
var REPORT_FIELD_LIMIT = 200;
function reportFieldLine(value) {
  const folded = String(value ?? "").replace(/\s+/g, " ").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
  if (folded === "") return "";
  return folded.length > REPORT_FIELD_LIMIT ? `${folded.slice(0, REPORT_FIELD_LIMIT)}\u2026` : folded;
}
function reportBoundary() {
  return `----- \u62A5\u544A\u6B63\u6587 ${randomUUID2()} -----`;
}
function reportHeader(facts) {
  const lines = [];
  for (const [key, label] of REPORT_FIELDS) {
    const value = reportFieldLine(facts[key]);
    if (value !== "") lines.push(`${label}: ${value}`);
  }
  if (lines.length === 0) return "";
  const task = reportFieldLine(facts.task);
  const heading = task !== "" ? `\u4EFB\u52A1\u3010${task}\u3011\u6267\u884C\u62A5\u544A` : "Agent \u6267\u884C\u62A5\u544A";
  return `${heading}

${lines.join("\n")}

${reportBoundary()}
`;
}
async function reportFacts(ctx, senderSessionId, cwd) {
  const facts = {};
  if (typeof senderSessionId === "string" && senderSessionId !== "") {
    facts.sender = senderSessionId;
    facts.role = await senderRole(cwd, senderSessionId);
  }
  const metadata = typeof cwd === "string" && cwd !== "" ? await safelyAsync(() => readTaskMetadata(cwd)) : void 0;
  const onTask = metadata !== null && metadata !== void 0 && typeof metadata === "object";
  if (typeof cwd === "string" && cwd !== "") {
    if (onTask) facts.path = cwd;
    else facts.directory = cwd;
  }
  if (onTask) {
    if (isUsableTaskName(metadata.task)) facts.task = metadata.task;
    if (isUsableBranchName(metadata.branch)) facts.branch = metadata.branch;
  }
  const title = workspaceTitleByPath(ctx, cwd);
  if (title !== void 0) facts.workspace = title;
  return facts;
}
function workspaceTitleByPath(ctx, path) {
  if (typeof path !== "string" || path === "") return void 0;
  const registry = service(ctx, "workspaceRegistry");
  if (registry === void 0 || typeof registry.list !== "function") return void 0;
  const workspaces = safely(() => registry.list());
  for (const workspace of Array.isArray(workspaces) ? workspaces : []) {
    if (workspace?.path === path) {
      const title = workspace.title;
      if (typeof title === "string" && title.trim() !== "") return title.trim();
    }
  }
  return void 0;
}
function renameSession(ctx, session, title) {
  const titles = service(ctx, "sessionTitle");
  if (titles === void 0 || typeof titles.rename !== "function") return false;
  const applied = safely(() => titles.rename(session, title));
  return applied !== void 0;
}
function clampLimit(value, fallback, max) {
  if (value === void 0) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`invalid limit: expected a positive integer, got ${JSON.stringify(value)}`);
  }
  return Math.min(value, max);
}
function requiredString(value, name2, hint) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "") throw new Error(`${name2} is required${hint === void 0 ? "" : `: ${hint}`}`);
  return text;
}
var OUTPUT_SCHEMA2 = {
  type: "object",
  additionalProperties: true,
  properties: {
    offered: { type: "boolean", required: true },
    sessionId: { type: "string", required: true },
    summary: { type: "string", required: true },
    reason: { type: "string", required: true }
  }
};
function cardMeta(value) {
  const rows = Array.isArray(value.messages) ? value.messages.slice(-CARD_ROW_LIMIT2).map((row) => ({ role: row.role, seq: row.seq, text: typeof row.text === "string" ? row.text.slice(0, 400) : "" })) : Array.isArray(value.items) ? value.items.slice(0, CARD_ROW_LIMIT2).map((item) => ({ sessionId: item.sessionId, title: item.title ?? "", live: item.live === true })) : [];
  return { summary: value.summary, reason: value.reason, rows };
}
function sessionFind(ctx) {
  return {
    render: (_args, value) => {
      if (value.offered !== true || value.reason !== "") return [{ type: "text", text: value.reason }];
      const items = Array.isArray(value.items) ? value.items : [];
      if (items.length === 0) return [{ type: "text", text: "no sessions found" }];
      return [{ type: "text", text: items.map((item) => {
        const state = item.live === true ? item.running === true ? "running" : "idle" : "offline";
        const cwd = typeof item.cwd === "string" ? ` @ ${item.cwd}` : "";
        return `${state} ${item.sessionId} (${item.title ?? "(untitled)"})${cwd}`;
      }).join("\n") }];
    },
    async execute(args) {
      const limit = clampLimit(args.resultLimit, DEFAULT_FIND_LIMIT, MAX_FIND_LIMIT);
      const items = await knownSessions(ctx);
      if (items === void 0) return refusal(NO_SESSION_LISTING);
      const query = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
      const idFilter = typeof args.sessionIdMatch === "string" ? args.sessionIdMatch.trim().toLowerCase() : "";
      const titleFilter = typeof args.titleMatch === "string" ? args.titleMatch.trim().toLowerCase() : "";
      const cwdFilter = typeof args.cwdMatch === "string" ? args.cwdMatch.trim().toLowerCase() : "";
      if (titleFilter !== "" || query !== "") {
        let inspected = 0;
        for (const item of items) {
          if (inspected >= OFFLINE_TITLE_BUDGET) break;
          if (item.live || item.title !== void 0) continue;
          const events = await persistedEvents(ctx, item.sessionId);
          inspected += 1;
          if (events !== void 0 && titleOf(events) !== void 0) item.title = titleOf(events);
        }
      }
      const filtered = items.filter((item) => {
        if (args.liveOnly === true && !item.live) return false;
        if (idFilter !== "" && !item.sessionId.toLowerCase().includes(idFilter)) return false;
        if (titleFilter !== "" && !(item.title ?? "").toLowerCase().includes(titleFilter)) return false;
        if (cwdFilter !== "" && !(item.cwd ?? "").toLowerCase().includes(cwdFilter)) return false;
        if (query !== "") {
          const haystack = `${item.sessionId} ${item.title ?? ""} ${item.cwd ?? ""}`.toLowerCase();
          if (!haystack.includes(query)) return false;
        }
        return true;
      });
      filtered.sort((left, right) => {
        if (left.live !== right.live) return left.live ? -1 : 1;
        return (right.createdAt ?? 0) - (left.createdAt ?? 0);
      });
      const page = filtered.slice(0, limit);
      return asJson({
        offered: true,
        sessionId: "",
        reason: "",
        items: page,
        total: filtered.length,
        truncated: filtered.length > limit,
        summary: `${filtered.length} session${filtered.length === 1 ? "" : "s"} match${filtered.length === 1 ? "es" : ""}${filtered.length > page.length ? `, showing ${page.length}` : ""}.`
      });
    }
  };
}
function sessionStatus(ctx) {
  return {
    render: (_args, value) => {
      if (value.offered !== true || value.reason !== "") return [{ type: "text", text: value.reason }];
      const named = typeof value.title === "string" && value.title !== "" ? ` ("${value.title}")` : "";
      const lines = [`${value.running === true ? "running" : value.live === true ? "idle" : "offline"} ${value.sessionId}${named}`];
      if (value.live !== true) lines.push(`lastActivity: ${value.lastActivityAgoMs === null ? "unknown" : `now-${value.lastActivityAgoMs}ms`}`);
      else {
        lines.push(`openTurn: ${value.openTurn === true ? `yes (turn #${value.lastTurn})` : `no (last turn #${value.lastTurn})`}`);
        lines.push(`lastActivity: ${value.lastActivityAgoMs === null ? "never" : `now-${value.lastActivityAgoMs}ms`}${value.stalled === true ? " [STALLED]" : ""}`);
      }
      if (value.pendingWork === true) lines.push(`pendingWork: ${value.nextTurnCount} turn + ${value.nextStepCount} step`);
      if (value.lastTurnEnd !== void 0 && value.lastTurnEnd.kind !== "completed") {
        lines.push(`lastTurnEnd: ${value.lastTurnEnd.kind} (turn #${value.lastTurnEnd.turn})${value.lastTurnEnd.failure === void 0 ? "" : ` \u2014 ${value.lastTurnEnd.failure.code}: ${value.lastTurnEnd.failure.message}`}`);
      }
      if (typeof value.lastReply === "string" && value.lastReply !== "") lines.push(`lastReply: ${value.lastReply}`);
      if (typeof value.reasoningTail === "string" && value.reasoningTail !== "") lines.push(`reasoning: ${value.reasoningTail.length > 160 ? `${value.reasoningTail.slice(0, 160)}\u2026` : value.reasoningTail}`);
      return [{ type: "text", text: lines.join("\n") }];
    },
    async execute(args) {
      const sessionId = requiredString(args.sessionId, "sessionId", "the id wts_session_tool find answered with");
      const threshold = typeof args.stalledMsThreshold === "number" && Number.isFinite(args.stalledMsThreshold) && args.stalledMsThreshold >= 0 ? args.stalledMsThreshold : 6e4;
      const reasoningMode = ["none", "last", "live", "tail"].includes(args.reasoning) ? args.reasoning : "tail";
      const agents = agentsOf(ctx);
      const agent = agents === void 0 ? void 0 : safely(() => agents.get(sessionId));
      if (agent !== void 0 && agent !== null) {
        const snapshot = statusSnapshot(ctx, agent);
        const shown = typeof args.recent === "number" && Number.isInteger(args.recent) && args.recent >= 0 ? Math.min(args.recent, MAX_RECENT) : DEFAULT_RECENT;
        const recent = snapshot.recent.slice(-shown);
        const lastActivityAgoMs = snapshot.stalledMs;
        const value2 = {
          offered: true,
          sessionId,
          reason: "",
          live: true,
          running: snapshot.running,
          openTurn: snapshot.openTurn,
          lastTurn: snapshot.lastTurn,
          lastActivity: snapshot.lastActivityAt,
          lastActivityAgoMs,
          stalledMsThreshold: threshold,
          stalled: snapshot.running === true && lastActivityAgoMs !== null && lastActivityAgoMs > threshold,
          pendingWork: snapshot.pendingWork,
          nextTurnCount: snapshot.nextTurnCount,
          nextStepCount: snapshot.nextStepCount,
          lastReply: snapshot.lastReply ?? "",
          reasoningTail: reasoningMode === "none" ? "" : snapshot.reasoningTail ?? "",
          ...reasoningMode === "none" || reasoningMode === "live" ? {} : { lastReasoning: snapshot.lastReasoning ?? "" },
          ...reasoningMode === "none" || reasoningMode === "last" ? {} : { liveReasoning: snapshot.liveReasoning ?? "" },
          ...snapshot.title === void 0 ? {} : { title: snapshot.title },
          ...snapshot.cwd === void 0 ? {} : { cwd: snapshot.cwd },
          ...snapshot.lastTurnEnd === void 0 ? {} : { lastTurnEnd: snapshot.lastTurnEnd },
          messageCount: snapshot.messageCount,
          recent
        };
        value2.summary = `${snapshot.running ? "running" : "idle"}${snapshot.openTurn ? ", turn open" : ""}${snapshot.pendingWork ? ", work queued" : ""}${value2.stalled ? `, stalled (no activity for ${lastActivityAgoMs}ms)` : ""}.`;
        return asJson(value2);
      }
      const offline = await offlineSnapshot(ctx, sessionId);
      if (offline === void 0) {
        if (agents === void 0 && service(ctx, "sessionPersistence") === void 0) return refusal(NO_AGENTS);
        const reason = service(ctx, "sessionPersistence") === void 0 ? `session ${JSON.stringify(sessionId)} is not live, and this deployment serves no session persistence, so its log cannot be read \u2014 call wts_session_tool resume if it should come back online` : `session ${JSON.stringify(sessionId)} is not live and has no persisted log to read \u2014 use wts_session_tool find to locate the session that is still there`;
        return asJson({
          offered: true,
          sessionId,
          reason,
          title: "",
          live: false,
          running: false,
          openTurn: false,
          lastActivity: null,
          lastActivityAgoMs: null,
          stalledMsThreshold: threshold,
          stalled: false,
          pendingWork: false,
          nextTurnCount: 0,
          nextStepCount: 0,
          lastReply: "",
          reasoningTail: "",
          summary: `session ${sessionId} is unknown here.`
        });
      }
      const value = {
        offered: true,
        sessionId,
        reason: "",
        title: "",
        ...offline,
        running: false,
        lastActivity: offline.lastActivityAt,
        lastActivityAgoMs: offline.lastActivityAt === null ? null : Date.now() - offline.lastActivityAt,
        stalledMsThreshold: threshold,
        stalled: false,
        pendingWork: false,
        nextTurnCount: 0,
        nextStepCount: 0,
        lastReply: offline.lastReply ?? "",
        reasoningTail: reasoningMode === "none" ? "" : offline.reasoningTail ?? ""
      };
      value.summary = `offline (last activity ${value.lastActivityAgoMs === null ? "unknown" : `${value.lastActivityAgoMs}ms ago`}); call wts_session_tool resume to bring it back online.`;
      return asJson(value);
    }
  };
}
function sessionRead(ctx) {
  return {
    render: (_args, value) => {
      if (value.offered !== true || value.reason !== "") return [{ type: "text", text: value.reason }];
      const messages = Array.isArray(value.messages) ? value.messages : [];
      if (messages.length === 0) return [{ type: "text", text: `no messages in ${value.sessionId}` }];
      return [{ type: "text", text: messages.map((row) => `${row.role} #${row.seq}: ${typeof row.text === "string" ? row.text : "(no text)"}`).join("\n") }];
    },
    async execute(args, exec) {
      const sessionId = requiredString(args.sessionId, "sessionId", "the id wts_session_tool find answered with");
      const agents = agentsOf(ctx);
      const agent = agents === void 0 ? void 0 : safely(() => agents.get(sessionId));
      let events;
      let live = false;
      let cwd;
      let title;
      if (agent !== void 0 && agent !== null) {
        if (!await sessionInScope(ctx, sessionId, agent, exec)) {
          return unavailable(sessionId, outOfScopeReason(sessionId));
        }
        events = sessionEvents(agent.session);
        live = true;
        cwd = agent.session?.header?.cwd;
        title = titleOf(events);
      } else {
        events = await persistedEvents(ctx, sessionId);
        if (events === void 0) {
          if (agents === void 0 && service(ctx, "sessionPersistence") === void 0) return refusal(NO_AGENTS);
          return unavailable(sessionId, service(ctx, "sessionPersistence") === void 0 ? `session ${JSON.stringify(sessionId)} is not live, and this deployment serves no session persistence, so its log cannot be read \u2014 call wts_session_tool resume if it should come back online` : `session ${JSON.stringify(sessionId)} is not live and has no persisted log to read \u2014 use wts_session_tool find to locate the session that is still there`);
        }
        if (!await sessionInScope(ctx, sessionId, agent, exec)) {
          return unavailable(sessionId, outOfScopeReason(sessionId));
        }
      }
      let rows = foldMessages(events);
      if (args.role === "user") rows = rows.filter((row) => row.role === "user");
      if (args.role === "assistant") rows = rows.filter((row) => row.role === "assistant");
      if (args.includeReasoning === false) rows = rows.map((row) => ({ ...row, reasoning: void 0 }));
      const sinceSeq = typeof args.sinceSeq === "number" && Number.isInteger(args.sinceSeq) && args.sinceSeq >= 0 ? args.sinceSeq : void 0;
      if (sinceSeq !== void 0) rows = rows.filter((row) => row.seq > sinceSeq);
      const limit = clampLimit(args.messageLimit, DEFAULT_READ_LIMIT, MAX_READ_LIMIT);
      const page = rows.slice(-limit);
      return asJson({
        offered: true,
        sessionId,
        reason: "",
        live,
        ...cwd === void 0 ? {} : { cwd },
        ...title === void 0 ? {} : { title },
        messages: page.map((row) => ({
          seq: row.seq,
          time: row.time,
          role: row.role,
          ...row.text === void 0 ? {} : { text: row.text },
          ...row.reasoning === void 0 ? {} : { reasoning: row.reasoning },
          images: row.images,
          ...row.toolCalls === void 0 ? {} : { toolCalls: row.toolCalls }
        })),
        total: rows.length,
        truncated: rows.length > page.length,
        nextSeq: maxSeq(events),
        summary: `${page.length} of ${rows.length} message${rows.length === 1 ? "" : "s"} from ${sessionId} (${live ? "live" : "offline"}).`
      });
    }
  };
}
function sessionSend(ctx) {
  return {
    render: (_args, value) => {
      if (value.offered !== true || value.reason !== "") return [{ type: "text", text: value.reason }];
      const lines = [`sent to ${value.sessionId} (${value.mode})`];
      return [{ type: "text", text: lines.join("\n") }];
    },
    async execute(args, exec) {
      const sessionId = requiredString(args.sessionId, "sessionId", "the id wts_session_tool find answered with");
      const message = requiredString(args.message, "message", "the text to send");
      const agents = agentsOf(ctx);
      if (agents === void 0) return refusal(NO_AGENTS);
      const agent = safely(() => agents.get(sessionId));
      if (agent === void 0 || agent === null) {
        return unavailable(sessionId, `session ${JSON.stringify(sessionId)} is not live \u2014 call wts_session_tool resume to bring it online first, or wts_session_tool find to locate the session that is still there`);
      }
      if (!await sessionInScope(ctx, sessionId, agent, exec)) return unavailable(sessionId, outOfScopeReason(sessionId));
      const mode = args.mode === "queue" ? "queue" : "steer";
      const senderSessionId = sessionIdOf(exec?.agent);
      const { baseline } = await withSessionTurn(sessionId, async () => {
        const facts = await reportFacts(ctx, senderSessionId, exec?.agent?.session?.header?.cwd);
        const header = reportHeader(facts);
        const framed = header === "" ? framedForModel(message, senderSessionId) : message;
        const outbound = userMessage(header + framed, senderSessionId);
        const at = maxSeq(sessionEvents(agent.session));
        if (mode === "steer") agent.steer(outbound);
        else agent.followup(outbound);
        if (args.finalReport === true) await markReportedBy(senderSessionId, exec?.agent?.session?.header?.cwd);
        return { baseline: at };
      });
      const cwd = agent.session?.header?.cwd;
      await attachToWorkspace(ctx, sessionId, cwd);
      return asJson({
        offered: true,
        sessionId,
        reason: "",
        accepted: true,
        mode,
        sinceSeq: baseline,
        summary: `sent to ${sessionId} with mode=${mode}.`
      });
    }
  };
}
function sessionCreate(ctx) {
  return {
    render: (_args, value) => {
      if (value.offered !== true || value.reason !== "") return [{ type: "text", text: value.reason }];
      const lines = [`created session ${value.sessionId}${value.cwd === "" ? "" : ` in ${value.cwd}`}`];
      if (value.titleNote !== void 0) lines.push(value.titleNote);
      return [{ type: "text", text: lines.join("\n") }];
    },
    async execute(args, exec) {
      const requestedCwd = typeof args.cwd === "string" ? args.cwd.trim() : "";
      const workspaceId = typeof args.workspaceId === "string" ? args.workspaceId.trim() : "";
      if (requestedCwd === "" && workspaceId === "") {
        throw new Error("cwd is required (an absolute path \u2014 the task space the session must work in), or workspaceId");
      }
      const controller = service(ctx, "sessionController");
      const agents = agentsOf(ctx);
      const canUseController = controller !== void 0 && typeof controller.create === "function";
      const canUseAgents = agents !== void 0 && typeof agents.create === "function";
      if (!canUseController && !canUseAgents) return refusal(NO_CREATE);
      const preset = typeof args.agentPreset === "string" && args.agentPreset.trim() !== "" ? args.agentPreset.trim() : void 0;
      let sessionId = "";
      let cwd = requestedCwd;
      let viaController = false;
      if (canUseController) {
        const place = {
          ...workspaceId !== "" ? { workspaceId } : { cwd: requestedCwd },
          ...preset === void 0 ? {} : { agentPreset: preset }
        };
        const created = await safelyAsync(() => controller.create(place));
        sessionId = typeof created?.sessionId === "string" ? created.sessionId : "";
        viaController = true;
      } else {
        const presets = preset === void 0 ? void 0 : service(ctx, "agentPresets");
        sessionId = `wts-${randomUUID2()}`;
        const handle = await safelyAsync(() => agents.create({
          sessionId,
          meta: { cwd: requestedCwd, ...preset === void 0 ? {} : { agentPreset: preset } },
          ...preset === void 0 || presets === void 0 || typeof presets.mount !== "function" ? {} : { setup: async (agentCtx) => {
            await presets.mount(agentCtx, preset);
          } }
        }));
        if (handle === void 0 || handle.agent === void 0) {
          return unavailable("", `the session could not be opened in ${JSON.stringify(requestedCwd)}`);
        }
        cwd = handle.agent.session?.header?.cwd ?? requestedCwd;
      }
      if (sessionId === "") {
        return unavailable("", "the session service answered without a session id, so no session was opened");
      }
      const liveAgent = agents === void 0 ? void 0 : safely(() => agents.get(sessionId));
      if (liveAgent !== void 0 && liveAgent !== null && typeof liveAgent.session?.header?.cwd === "string") {
        cwd = liveAgent.session.header.cwd;
      }
      const attached = await attachToWorkspace(ctx, sessionId, cwd);
      const wantedTitle = typeof args.title === "string" && args.title.trim() !== "" ? args.title.trim() : "";
      let titleApplied = false;
      if (wantedTitle !== "" && liveAgent !== void 0 && liveAgent !== null) {
        titleApplied = renameSession(ctx, liveAgent.session, wantedTitle);
      }
      let baseline;
      const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
      if (prompt !== "") {
        if (liveAgent !== void 0 && liveAgent !== null) {
          baseline = maxSeq(sessionEvents(liveAgent.session));
          liveAgent.followup(userMessage(prompt));
        } else if (viaController && typeof controller.prompt === "function") {
          const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
          const handed = await safelyAsync(() => controller.prompt({
            requestId: randomUUID2(),
            sessionId,
            mode: "queue",
            content: [{ type: "text", text: prompt }],
            ...typeof timeZone === "string" && timeZone !== "" ? { clientTimeZone: timeZone } : {}
          }, new AbortController().signal));
          if (handed === void 0) {
            return asJson({
              offered: true,
              sessionId,
              reason: `the session was opened but the job could not be handed to it; open it and say what to do`,
              cwd,
              accepted: true,
              delivered: false,
              summary: `session ${sessionId} opened in ${cwd}, but the prompt did not reach it.`
            });
          }
        } else {
          return asJson({
            offered: true,
            sessionId,
            reason: "the session was opened but this deployment offers no way to hand it a prompt; open it and say what to do",
            cwd,
            accepted: true,
            delivered: false,
            summary: `session ${sessionId} opened in ${cwd}, but the prompt did not reach it.`
          });
        }
      }
      return asJson({
        offered: true,
        sessionId,
        reason: "",
        cwd,
        accepted: true,
        // Only said when there was a job to hand over: a session opened with no
        // prompt has nothing that could have been delivered, and a `false` there
        // would read as a handoff that failed.
        ...prompt === "" ? {} : { delivered: true },
        ...attached === void 0 ? {} : { workspaceId: attached },
        ...wantedTitle === "" ? {} : { title: wantedTitle },
        ...wantedTitle !== "" && !titleApplied ? { titleNote: "the title could not be applied: this deployment serves no sessionTitle service, or the session was not live" } : {},
        ...baseline === void 0 ? {} : { sinceSeq: baseline },
        summary: `session ${sessionId} opened in ${cwd}${prompt === "" ? "" : " and handed the job"}.`
      });
    }
  };
}
function sessionResume(ctx) {
  return {
    render: (_args, value) => {
      if (value.offered !== true || value.reason !== "") return [{ type: "text", text: value.reason }];
      if (value.alreadyLive === true) return [{ type: "text", text: `session ${value.sessionId} is already live` }];
      return [{ type: "text", text: `resumed session ${value.sessionId}${value.cwd === "" ? "" : ` (cwd: ${value.cwd})`}` }];
    },
    async execute(args) {
      const sessionId = requiredString(args.sessionId, "sessionId", "the id wts_session_tool find answered with");
      const agents = agentsOf(ctx);
      const existing = agents === void 0 ? void 0 : safely(() => agents.get(sessionId));
      if (existing !== void 0 && existing !== null) {
        return asJson({
          offered: true,
          sessionId,
          reason: "",
          alreadyLive: true,
          resumed: false,
          running: existing.status === "running",
          cwd: existing.session?.header?.cwd ?? "",
          summary: `session ${sessionId} is already live.`
        });
      }
      if (agents === void 0 || typeof agents.resume !== "function") return refusal(NO_RESUME);
      const persistence = service(ctx, "sessionPersistence");
      if (persistence === void 0 || typeof persistence.list !== "function") return refusal(NO_RESUME);
      const snapshots = await safelyAsync(() => persistence.list());
      const record = (Array.isArray(snapshots) ? snapshots : []).map((entry) => entry?.header ?? entry).find((header) => header !== null && typeof header === "object" && header.id === sessionId);
      if (record === void 0) {
        return unavailable(sessionId, `session ${JSON.stringify(sessionId)} is unknown here (no live agent and no persisted log) \u2014 use wts_session_tool find to locate the sessions that do exist`);
      }
      const handle = await safelyAsync(() => agents.resume({ resumeSessionId: sessionId }));
      if (handle === void 0 || handle.agent === void 0) {
        return unavailable(sessionId, `session ${JSON.stringify(sessionId)} could not be resumed`);
      }
      const cwd = handle.agent.session?.header?.cwd ?? record.cwd ?? "";
      await attachToWorkspace(ctx, sessionId, cwd);
      return asJson({
        offered: true,
        sessionId,
        reason: "",
        resumed: true,
        alreadyLive: false,
        cwd,
        summary: `session ${sessionId} is online again.`
      });
    }
  };
}
function sessionCancel(ctx) {
  return {
    render: (_args, value) => {
      if (value.offered !== true || value.reason !== "") return [{ type: "text", text: value.reason }];
      return [{ type: "text", text: `cancelled ${value.sessionId} (${value.keepInbox === true ? "queued work kept" : "queued work cleared"}), still running: ${value.running} \u2014 reason: ${value.cancelReason}` }];
    },
    async execute(args, exec) {
      const sessionId = requiredString(args.sessionId, "sessionId", "the id wts_session_tool find answered with");
      const cancelReason = requiredString(
        args.reason,
        "reason",
        "say why this session is being stopped; the reason is recorded with the cancellation"
      );
      const agents = agentsOf(ctx);
      if (agents === void 0) return refusal(NO_AGENTS);
      const agent = safely(() => agents.get(sessionId));
      if (agent === void 0 || agent === null) {
        return unavailable(sessionId, `session ${JSON.stringify(sessionId)} is not live \u2014 call wts_session_tool resume first, because stopping needs a live session`);
      }
      if (!await sessionInScope(ctx, sessionId, agent, exec, { destructive: true })) return unavailable(sessionId, outOfScopeReason(sessionId));
      const callerSessionId = sessionIdOf(exec?.agent);
      if (callerSessionId !== "" && callerSessionId === sessionId) {
        return unavailable(sessionId, `this is the session making the call, and cancelling it would end this turn \u2014 and the report it would send \u2014 before the answer existed. Stop it from another session, or from the interface.`);
      }
      const keepInbox = args.keepInbox === true;
      const cause = typeof args.cause === "string" && args.cause.trim() !== "" ? { kind: "hook", reason: args.cause.trim() } : { kind: "user" };
      agent.cancel(cause, { keepInbox });
      const snapshot = statusSnapshot(ctx, agent);
      return asJson({
        offered: true,
        sessionId,
        reason: "",
        cancelled: true,
        running: agent.status === "running",
        keepInbox,
        // The caller's own words, echoed back: the answer says what the cancellation
        // was for, so the record of it is not only in the host's log.
        cancelReason,
        openTurn: snapshot.openTurn,
        lastActivity: snapshot.lastActivityAt,
        summary: `cancelled ${sessionId} (${keepInbox ? "queued work kept" : "queued work cleared"}).`
      });
    }
  };
}
var SESSION_TOOL_NAME = "wts_session_tool";
var SESSION_DESCRIPTION = [
  "Watch and steer the sessions a task runs in: find, status, read, send, create, resume or cancel, chosen by action. The session id is in the task's own record - wts_worktree_space list reports it, and so does .worktree-space/worktree-space.json - so take it from there; find is the fallback for an id nobody wrote down. A dispatched session is NOT this session's child, so send_message cannot reach it.",
  // The one rule this tool cannot enforce by refusing an argument, because the way to
  // break it is to stop calling the tool and start watching for a change. It is stated
  // where a caller reads before choosing an action, and it names the two things that
  // make the waiting unnecessary: the session reports back by itself, and an abnormal
  // turn end is pushed to the dispatcher. Nothing here offers a way to wait.
  "Never block waiting for a session to finish. A session tells you when there is something to know: it reports its own progress, and a turn that ends badly is reported to you without being asked for. So call status or read when you have a reason to look, act on what you find, and return to your own work - do not poll in a loop, and do not sit on a call until the session answers, because a caller that is blocked cannot do either of those things.",
  'send, resume and cancel need a live session: call resume first when the answer says it is offline, which is what a host restart does to every session. status and read answer for an offline one too, from its persisted log - so "not live" is itself the answer, not a failure.',
  "send defaults to mode steer, which reaches a running turn at its next step - what a correction needs, because a dispatched task is often one long turn. mode queue appends a turn that is read only at a turn boundary, for the few messages that may wait. It returns as soon as the message is handed over; there is no way to wait for the reply, and send does not need one. Set finalReport true only when this message IS the finished work being handed over, never for a progress update or a question.",
  "read is how you see what a session has said, including whether a message you sent was delivered at all: it takes sinceSeq as a paging cursor, where -1 counts every event, which a brand-new session needs.",
  "cancel aborts the turn and, unless keepInbox is true, clears the work queued behind it. reason is required and is recorded with the cancellation - say why in your own words. Be sure the session is yours to stop: cancelling one the user is talking to aborts their conversation. Cancellation is asynchronous, so look at status once more rather than assuming the turn is already gone.",
  "create opens a NEW session, for when a task's session was lost and the work has to carry on in the same task space: pass cwd as the ABSOLUTE path of the task space, or a workspaceId. Its prompt must stand alone, because the new session shares none of this conversation. It answers as soon as the session exists and the job is handed over.",
  `status answers "stuck or busy" with lastActivity: a build leaves files, mtimes and logs still for minutes while a session keeps working, so only the session's own clock tells the two apart - pass stalledMsThreshold to have a quiet RUNNING session marked stalled. read folds the event log into rows and is how you confirm an instruction was actually delivered: a queued message sits unread in the inbox for as long as the turn runs, which looks exactly like a session ignoring it.`,
  "find matches a plain query against the id, the title and the working directory, or narrows to one field with titleMatch or cwdMatch."
].join("\n");
var SESSION_PARAMETERS = {
  action: {
    type: "string",
    required: true,
    enum: ["find", "status", "read", "send", "create", "resume", "cancel"],
    description: "find, status, read, send, create, resume or cancel."
  },
  sessionId: { type: "string", description: "Target session id. Required for every action except find and create." },
  query: { type: "string", description: "(find) Substring matched against the id, title and working directory (case-insensitive)." },
  sessionIdMatch: { type: "string", description: "(find) Only sessions whose id contains this." },
  titleMatch: { type: "string", description: "(find) Only sessions whose title contains this." },
  cwdMatch: { type: "string", description: "(find) Only sessions whose working directory contains this." },
  liveOnly: { type: "boolean", description: "(find) Only live sessions (default false)." },
  resultLimit: { type: "number", description: `(find) Maximum items (default ${DEFAULT_FIND_LIMIT}, max ${MAX_FIND_LIMIT}).` },
  stalledMsThreshold: { type: "number", description: "(status) Mark a quiet RUNNING session stalled after this many ms (default 60000)." },
  recent: { type: "number", description: `(status) Recent messages to include (default ${DEFAULT_RECENT}, max ${MAX_RECENT}).` },
  reasoning: { type: "string", enum: ["none", "last", "live", "tail"], description: "(status) Which chain-of-thought fields to include (default tail)." },
  sinceSeq: { type: "integer", description: "(read) Paging cursor: only a seq greater than this counts; -1 counts every event." },
  messageLimit: { type: "number", description: `(read) Most recent messages to return (default ${DEFAULT_READ_LIMIT}, max ${MAX_READ_LIMIT}).` },
  role: { type: "string", enum: ["user", "assistant", "both"], description: "(read) Which rows to return (default both)." },
  includeReasoning: { type: "boolean", description: "(read) Include assistant reasoning blocks (default true)." },
  message: { type: "string", description: "(send) Message text, sent as a user turn." },
  mode: { type: "string", enum: ["queue", "steer"], description: "(send) steer (default) interrupts the running turn at its next step; queue waits for a turn boundary." },
  finalReport: { type: "boolean", description: "(send) True only when this message IS the finished work being handed over. Defaults to false." },
  cwd: { type: "string", description: "(create) ABSOLUTE working directory - the task space. One of cwd or workspaceId is required." },
  workspaceId: { type: "string", description: "(create) Workspace to open in; takes precedence over cwd." },
  title: { type: "string", description: "(create) Title shown in the interface; stops automatic title generation." },
  prompt: { type: "string", description: "(create) The session's first job. It must stand alone: it shares no context with this conversation." },
  agentPreset: { type: "string", description: "(create) Agent preset id to compose the session from." },
  keepInbox: { type: "boolean", description: "(cancel) Keep queued and steering input instead of clearing it (default false)." },
  cause: { type: "string", description: "(cancel) Short label for the kind of stopping this is; the why belongs in reason." },
  reason: { type: "string", description: "(cancel) REQUIRED: why this session is being stopped, in your own words." }
};
function sessionToolDefinition(ctx) {
  const handlers = {
    find: sessionFind(ctx),
    status: sessionStatus(ctx),
    read: sessionRead(ctx),
    send: sessionSend(ctx),
    create: sessionCreate(ctx),
    resume: sessionResume(ctx),
    cancel: sessionCancel(ctx)
  };
  return {
    name: SESSION_TOOL_NAME,
    description: SESSION_DESCRIPTION,
    parameters: SESSION_PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA2,
      render: (args, value) => {
        const handler = handlers[args?.action];
        return handler === void 0 ? [{ type: "text", text: value.summary }] : handler.render(args, value);
      },
      presentationMeta: (_args, value) => cardMeta(value)
    },
    async execute(args, exec) {
      const handler = handlers[args?.action];
      if (handler === void 0) {
        return refusal(`${SESSION_TOOL_NAME}: no action named ${JSON.stringify(args?.action ?? "")}; the action is one of find, status, read, send, create, resume or cancel`);
      }
      return handler.execute(args, exec);
    }
  };
}
function registerSessionTools(ctx) {
  if (ctx === null || ctx === void 0 || typeof ctx.get !== "function") return void 0;
  const tools = ctx.get("tools");
  if (tools === void 0 || tools === null || typeof tools.register !== "function") return void 0;
  return tools.register(defineTool2(sessionToolDefinition(ctx)));
}

// src/host/session-watch.js
import { randomUUID as randomUUID3 } from "node:crypto";
import { basename as basename9, dirname as dirname9 } from "node:path";
var ABNORMAL_TURN_ENDS = /* @__PURE__ */ new Set(["error", "interrupted", "blocked", "max-tokens"]);
var MISSING_REPORT_TURN_ENDS = /* @__PURE__ */ new Set(["completed"]);
var KIND_PHRASES = {
  error: "failed",
  interrupted: "was interrupted (the process stopped mid-turn)",
  blocked: "was refused before it could start",
  "max-tokens": "ran out of output room before it finished"
};
function phraseFor(kind) {
  return KIND_PHRASES[kind] ?? `ended abnormally (${kind})`;
}
var UNREPORTED_PHRASE = "ended its turn normally without sending a final report";
function hasReport(entry) {
  return typeof entry?.reportedAt === "string" && entry.reportedAt.trim() !== "";
}
function failureDetail(reason) {
  const failure = reason?.error;
  if (failure === null || typeof failure !== "object") return "";
  const code = typeof failure.code === "string" && failure.code !== "" ? failure.code : "";
  const message = typeof failure.message === "string" && failure.message !== "" ? failure.message : "";
  if (code !== "" && message !== "") return `${code}: ${message}`;
  return code !== "" ? code : message;
}
function interruptionNotice(task, sessionId, kind, detail) {
  const subject = task === "" ? "The dispatched session" : `The dispatched session for "${task}"`;
  const detailLine = detail === "" ? "" : `
It reported: ${detail}`;
  return `${subject} ${phraseFor(kind)}.

Session id: ${sessionId}${detailLine}

It is still there \u2014 \`wts_session_tool status\` says what it is doing now, \`wts_session_tool read\` shows the last messages, and \`wts_session_tool send\` can put it back to work. The work was NOT finished, so do not treat this task as done.`;
}
function missingReportNotice(task, sessionId) {
  const subject = task === "" ? "The dispatched session" : `The dispatched session for "${task}"`;
  return `${subject} ended its last turn normally, but it never sent a final report.

This is not a failure of the turn: nothing here says the work stopped wrongly. What is missing is the report \u2014 the session has not called \`wts_session_tool send\` with \`finalReport: true\`, so nothing tells you whether the work finished, what it did, or what it left unverified.

Session id: ${sessionId}

Read what it did before deciding anything: \`wts_session_tool read\` shows its last messages and \`wts_session_tool status\` says where it stopped. Treat this notice as a report that is missing, **not** as a reason to resume or wake the session \u2014 a session that has stopped may have been stopped on purpose, and its own last output is the first thing to read.`;
}
var SessionWatch = class {
  /**
   * @param deps - the plugin context and a log sink.
   */
  constructor(deps) {
    this.deps = deps;
    this.watched = /* @__PURE__ */ new Map();
    this.installed = false;
    this.unsubscribe = void 0;
  }
  /**
   * Start listening. Idempotent, and safe on a host that serves no session service.
   *
   * The disposer `ctx.on` returns is kept rather than dropped, and that is the difference
   * between a listener this instance owns and one it can only stop by being garbage
   * collected. Without it `dispose()` cleared the watch table and set `installed` back to
   * false - so a `dispose()` followed by an `install()` put a **second** listener on the
   * feed, and every event was then handled twice. The host's own disposal of the plugin
   * fibre removes the first one, so this is not about reloads: it is about this object's
   * own lifecycle staying honest, which is what `installed` claims to describe.
   * @returns whether the feed was subscribed to.
   */
  install() {
    if (this.installed) return true;
    const ctx = this.deps.ctx;
    if (ctx === null || ctx === void 0 || typeof ctx.on !== "function") {
      this.emit("this deployment serves no session event feed, so an interrupted dispatched session cannot be reported");
      return false;
    }
    try {
      const off = ctx.on("session/event", (session, event) => {
        let outcome;
        try {
          outcome = this.onSessionEvent(session, event);
        } catch (error) {
          this.emit(`watching a session event failed: ${String(error?.message ?? error)}`);
          return void 0;
        }
        if (outcome !== null && typeof outcome === "object" && typeof outcome.then === "function") {
          outcome.catch((error) => this.emit(`watching a session event failed: ${String(error?.message ?? error)}`));
        }
        return outcome;
      });
      this.unsubscribe = typeof off === "function" ? off : void 0;
      this.installed = true;
      return true;
    } catch (error) {
      this.emit(`the session event feed could not be subscribed to: ${String(error?.message ?? error)}`);
      return false;
    }
  }
  /**
   * Watch one dispatched session.
   *
   * Called right after the work is handed over. Watching is by session id, so a session that
   * was already watched (a second dispatch into the same space) keeps the newest task name and
   * sender rather than accumulating two notices per turn.
   *
   * `taskPath` and `sourceRoot` are where a later "did it report?" is answered from, and they
   * are captured here because by the time a turn ends they may be gone: `done` removes the task
   * space and files its index under the source root. `taskPath` locates the live record, and
   * the source root locates the archive once the record is not there. Both are optional - a
   * caller with neither cannot be asked the question, and the answer given then is "no report".
   * @param sessionId - the dispatched session.
   * @param task - the task name, for the notice.
   * @param senderSessionId - the dispatching agent's session id, or '' when it has none.
   * @param taskPath - the task space directory, or '' when the caller has none.
   * @param sourceRoot - the workspace root the task was cut from, or ''.
   */
  watch(sessionId, task, senderSessionId, taskPath = "", sourceRoot = "") {
    if (typeof sessionId !== "string" || sessionId === "") return;
    this.watched.set(sessionId, {
      task: typeof task === "string" ? task : "",
      sender: typeof senderSessionId === "string" ? senderSessionId : "",
      taskPath: typeof taskPath === "string" ? taskPath : "",
      sourceRoot: typeof sourceRoot === "string" ? sourceRoot : "",
      lastKey: void 0
    });
  }
  /**
   * Stop watching one session.
   *
   * Deliberately has no caller in this plugin, and the review lists that as a finding. It is
   * a design decision rather than an oversight, and the reason is what an entry holds: a
   * session id, the task name to say in a notice, and the id to address it to. None of those
   * expires. `notify` resolves the sending agent afresh each time, so an entry for a session
   * that has gone is inert until a later dispatch into that same session replaces it - and
   * that replacement keeps the newest task and sender rather than accumulating a second.
   *
   * Dropping entries at some event would be worse than keeping them. The obvious candidate
   * is a finish, and that is the moment a dispatched session may still be running - a report
   * about its death is exactly what the dispatcher is waiting for when it goes to look - so
   * a watch cancelled there would suppress the one notice this module exists to deliver.
   * Cancelling on the session's own end would need a signal this module does not receive.
   *
   * The table is therefore bounded by the number of sessions this plugin has dispatched into,
   * which is small and does not grow on its own. It is kept as a method rather than deleted
   * because it is the correct way to stop watching one session, and a deployment that learns
   * a reliable end-of-session signal should call it there rather than reach into the map.
   */
  unwatch(sessionId) {
    this.watched.delete(sessionId);
  }
  /** The session ids currently watched. */
  watchedIds() {
    return [...this.watched.keys()];
  }
  /**
   * Stop everything: the watches, and the subscription itself.
   *
   * Unsubscribing is what makes `installed` mean what it says. Clearing the table and
   * setting the flag false, without removing the listener, describes an instance that is
   * no longer watching while it is still receiving every event - and an `install()` after
   * that would add a second listener, so each event would be judged twice and every notice
   * sent twice. A host that returned no disposer is the one case this cannot undo, and it
   * is reported rather than hidden.
   */
  dispose() {
    this.watched.clear();
    if (this.installed && this.unsubscribe === void 0) {
      this.emit("the session event feed gave no way to unsubscribe, so this listener stays attached until the plugin is unloaded");
    }
    const off = this.unsubscribe;
    this.unsubscribe = void 0;
    if (typeof off === "function") {
      try {
        off();
      } catch (error) {
        this.emit(`the session event feed could not be unsubscribed from: ${String(error?.message ?? error)}`);
      }
    }
    this.installed = false;
  }
  /**
   * Judge one appended event.
   *
   * Only `turn/end` matters, and only for a session being watched. Everything else returns
   * immediately - this runs for every event of every session in the deployment.
   *
   * An abnormal kind notifies straight away and returns. A `completed` turn notifies only once
   * the session's own record has been asked whether a final report was delivered, which is why
   * this is `async`: the answer comes from a file, and after a `done` that file is the archived
   * index under the source root. It never rejects; the listener that calls it catches anyway.
   *
   * `aborted` is neither: it is a turn something stopped on purpose, so it is not reported at
   * all. The module comment says why.
   * @param session - the session whose log grew.
   * @param event - the appended event.
   * @returns nothing, or a promise that settles when a completed turn has been judged.
   */
  async onSessionEvent(session, event) {
    if (event?.type !== "turn/end") return;
    const sessionId = typeof session?.id === "string" ? session.id : "";
    if (sessionId === "") return;
    const entry = this.watched.get(sessionId);
    if (entry === void 0) return;
    const reason = event.data?.reason;
    const kind = reason?.kind;
    if (typeof kind !== "string") return;
    const abnormal = ABNORMAL_TURN_ENDS.has(kind);
    if (!abnormal && !MISSING_REPORT_TURN_ENDS.has(kind)) return;
    const key = typeof event.seq === "number" ? `seq:${event.seq}` : typeof event.data?.turn === "number" ? `turn:${event.data.turn}` : "";
    if (key !== "" && entry.lastKey === key) return;
    if (key !== "") entry.lastKey = key;
    if (abnormal) {
      this.notify(entry, sessionId, kind, failureDetail(reason));
      return;
    }
    if (await this.reported(entry, sessionId)) return;
    this.notifyMissingReport(entry, sessionId);
  }
  /**
   * Whether this session delivered its final report, as far as anything on disk can say.
   *
   * Two places are asked, in the order that matters. The live record is the authority while the
   * task space exists. Once it does not - a `done` removes the space and files the index under
   * the source root - the archived index is the only copy left, and it is read from the
   * project and task the watched `taskPath` was built from, which is why `watch` keeps that path
   * rather than only the task name.
   *
   * An unreadable answer is "no report". Both reads are best-effort by nature (the file may be
   * gone, unreadable, or hand-edited), and the direction of the mistake is chosen deliberately:
   * a notice the dispatcher did not need is one sentence, where a silent session is the gap this
   * module exists to close.
   * @param entry - the watch record, carrying the task path and the source root.
   * @param sessionId - the session that just ended a turn.
   * @returns whether a report is on record.
   */
  async reported(entry, sessionId) {
    const taskPath = entry.taskPath;
    if (taskPath !== "") {
      const metadata = await readTaskMetadata(taskPath).catch(() => void 0);
      if (metadata !== void 0 && metadata !== null) {
        const found = taskSessionsOf(metadata).find((one) => one.sessionId === sessionId);
        if (found !== void 0) return hasReport(found);
      }
    }
    if (entry.sourceRoot !== "") {
      const task = taskPath === "" ? entry.task : basename9(taskPath);
      const project = taskPath === "" ? "" : basename9(dirname9(taskPath));
      if (project !== "" && task !== "") {
        const archived = await readArchivedTaskSession(entry.sourceRoot, project, task, sessionId).catch(() => void 0);
        if (archived !== void 0) return hasReport(archived);
      }
    }
    return false;
  }
  /**
   * Deliver one notice to the dispatching session.
   *
   * The report is sent as the watching session's own agent, so the receiving interface
   * attributes it and presents it as an agent's report rather than as the user typing - the
   * same channel `wts_session_tool send` uses.
   * @param entry - the watch record.
   * @param sessionId - the dispatched session's id.
   * @param kind - the turn-end kind.
   * @param detail - the failure detail, when there is one.
   */
  notify(entry, sessionId, kind, detail) {
    this.deliver(entry, sessionId, phraseFor(kind), interruptionNotice(entry.task, sessionId, kind, detail));
  }
  /**
   * The same delivery, for a session that ended without reporting.
   *
   * A separate entry point rather than a flag because the two notices are different documents:
   * one says the work was not finished, the other says the turn ended normally and only the
   * report is missing. What they share is the channel and the addressee, which is what
   * {@link deliver} holds.
   * @param entry - the watch record.
   * @param sessionId - the dispatched session's id.
   */
  notifyMissingReport(entry, sessionId) {
    this.deliver(entry, sessionId, UNREPORTED_PHRASE, missingReportNotice(entry.task, sessionId));
  }
  /**
   * Send one notice to the dispatching session, or say why it could not be sent.
   * @param entry - the watch record.
   * @param sessionId - the dispatched session's id.
   * @param phrase - how the turn end reads in a log line.
   * @param text - the message body.
   */
  deliver(entry, sessionId, phrase, text) {
    const sender = entry.sender;
    if (sender === "") {
      this.emit(`session ${sessionId} ${phrase}, but the dispatching session is unknown, so nothing was sent`);
      return;
    }
    const target = this.agentFor(sender);
    if (target === void 0) {
      this.emit(`session ${sessionId} ${phrase}, but the dispatching session ${sender} is not live, so nothing was sent`);
      return;
    }
    try {
      target.steer({
        id: randomUUID3(),
        role: "user",
        content: [{ type: "text", text }],
        source: { kind: "agent-message", form: "relay", senderSessionId: sessionId }
      });
      this.emit(`reported to ${sender}: session ${sessionId} ${phrase}`);
    } catch (error) {
      this.emit(`session ${sessionId} ${phrase}, but telling ${sender} failed: ${String(error?.message ?? error)}`);
    }
  }
  /**
   * The live agent for one session id, or undefined.
   * @param sessionId - the session to resolve.
   * @returns the agent, when the registry serves one.
   */
  agentFor(sessionId) {
    const ctx = this.deps.ctx;
    if (ctx === null || ctx === void 0 || typeof ctx.get !== "function") return void 0;
    let agents;
    try {
      agents = ctx.get("agents");
    } catch {
      return void 0;
    }
    if (agents === void 0 || agents === null || typeof agents.get !== "function") return void 0;
    try {
      const agent = agents.get(sessionId);
      return agent === null ? void 0 : agent;
    } catch {
      return void 0;
    }
  }
  /**
   * The log sink. Never throws: it is called from inside another session's append path and
   * from this module's own error handling.
   * @param message - the line to record.
   */
  emit(message) {
    try {
      this.deps.log(message);
    } catch {
    }
  }
};

// src/host/index.js
var API_PREFIX = "/api/dsh-worktree-space";
var WORKTREE_ENDPOINTS = ["worktree.scan", "worktree.cached", "worktree.status"];
var TASK_ENDPOINTS = ["task.classify-root", "task.classify-roots", "task.suggest-root", "task.create", "task.add-repositories", "task.list", "task.inspect", "task.plan", "task.done", "task.deploy-status", "task.deploy-destroy", "task.deploy-up", "task.deploy-smoke", "task.preference", "task.handoff-access", "task.handoff-open"];
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
  "E1006",
  "E2001",
  "E2002",
  "E2003",
  "E2004",
  "E2005",
  "E2006",
  "E2007",
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
  "E4011",
  "E4012",
  "E4014",
  "E4015",
  "E5001",
  "E5002",
  "E5003",
  "E5004",
  "E5006",
  "E5008",
  "E5011",
  "E5012",
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
var cleanPath = (value) => {
  const text = String(value ?? "");
  return text.length > 1 ? text.replace(/[\\/]+$/, "") : text;
};
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
var appliedConfig = {};
function scanBounds() {
  const directories = Number(settingValue(appliedConfig.maxScanDirectories));
  const added = settingValue(appliedConfig.ignoredScanDirectories);
  const removed = settingValue(appliedConfig.removedScanDirectories);
  return {
    depth: resolveScanDepth(settingValue(appliedConfig.scanDepth)),
    // Clamped the way the depth above is, and for the same reason: the schema is a
    // promise about what a *new* configuration may hold, while this is what the walk
    // actually obeys. A profile whose stored value predates the ceiling - or was
    // written straight into the file - still reads through this line, so the walk is
    // bounded even when the schema never saw the value.
    directories: Number.isFinite(directories) ? Math.min(MAX_SCAN_DIRECTORIES_CEILING, Math.max(1, Math.trunc(directories))) : MAX_SCAN_DIRECTORIES,
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
var handoffFullAccessReference;
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
function configuredHandoffFullAccess() {
  return settingValue(handoffFullAccessReference) === "on" ? "on" : "off";
}
function configuredTasksRoot() {
  if (tasksRootStrategyReference?.get() !== "custom") return "";
  const value = tasksRootDirectoryReference?.get();
  return typeof value === "string" ? value.trim() : "";
}
function resolveScanDepth(value) {
  if (value === void 0 || value === null || value === "") return DEFAULT_SCAN_DEPTH;
  const depth = Math.trunc(Number(value));
  if (!Number.isFinite(depth)) return DEFAULT_SCAN_DEPTH;
  return Math.min(MAX_SCAN_DEPTH, Math.max(MIN_SCAN_DEPTH, depth));
}
async function discoverGitRoots(rootPath, { signal, maxDepth = DEFAULT_SCAN_DEPTH, maxDirectories = MAX_SCAN_DIRECTORIES, ignored = DEFAULT_IGNORED_SCAN_DIRECTORY_SET, onIssue } = {}) {
  const roots = [];
  const start = cleanPath(rootPath);
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
        entries = await readdir11(path, { withFileTypes: true });
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
        queue.push({ path: join18(path, entry.name), depth: depth + 1 });
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
    return fail(code, message, error?.details ?? {});
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
  const cleaned = [...new Set(paths.map(cleanPath).filter(Boolean))];
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
   * Whether the sessions a finish hands an agent are opened with full access.
   *
   * Off, each handoff session is opened on the directory that reaches both the worktree
   * and its source repository's git metadata, which is what lets the commit run without
   * the sandbox asking. That boundary is a property of the layout - it is wherever the
   * two share a directory - so those sessions land in whatever Workspace sits there, or
   * in Ungrouped where nothing does.
   *
   * On, the session is opened on **the task space** instead, and given
   * `danger-full-access`, because the metadata a commit writes lies outside it. Two
   * things follow from that directory rather than from the container root it used to be:
   * the entry registered in the workspace list is named after this task rather than after
   * a directory holding every project's task spaces, and the finish that removes the task
   * space drops that registration with it, so the row does not outlive the work. The grant
   * itself is the whole disk rather than the repositories involved, and it is a
   * session-log event: it is durable, and it survives a restart by replay. So this is off
   * by default and stays off unless the user says otherwise - and the endpoint below
   * checks it again before widening anything, because it is the authorisation for that
   * write.
   *
   * Either way, each hand-off opens a session of its own rather than reaching for a session
   * the task space already has working in it: that conversation is the user's own, and
   * widening it to finish a merge is a decision about it rather than about this button.
   *
   * Read through `task.preference`, so the dialog that offers the handoff can say which
   * of the two it is about to do without reaching for the configuration form.
   */
  handoffFullAccess: z.union(["off", "on"]).default("off").loose().volatile().description("Open the sessions that commit uncommitted work, and the sessions that resolve a merge conflict, in the task space itself with full access, so they never ask to write a source repository's git metadata. Off, each is opened on the directory that reaches that metadata, and asks when it has to write outside it."),
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
  maxScanDirectories: z.number().min(1).max(MAX_SCAN_DIRECTORIES_CEILING).step(1).default(MAX_SCAN_DIRECTORIES).volatile().description("Directories one scan may inspect before it stops looking."),
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
  archiveDocumentsDirectory: z.string().default("").volatile().description("Where archived documents go under the custom strategy. Empty files them under the container root instead.")
});
function settingValue(setting) {
  if (setting !== null && typeof setting === "object" && typeof setting.get === "function") return setting.get();
  return setting;
}
function isRegisteredTaskSpace(ctx, taskPath) {
  try {
    if (typeof ctx.get !== "function") return false;
    const registry = ctx.get("workspaceRegistry");
    if (registry === null || registry === void 0 || typeof registry.list !== "function") return false;
    const target = canonicalPath(taskPath);
    return registry.list().some((entry) => entry !== null && entry !== void 0 && canonicalPath(entry.path) === target);
  } catch {
    return false;
  }
}
function apply(ctx, config = {}) {
  appliedConfig = config ?? {};
  branchPrefixReference = config.defaultBranchPrefix;
  archiveDirectoryReference = config.archiveDocumentsDirectory;
  archiveStrategyReference = config.archiveDocumentsStrategy;
  handoffEntryReference = config.handoffEntry;
  handoffFullAccessReference = config.handoffFullAccess;
  tasksRootStrategyReference = config.tasksRootStrategy;
  tasksRootDirectoryReference = config.tasksRootDirectory;
  setAuditEnabledReader(() => settingValue(config.auditLog) !== "off");
  const sessionWatcher = new SessionWatch({ ctx, log: (message) => {
    try {
      if (typeof ctx.logger?.warn === "function") ctx.logger.warn(`dsh-worktree-space: ${message}`);
    } catch {
    }
  } });
  sessionWatcher.install();
  if (typeof ctx.effect === "function") ctx.effect(() => () => sessionWatcher.dispose(), "dsh-worktree-space session watch");
  if (typeof ctx.inject === "function") {
    ctx.inject(["tools"], (toolsCtx) => registerTaskTool(toolsCtx, { configuredRoot: configuredTasksRoot, configuredFullAccess: configuredHandoffFullAccess, configuredArchive: () => ({ strategy: configuredArchiveStrategy(), directory: configuredArchiveDirectory() }), sessionWatch: sessionWatcher }));
  } else {
    registerTaskTool(ctx, { configuredRoot: configuredTasksRoot, configuredFullAccess: configuredHandoffFullAccess, configuredArchive: () => ({ strategy: configuredArchiveStrategy(), directory: configuredArchiveDirectory() }), sessionWatch: sessionWatcher });
  }
  if (typeof ctx.inject === "function") {
    ctx.inject(["tools"], (toolsCtx) => registerSessionTools(toolsCtx));
  } else {
    registerSessionTools(ctx);
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
      const porcelain = await runGit(ctx.subprocess, path, ["worktree", "list", "--porcelain"], { log: false, signal });
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
        const key = cleanPath(repository.repoPath);
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
      const path = absolutePath(payload.path);
      if (!path) throw coded("E4005", "Worktree path is required.");
      const target = typeof payload.target === "string" ? payload.target.trim() : "";
      const [output, ahead] = await Promise.all([
        runGit(ctx.subprocess, path, ["status", "--short", "--branch"], { signal }),
        target === "" ? "" : tryRunGit(ctx.subprocess, path, ["rev-list", "--count", `${target}..HEAD`], { signal })
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
      const sourceRoot = absolutePath(payload.sourceRoot);
      if (!sourceRoot) throw coded("E4004", "A source root is required.");
      return classifySourceRoot(sourceRoot, { signal });
    });
    if (endpoint === "task.classify-roots") return recover(async () => {
      const paths = requestedPaths(payload);
      if (paths.length === 0) throw coded("E4004", "A source root is required.");
      return classifySourceRoots(paths, { signal, concurrency: SCAN_CONCURRENCY, ...taskScanBounds() });
    });
    if (endpoint === "task.suggest-root") return recover(async () => {
      const sourceRoot = absolutePath(payload.sourceRoot);
      if (!sourceRoot) throw coded("E4004", "A source root is required.");
      return suggestTaskRoot(ctx.subprocess, sourceRoot, {
        tasksRoot: absolutePath(payload.tasksRoot),
        // An unnamed prefix is the configured one, not the built-in: the suggestion
        // is what the create dialog shows, and it must show the same default the
        // request will fall back to.
        branchPrefix: typeof payload.branchPrefix === "string" && payload.branchPrefix !== "" ? payload.branchPrefix : configuredBranchPrefix(),
        // Likewise for the location, so the dialog opens on the container root the
        // configuration names instead of on the one it would otherwise derive.
        configuredRoot: configuredTasksRoot(),
        // Closing the dialog should stop the walk it asked for, the same way it stops
        // the classification: the signal is the request's own.
        signal,
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
        // Which of the two arrangements the next handoff will use: the boundary that
        // reaches a repository's git metadata, or the container root with full access.
        // The dialog says which before it opens anything, so it has to know.
        handoffFullAccess: configuredHandoffFullAccess(),
        // So a dialog can tell someone that what just happened was not recorded
        // rather than leave them to find an empty log and assume the plugin is
        // broken. The answer is the running state, not the configured value, so
        // it cannot disagree with what is actually being written.
        auditLog: auditEnabled() ? "on" : "off"
      };
    });
    if (endpoint === "task.handoff-open") return recover(async () => {
      const sessionId = typeof payload.sessionId === "string" ? payload.sessionId.trim() : "";
      if (sessionId === "") throw coded("E4011", "A session id is required.");
      const cwd = typeof payload.cwd === "string" ? payload.cwd.trim() : "";
      return fileSessionUnderWorkspace(ctx, sessionId, cwd);
    });
    if (endpoint === "task.handoff-access") return recover(async () => {
      const sessionId = typeof payload.sessionId === "string" ? payload.sessionId.trim() : "";
      if (sessionId === "") throw coded("E4011", "A session id is required.");
      if (configuredHandoffFullAccess() !== "on") {
        throw coded("E4012", "Full access for the sessions handed to an agent is switched off.");
      }
      const sessions = typeof ctx.get === "function" ? ctx.get("sessions") : void 0;
      if (sessions === null || sessions === void 0 || typeof sessions.get !== "function") {
        return { widened: false, reason: "no-sessions-service" };
      }
      if (!setSessionPermission(sessions.get(sessionId), "danger-full-access")) {
        return { widened: false, reason: "no-session" };
      }
      return { widened: true, mode: "danger-full-access" };
    });
    if (endpoint === "task.create") return recover(async () => {
      const sourceRoot = absolutePath(payload.sourceRoot);
      const task = typeof payload.task === "string" ? payload.task.trim() : "";
      if (!sourceRoot) throw coded("E4004", "A source root is required.");
      if (!task) throw coded("E4003", "A task name is required.");
      const repos = Array.isArray(payload.repos) ? payload.repos.filter((name2) => typeof name2 === "string" && name2.trim() !== "").map((name2) => name2.trim()) : void 0;
      return createTask(ctx.subprocess, {
        sourceRoot,
        task,
        tasksRoot: absolutePath(payload.tasksRoot),
        repos,
        baseRef: typeof payload.baseRef === "string" ? payload.baseRef.trim() : void 0,
        deployScript: payload.deployScript,
        // A caller that names no prefix gets the configured one; an empty string
        // means the same thing, which is what an emptied dialog field sends.
        branchPrefix: typeof payload.branchPrefix === "string" && payload.branchPrefix !== "" ? payload.branchPrefix : configuredBranchPrefix(),
        // A request that names no container root takes the configured one, which is
        // the same answer `task.suggest-root` just gave the dialog.
        configuredRoot: configuredTasksRoot(),
        // The one delivery decision: whether this task expects a deployment. The
        // dialog sends a target name; an invalid one is refused inside the create,
        // before anything is made.
        delivery: typeof payload.deployTarget === "string" && payload.deployTarget.trim() !== "" ? { deploy: { target: payload.deployTarget.trim() } } : void 0,
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
        tasksRoot: absolutePath(payload.tasksRoot),
        // Each of these is compared against the task space - `assertAddIsolated` asks
        // whether one holds the other - so each is resolved here, at the boundary,
        // rather than left as whatever spelling the caller sent.
        repositories: repositories.map(absolutePath),
        baseRef: typeof payload.baseRef === "string" && payload.baseRef.trim() !== "" ? payload.baseRef.trim() : void 0
      });
    });
    if (endpoint === "task.list") return recover(async () => {
      const tasksRoot = absolutePath(payload.tasksRoot);
      return listTasks(ctx.subprocess, { tasksRoot });
    });
    if (endpoint === "task.inspect") return recover(async () => {
      const path = absolutePath(payload.path);
      if (!path) throw coded("E4005", "A task path is required.");
      return inspectTask(path);
    });
    if (endpoint === "task.plan") return recover(async () => {
      const task = typeof payload.task === "string" ? payload.task.trim() : "";
      if (!task) throw coded("E4003", "A task name is required.");
      const tasksRoot = absolutePath(payload.tasksRoot);
      const project = typeof payload.project === "string" ? payload.project : "";
      const plan = await planTask(ctx.subprocess, {
        task,
        project,
        tasksRoot,
        targets: branchTargets(payload.targets)
      });
      return {
        ...plan,
        activeSessions: sessionsWorkingIn2(ctx, taskSpacePath(tasksRoot, project, task))
      };
    });
    if (endpoint === "task.done") return recover(async () => {
      const task = typeof payload.task === "string" ? payload.task.trim() : "";
      if (!task) throw coded("E4003", "A task name is required.");
      const taskPath = taskSpacePath(
        absolutePath(payload.tasksRoot),
        typeof payload.project === "string" ? payload.project : "",
        task
      );
      const rollback = typeof payload.cause === "string" && payload.cause.trim() !== "";
      const guardSessions = !rollback || isRegisteredTaskSpace(ctx, taskPath);
      if (guardSessions) {
        refuseWhileSessionsWork2(ctx, taskPath);
      }
      return finishTask(ctx.subprocess, {
        task,
        project: typeof payload.project === "string" ? payload.project : "",
        tasksRoot: absolutePath(payload.tasksRoot),
        // The guard above is the early refusal. Handing the same context on is what lets
        // the finish ask again inside its own lock, where the answer cannot go stale
        // between the question and the removal - see `finishTask`. Passed only when the
        // guard applies, so a rollback that skips the early check skips both.
        ...guardSessions ? { ctx } : {},
        // The panel always says whether to merge, so this is a plain boolean: there is
        // no record left to answer for it, and no default to fall back on.
        merge: payload.merge === true,
        target: typeof payload.target === "string" ? payload.target : void 0,
        targets: branchTargets(payload.targets),
        deleteBranch: payload.deleteBranch === true,
        force: payload.force === true,
        // What happens to the files git never tracked. Omitted, the finish archives
        // them - the answer that neither loses the user's writing nor leaves the
        // space standing.
        //
        // `discard` is allowed here and refused by the model-facing tool (E7007). That
        // asymmetry is the point, not an oversight: this endpoint is the panel, where a
        // person ticked a box the dialog warns about, and the tool is the path a model
        // can be talked down. Both reach the same `finishTask`; only one is trusted with
        // deleting the user's own files.
        strays: typeof payload.strays === "string" ? payload.strays : void 0,
        keepEntries: Array.isArray(payload.keepEntries) ? payload.keepEntries.filter((name2) => typeof name2 === "string") : [],
        // Deliberately not resolved, unlike every other path on this endpoint: the
        // archive destination's own rule is that a relative one is ignored and the
        // container-root default answers instead (CR-05). Resolving it here would turn
        // `docs/../x` into a real absolute destination and undo that refusal.
        documentsDirectory: typeof payload.documentsDirectory === "string" ? payload.documentsDirectory : void 0,
        // The user's own overrule of the delivery gate, from the panel's
        // "finish anyway?" confirmation. The tool never sends it: the model's way
        // past the gate is deploying and smoking, never a flag.
        acknowledgeDelivery: payload.acknowledgeDelivery === true,
        // Archiving files content away; the archive preference is the
        // configuration's standing answer for where.
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
      const path = absolutePath(payload.path);
      if (!path) throw coded("E4005", "A task path is required.");
      return deploymentStatus(ctx.subprocess, path, { derive: payload.derive === true, signal });
    });
    if (endpoint === "task.deploy-destroy") return recover(async () => {
      const path = absolutePath(payload.path);
      if (!path) throw coded("E4005", "A task path is required.");
      return destroyDeployment(ctx.subprocess, path, void 0, { signal });
    });
    if (endpoint === "task.deploy-up") return recover(async () => {
      const path = absolutePath(payload.path);
      if (!path) throw coded("E4005", "A task path is required.");
      return deployEnvironment(ctx.subprocess, path, { signal });
    });
    if (endpoint === "task.deploy-smoke") return recover(async () => {
      const path = absolutePath(payload.path);
      if (!path) throw coded("E4005", "A task path is required.");
      return smokeEnvironment(ctx.subprocess, path, { signal });
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
  DEFAULT_IGNORED_SCAN_DIRECTORIES,
  DEFAULT_IGNORED_SCAN_DIRECTORY_SET,
  DEFAULT_SCAN_DEPTH,
  MAX_SCAN_DEPTH,
  MAX_SCAN_DIRECTORIES,
  MAX_SCAN_DIRECTORIES_CEILING,
  MIN_SCAN_DEPTH,
  PUBLIC_ERROR_CODES,
  SCAN_CONCURRENCY,
  apply,
  branchTargets,
  cleanPath,
  configuredArchiveDirectory,
  configuredArchiveStrategy,
  configuredBranchPrefix,
  configuredHandoffEntry,
  configuredHandoffFullAccess,
  configuredTasksRoot,
  detectDefaultBranch,
  discoverGitRoots,
  fail,
  ignoredScanDirectorySet,
  inject,
  name,
  ok,
  parseGitArgv,
  parseWorktrees,
  readClientRequest,
  recover,
  requestedPaths,
  resolveScanDepth,
  runGit,
  topLevelRequestedPaths
};
