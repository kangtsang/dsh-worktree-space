// src/host/index.js
import z from "@deepseek-ai/schemastery";
import { readdir as readdir6, readFile as readFile5, rm as rm3 } from "node:fs/promises";
import { join as join10 } from "node:path";

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
function redact(value) {
  return String(value ?? "").replace(/\/\/[^/\s@]+@/g, "//***@");
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

// src/host/task/git.js
function gitFailureCode(stderr) {
  const text = String(stderr ?? "");
  if (/not a git repository/i.test(text)) return "E3004";
  if (/is not a working tree|No such file or directory/i.test(text)) return "E3005";
  return "E3003";
}
async function runGit(subprocess, cwd, args) {
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
  await recordGitCall({
    cwd,
    args,
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    stdout,
    stderr,
    ms: Date.now() - startedAt
  });
  if (outcome.exitCode !== 0 || outcome.signal !== null) {
    const error = new Error(`git ${args.join(" ")} failed${outcome.signal ? ` (${outcome.signal})` : ` (exit ${outcome.exitCode})`}: ${stderr.trim() || stdout.trim()}`);
    error.code = gitFailureCode(stderr);
    throw error;
  }
  return stdout.trim();
}
async function tryRunGit(subprocess, cwd, args) {
  try {
    return await runGit(subprocess, cwd, args);
  } catch {
    return "";
  }
}
async function gitSucceeded(subprocess, cwd, args) {
  try {
    await runGit(subprocess, cwd, args);
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

// src/host/task/inspect.js
import { existsSync as existsSync2 } from "node:fs";
import { readdir as readdir3 } from "node:fs/promises";
import { basename as basename4, dirname as dirname3, join as join6 } from "node:path";

// src/host/task/container.js
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join as join2 } from "node:path";
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
  if (existsSync(join2(root, ".git"))) {
    throw coded(
      "E1005",
      `the tasks root ${root} is a git repository
  worktree spaces must be filed under a directory that is not one, or every task would be committed into it; put the container beside the repositories instead`
    );
  }
  await mkdir(root, { recursive: true });
  const notice = join2(root, CONTAINER_README);
  if (!existsSync(notice)) await writeFile(notice, CONTAINER_NOTICE, "utf8");
}

// src/host/task/discover.js
import { readdir, stat as stat2 } from "node:fs/promises";
import { basename as basename3, join as join3 } from "node:path";
async function isSourceRepository(directory) {
  try {
    return (await stat2(join3(directory, ".git"))).isDirectory();
  } catch {
    return false;
  }
}
async function discoverSourceRepos(sourceRoot) {
  if (await isSourceRepository(sourceRoot)) return [sourceRoot];
  let entries;
  try {
    entries = await readdir(sourceRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const repositories = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;
    if (entry.name.endsWith(".worktrees")) continue;
    const candidate = join3(sourceRoot, entry.name);
    if (await isSourceRepository(candidate)) repositories.push(candidate);
  }
  return repositories.sort();
}
async function resolveSourceRepos(sourceRoot, names) {
  const selfName = await isSourceRepository(sourceRoot) ? basename3(sourceRoot) : void 0;
  const repositories = [];
  for (const name2 of names) {
    const candidate = name2 === selfName ? sourceRoot : join3(sourceRoot, name2);
    if (!await isSourceRepository(candidate)) throw coded("E6001", `not a source repository: ${name2}`);
    repositories.push(candidate);
  }
  return repositories;
}

// src/host/task/paths.js
import { dirname as dirname2, join as join4, parse, resolve as resolve2 } from "node:path";
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
var CONTAINER_NAME = "worktree-space";
var CONTAINER_BACKUP_NAME = "dsh-worktree-space";
function containerIn(parent, sourceRoot) {
  const preferred = join4(parent, CONTAINER_NAME);
  const swallows = isInside(preferred, sourceRoot) || samePathLocation(preferred, sourceRoot);
  return swallows ? join4(parent, CONTAINER_BACKUP_NAME) : preferred;
}
function firstDirectoryBelowRoot(absolute, root) {
  const parts = absolute.slice(root.length).split(/[\\/]+/).filter(Boolean);
  return parts.length > 1 ? join4(root, parts[0]) : void 0;
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
import { readdir as readdir2, readFile as readFile2, stat as stat3, writeFile as writeFile2 } from "node:fs/promises";
import { join as join5 } from "node:path";
var BREADCRUMB = "README.en.md";
var TASK_METADATA = "worktree-space.json";
var TASK_README = "worktree-space.md";
var TASK_OWNED_FILES = [TASK_METADATA, TASK_README, BREADCRUMB];
async function isLinkedWorktree(directory) {
  try {
    return (await stat3(join5(directory, ".git"))).isFile();
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
  return join5(String(tasksRoot ?? "").trim(), validateProjectName(project), validateTaskName(task));
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
    const worktreePath = join5(taskPath, entry.name);
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
  const { task, project, tasksRoot, sourceRoot, branch, baseRef, repositories = [] } = details;
  return {
    version: 1,
    task,
    project,
    tasksRoot,
    sourceRoot,
    branch,
    baseRef: baseRef === void 0 || `${baseRef}`.trim() === "" ? null : `${baseRef}`,
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
  const text = await readFile2(join5(taskPath, TASK_METADATA), "utf8").catch(() => "");
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
  const text = await readFile2(join5(taskPath, BREADCRUMB), "utf8").catch(() => "");
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
  const { task, project, branch, baseRef, createdAt, sourceRoot, repositories = [] } = metadata;
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
    ""
  ];
  return lines.join("\n");
}
async function writeTaskMetadata(taskPath, metadata) {
  await writeFile2(join5(taskPath, TASK_METADATA), `${JSON.stringify(metadata, null, 2)}
`, "utf8");
  await writeFile2(join5(taskPath, TASK_README), renderTaskMetadata(metadata), "utf8");
}

// src/host/task/inspect.js
async function classifySourceRoot(sourceRoot) {
  const repositories = await discoverSourceRepos(sourceRoot);
  return {
    path: sourceRoot,
    isRepository: await isSourceRepository(sourceRoot),
    isSourceRoot: repositories.length > 0,
    repositoryCount: repositories.length,
    repositories: repositories.map((repoPath) => ({ name: basename4(repoPath), path: repoPath }))
  };
}
async function suggestTaskRoot(subprocess, sourceRoot, { tasksRoot, branchPrefix = DEFAULT_BRANCH_PREFIX, configuredRoot = "" } = {}) {
  const requested = typeof tasksRoot === "string" ? tasksRoot.trim() : "";
  const suggested = resolveTasksRoot(sourceRoot, requested, configuredRoot);
  assertIsolated(sourceRoot, suggested);
  const repositories = await discoverSourceRepos(sourceRoot);
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
    entries = await readdir3(path, { withFileTypes: true });
  } catch {
    return notATask;
  }
  const repositories = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (await isLinkedWorktree(join6(path, entry.name))) repositories.push(entry.name);
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
  if (!existsSync2(root)) return { tasksRoot: root, tasks: [] };
  const projects = await readdir3(root, { withFileTypes: true });
  const tasks = [];
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    if (project.name === CONTAINER_ARCHIVE_FOLDER) continue;
    const projectPath = join6(root, project.name);
    for (const entry of await readdir3(projectPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const taskPath = join6(projectPath, entry.name);
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
import { existsSync as existsSync3 } from "node:fs";
import { mkdir as mkdir2, readdir as readdir4, rm } from "node:fs/promises";
import { basename as basename5, join as join7 } from "node:path";
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
async function rollbackTask(subprocess, taskPath, created) {
  const stranded = [];
  for (const entry of created) {
    if (!await gitSucceeded(subprocess, entry.repoPath, ["worktree", "remove", "--force", entry.path])) {
      stranded.push(entry.name);
    }
  }
  if (stranded.length > 0) return stranded;
  try {
    const leftovers = await readdir4(taskPath);
    if (holdsOnlyOurs(leftovers, created)) await rm(taskPath, { recursive: true, force: true });
  } catch {
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
    configuredRoot = ""
  } = options;
  const name2 = validateTaskName(task);
  const prefix = validateBranchPrefix(branchPrefix);
  const tasksRoot = resolveTasksRoot(sourceRoot, requestedRoot, configuredRoot);
  assertIsolated(sourceRoot, tasksRoot);
  const project = projectNameFor(sourceRoot);
  if (Array.isArray(repos) && repos.length === 0) {
    throw coded("E4001", "select at least one repository for the task");
  }
  const selected = Array.isArray(repos) ? await resolveSourceRepos(sourceRoot, repos) : await discoverSourceRepos(sourceRoot);
  if (selected.length === 0) {
    throw coded(
      "E6001",
      `no source repositories found under ${sourceRoot}: expected a repository, or .git directories in its top-level subdirectories`
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
  if (existsSync3(taskPath)) {
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
  await mkdir2(join7(tasksRoot, project), { recursive: true });
  await mkdir2(taskPath);
  const created = [];
  try {
    for (const repoPath of selected) {
      const worktreePath = join7(taskPath, basename5(repoPath));
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
      repositories: created.map((entry) => ({
        name: entry.name,
        sourcePath: entry.repoPath,
        branch,
        ...entry.sourceBranch === void 0 ? {} : { sourceBranch: entry.sourceBranch },
        ...entry.startCommit === void 0 ? {} : { startCommit: entry.startCommit }
      }))
    }));
  } catch (error) {
    const stranded = await rollbackTask(subprocess, taskPath, created);
    const suffix = stranded.length === 0 ? "" : ` (could not roll back: ${stranded.join(", ")})`;
    await recordError(error, {
      phase: "create",
      // Which of the two outcomes this is, as a code: "rolled back" and "left
      // something behind" call for different amounts of attention, and neither is
      // visible in the message or the stack on its own.
      code: stranded.length === 0 ? "E2005" : "E2006",
      msg: stranded.length === 0 ? "Creating the task space failed. It was rolled back: no worktree, no branch and no task space were left behind, so the same name can be used again." : "Creating the task space failed and the rollback could not remove everything. The leftovers named in `stranded` are still on disk and have to be dealt with by hand.",
      ...created.length === 0 ? {} : { created: created.map((entry) => entry.name) },
      ...stranded.length === 0 ? {} : { stranded }
    });
    throw new Error(`${error.message}${suffix}`);
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

// src/host/task/archive.js
import { existsSync as existsSync4 } from "node:fs";
import { cp, mkdir as mkdir3, mkdtemp, readdir as readdir5, readFile as readFile3, rmdir, rm as rm2 } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename as basename6, join as join8 } from "node:path";
async function mergeInProgress(subprocess, site) {
  return gitSucceeded(subprocess, site, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]);
}
async function conflictedFiles(subprocess, site) {
  const output = await tryRunGit(subprocess, site, ["diff", "--name-only", "--diff-filter=U"]);
  return output.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
}
async function conflictMarkers(subprocess, site) {
  const changed = await tryRunGit(subprocess, site, ["diff", "--name-only", "HEAD"]);
  const listed = [.../* @__PURE__ */ new Set([...changed.split(/\r?\n/), ...await conflictedFiles(subprocess, site)])].map((line) => line.trim()).filter((line) => line !== "");
  const marked = [];
  for (const file of listed) {
    let text = "";
    try {
      text = await readFile3(join8(site, file), "utf8");
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
async function resolveMergeTarget(subprocess, mainRepo, requested, taskBranch) {
  const name2 = basename6(mainRepo);
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
    try {
      await runGit(subprocess, mainRepo, ["merge", "--no-ff", "--no-edit", branch]);
    } catch (error) {
      await gitSucceeded(subprocess, mainRepo, ["merge", "--abort"]);
      throw error;
    }
    return;
  }
  const holder = await mkdtemp(join8(tmpdir(), "dsh-worktree-space-merge-"));
  const worktree = join8(holder, "worktree");
  const drop = async ({ aborted }) => {
    if (aborted) await gitSucceeded(subprocess, worktree, ["merge", "--abort"]);
    if (!await gitSucceeded(subprocess, mainRepo, ["worktree", "remove", "--force", worktree])) {
      await gitSucceeded(subprocess, mainRepo, ["worktree", "prune"]);
    }
    await rm2(holder, { recursive: true, force: true });
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
  if (!existsSync4(taskPath)) throw coded("E2003", `no such task space: ${taskPath}`);
  auditEnter({ task, project: projectName, tasksRoot });
  const entries = await readdir5(taskPath, { withFileTypes: true });
  const worktrees = [];
  const strays = [];
  for (const entry of entries) {
    const entryPath = join8(taskPath, entry.name);
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
  let mergeTarget;
  let changedFiles = 0;
  let commits = 0;
  for (const worktreePath of worktrees) {
    const name2 = basename6(worktreePath);
    const branch = await tryRunGit(subprocess, worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const status = await tryRunGit(subprocess, worktreePath, ["status", "--short", "--branch"]);
    const lines = status === "" ? [] : status.split(/\r?\n/);
    const changed = lines.filter((line) => line !== "" && !line.startsWith("## ")).length;
    const plan = { name: name2, path: worktreePath, mainRepo: "", branch, changedFiles: changed, commits: 0, branches: [] };
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
        plan.commits = Number.parseInt(ahead, 10) || 0;
        mergeTarget = mergeTarget ?? plan.target;
      } catch (error) {
        plan.error = error.message;
      }
    }
    changedFiles += plan.changedFiles;
    commits += plan.commits;
    repositories.push(plan);
  }
  await auditOutcome(repositories, [], "plan");
  return { task, project: projectName, path: taskPath, tasksRoot: tasksRoot.trim(), mergeTarget, changedFiles, commits, repositories, strays };
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
      children = await readdir5(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      seen += 1;
      if (seen > maxEntries) break;
      if (child.isDirectory()) queue.push(join8(current, child.name));
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
    cause
  } = options;
  if (deleteBranch && !merge && !force) {
    throw coded("E4007", "deleting a branch that was never merged requires force");
  }
  if (typeof tasksRoot !== "string" || tasksRoot.trim() === "") throw coded("E1004", "a tasks root is required");
  const projectName = validateProjectName(project);
  const taskPath = taskSpacePath(tasksRoot, projectName, task);
  const destination = typeof documentsDirectory === "string" ? documentsDirectory.trim() : "";
  if (destination !== "") assertIsolated(taskPath, destination);
  if (!existsSync4(taskPath)) throw coded("E2003", `no such task space: ${taskPath}`);
  auditEnter({ task, project: projectName, tasksRoot });
  const entries = await readdir5(taskPath, { withFileTypes: true });
  const worktrees = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const worktreePath = join8(taskPath, entry.name);
    if (await isLinkedWorktree(worktreePath)) worktrees.push(worktreePath);
  }
  if (worktrees.length === 0) throw coded("E2004", `no git worktrees found in ${taskPath}`);
  const repositories = [];
  const warnings = [];
  let failed = false;
  for (const worktreePath of worktrees) {
    const name2 = basename6(worktreePath);
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
        outcome.conflict = true;
        await gitSucceeded(subprocess, mainRepo, ["merge", "--abort"]);
        outcome.error = error.message;
        repositories.push(outcome);
        failed = true;
        continue;
      }
    }
    const removeArgs = force ? ["worktree", "remove", "--force", worktreePath] : ["worktree", "remove", worktreePath];
    if (!await gitSucceeded(subprocess, mainRepo, removeArgs)) {
      outcome.error = "failed to remove the worktree (uncommitted changes? force it deliberately)";
      repositories.push(outcome);
      failed = true;
      continue;
    }
    outcome.removed = true;
    if (deleteBranch) {
      const deleted = await gitSucceeded(
        subprocess,
        mainRepo,
        force ? ["branch", "-D", branch] : ["branch", "-d", branch]
      );
      outcome.branchDeleted = deleted;
      if (!deleted) warnings.push(`branch '${branch}' was not deleted in '${name2}'`);
    }
    repositories.push(outcome);
  }
  for (const name2 of TASK_OWNED_FILES) await rm2(join8(taskPath, name2), { force: true });
  const leftovers = await readdir5(taskPath, { withFileTypes: true });
  const strays = [];
  const content = [];
  for (const entry of leftovers) {
    if (entry.isDirectory() && await isLinkedWorktree(join8(taskPath, entry.name))) continue;
    strays.push(entry.name);
    if (strayKind(entry.name, entry.isDirectory()) === "content") content.push(entry.name);
  }
  const removedStrays = [];
  const archivedStrays = [];
  const keptByFailure = [];
  for (const name2 of content) {
    if (keep.includes(name2)) continue;
    if (destination === "") {
      if (!discardDocuments) continue;
    } else {
      try {
        await mkdir3(destination, { recursive: true });
        await cp(join8(taskPath, name2), join8(destination, name2), { recursive: true, force: false, errorOnExist: true });
      } catch (error) {
        warnings.push(`could not archive '${name2}' to '${destination}': ${error.message}`);
        keptByFailure.push(name2);
        continue;
      }
      archivedStrays.push(name2);
    }
    await rm2(join8(taskPath, name2), { recursive: true, force: true });
    if (destination === "") removedStrays.push(name2);
  }
  if (cleanStray) {
    for (const name2 of strays) {
      if (keep.includes(name2) || keptByFailure.includes(name2)) continue;
      if (archivedStrays.includes(name2) || removedStrays.includes(name2)) continue;
      await rm2(join8(taskPath, name2), { recursive: true, force: true });
      removedStrays.push(name2);
    }
  }
  const remaining = await readdir5(taskPath);
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
import { existsSync as existsSync5, readFileSync } from "node:fs";
import { readFile as readFile4 } from "node:fs/promises";
import { dirname as dirname4, join as join9 } from "node:path";
import { fileURLToPath } from "node:url";
var PROVIDER_NAME = "dsh-worktree-space";
var SKILL_NAME = "task-worktree-space";
var PACKAGE_NAME = "dsh-worktree-space";
var BUNDLED_SKILL_RANK = 600;
var SKILL_FILE = "SKILL.md";
function packageRoot() {
  let directory = dirname4(fileURLToPath(import.meta.url));
  for (; ; ) {
    const manifest = join9(directory, "package.json");
    if (existsSync5(manifest)) {
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
  const directory = join9(packageRoot(), "assets", "skill", SKILL_NAME);
  const skillPath = join9(directory, SKILL_FILE);
  const { description } = parseSkillFile(readFileSync(skillPath, "utf8"), skillPath);
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
      const path = typeof requested?.locator === "string" ? requested.locator : skillPath;
      const raw = await readFile4(path, { encoding: "utf8", signal: options?.signal });
      const loaded = parseSkillFile(raw, path);
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
  "Every repository shares one branch, `task/<task>` unless the user asks for another prefix and it is passed as branchPrefix.",
  "Pass merge only when the user asked to merge, deleteBranch only after a merge or - with force - when the user asked to abandon the task, and force only when the user has decided to discard uncommitted work.",
  "Finishing commits nothing itself: a worktree still holding uncommitted work stops the finish and is named, and the commit is the caller's to make - an agent session opened in the task space writes a better message than a fixed one. force discards that work as the worktree goes.",
  "A repository answered with `mergeInProgress` holds an unresolved merge at `mergeSite`: resolve the files listed in `conflictedFiles` in that checkout, commit the merge there, then call done again with the same merge request to finish. Never resolve a conflict by picking a side the user has not picked.",
  "A merge lands on the branch each source repository has checked out unless another is named; a branch that is checked out nowhere is merged in a worktree of its own, so no source checkout is ever switched."
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
function summarize(action, value) {
  if (action === "suggest-root") {
    const names = value.repositories.map((row) => row.name).join(", ");
    return `Recommended task space for ${value.tasksRoot === "" ? "the source root" : value.tasksRoot}: ${value.suggested}. ${value.repositories.length} source repositor${value.repositories.length === 1 ? "y" : "ies"}${names === "" ? "" : `: ${names}`}.`;
  }
  if (action === "create") {
    const names = value.repositories.map((row) => row.name).join(", ");
    return `Task '${value.task}' is ready at ${value.container} on branch '${value.branch}', with worktrees of: ${names}.${value.warnings.length === 0 ? "" : ` Warnings: ${value.warnings.join("; ")}.`}`;
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
  return tools.register(defineTool({
    name: "task_worktree_space",
    description: DESCRIPTION,
    parameters: {
      action: {
        type: "string",
        required: true,
        enum: ["suggest-root", "create", "list", "done"],
        description: "suggest-root, create, list, or done."
      },
      task: { type: "string", description: "Name (create, done): the task space directory and branch suffix, with no separators or spaces." },
      project: { type: "string", description: "Project layer (list, done): the source root's own directory name. Omit when sourceRoot is given, since it is derived from it." },
      sourceRoot: { type: "string", description: "Directory of the repositories. Required for suggest-root and create." },
      tasksRoot: { type: "string", description: "Container for task spaces: beside the repositories' directory, never inside it or a parent of it. Omit for the recommendation." },
      repos: { type: "array", items: { type: "string" }, description: "Repository names (create). Omit for all discovered." },
      baseRef: { type: "string", description: "Start point (create). Omit for each repository HEAD." },
      branchPrefix: { type: "string", description: "Branch prefix (create, suggest-root): the branch is this plus the task name. Omit for the default task/." },
      merge: { type: "boolean", description: "Merge before removing the worktrees (done). Only on request." },
      target: { type: "string", description: "Branch to merge into (done), for every repository. Omit for the branch each source repository has checked out." },
      deleteBranch: { type: "boolean", description: "Delete each branch (done). Needs merge, or force to delete a branch that was never merged and abandon its commits." },
      cleanStray: { type: "boolean", description: "Remove leftovers in the task space (done), except keep. Off by default." },
      keep: { type: "array", items: { type: "string" }, description: "Entries to keep with cleanStray (done)." },
      force: { type: "boolean", description: "Discard uncommitted changes, force-delete branches (done). Only on the user decision." }
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
          configuredRoot: configuredRoot()
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
          keep: Array.isArray(args.keep) ? args.keep : []
        });
        const value = envelope(action);
        value.task = task;
        value.project = project;
        value.container = result.containerRemoved ? "" : result.path;
        value.tasksRoot = tasksRoot;
        value.failed = result.failed;
        value.warnings = result.warnings;
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
var TASK_ENDPOINTS = ["task.classify-root", "task.suggest-root", "task.create", "task.list", "task.inspect", "task.plan", "task.done", "task.preference"];
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
  "E5001",
  "E5002",
  "E5003",
  "E6001",
  "E6002",
  "E7001",
  "E7002",
  "E7003",
  "E7004",
  "E7005",
  "E7006",
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
var IGNORED_SCAN_DIRECTORIES = /* @__PURE__ */ new Set(["node_modules", "Library", "dist", "build", "vendor"]);
var MIN_SCAN_DEPTH = 1;
var MAX_SCAN_DEPTH = 5;
var DEFAULT_SCAN_DEPTH = 2;
var MAX_SCAN_DIRECTORIES = 1e3;
var scanBounds = { depth: DEFAULT_SCAN_DEPTH, directories: MAX_SCAN_DIRECTORIES };
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
function resolveScanDepth(value) {
  if (value === void 0 || value === null || value === "") return DEFAULT_SCAN_DEPTH;
  const depth = Math.trunc(Number(value));
  if (!Number.isFinite(depth)) return DEFAULT_SCAN_DEPTH;
  return Math.min(MAX_SCAN_DEPTH, Math.max(MIN_SCAN_DEPTH, depth));
}
async function discoverGitRoots(rootPath, { signal, maxDepth = DEFAULT_SCAN_DEPTH, maxDirectories = MAX_SCAN_DIRECTORIES } = {}) {
  const roots = [];
  const queue = [{ path: cleanPath2(rootPath), depth: 0 }];
  let inspected = 0;
  for (let cursor = 0; cursor < queue.length; ) {
    signal?.throwIfAborted();
    const batch = queue.slice(cursor, cursor + 8);
    cursor += batch.length;
    inspected += batch.length;
    if (inspected > maxDirectories) throw coded("E4006", "Worktree scan limit reached; choose a more specific Workspace.");
    await Promise.all(batch.map(async ({ path, depth }) => {
      signal?.throwIfAborted();
      let entries;
      try {
        entries = await readdir6(path, { withFileTypes: true });
      } catch {
        return;
      }
      if (entries.some((entry) => entry.name === ".git")) {
        roots.push(path);
        return;
      }
      if (depth >= maxDepth) return;
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || IGNORED_SCAN_DIRECTORIES.has(entry.name)) continue;
        if (entry.name.startsWith(".") && entry.name !== ".worktrees") continue;
        queue.push({ path: join10(path, entry.name), depth: depth + 1 });
      }
    }));
  }
  return roots;
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
function apply(ctx, config = {}) {
  scanBounds.depth = resolveScanDepth(config.scanDepth);
  if (Number.isFinite(Number(config.maxScanDirectories))) {
    scanBounds.directories = Math.max(1, Math.trunc(Number(config.maxScanDirectories)));
  }
  branchPrefixReference = config.defaultBranchPrefix;
  archiveDirectoryReference = config.archiveDocumentsDirectory;
  archiveStrategyReference = config.archiveDocumentsStrategy;
  handoffEntryReference = config.handoffEntry;
  tasksRootStrategyReference = config.tasksRootStrategy;
  tasksRootDirectoryReference = config.tasksRootDirectory;
  setAuditEnabledReader(() => settingValue(config.auditLog) !== "off");
  if (typeof ctx.inject === "function") {
    ctx.inject(["tools"], (toolsCtx) => registerTaskTool(toolsCtx, { configuredRoot: configuredTasksRoot }));
  } else {
    registerTaskTool(ctx, { configuredRoot: configuredTasksRoot });
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
      const [topLevel, commonDir, porcelain] = await Promise.all([
        runGit(ctx.subprocess, path, ["rev-parse", "--show-toplevel"]),
        runGit(ctx.subprocess, path, ["rev-parse", "--git-common-dir"]),
        runGit(ctx.subprocess, path, ["worktree", "list", "--porcelain"])
      ]);
      const worktrees = parseWorktrees(porcelain);
      const repoPath = worktrees.find((worktree) => worktree.isMain)?.path ?? topLevel;
      const defaultBranch = await detectDefaultBranch(ctx.subprocess, repoPath, worktrees);
      return { repoPath, commonDir, defaultBranch: defaultBranch.name, defaultRef: defaultBranch.ref, worktrees };
    };
    if (endpoint === "worktree.scan") return recover(async () => {
      const paths = requestedPaths(payload);
      const maxDepth = resolveScanDepth(payload.depth ?? scanBounds.depth);
      const roots = [...new Set((await Promise.all([...new Set(paths)].map((path) => discoverGitRoots(path, { signal, maxDepth, maxDirectories: scanBounds.directories })))).flat())];
      const seen = /* @__PURE__ */ new Set();
      const repositories = [];
      for (const root of roots) {
        signal?.throwIfAborted();
        try {
          const repository = await listRepository(root);
          const key = cleanPath2(repository.repoPath);
          if (key && !seen.has(key)) {
            seen.add(key);
            repositories.push(repository);
          }
        } catch {
        }
      }
      rememberScan(paths, repositories);
      return repositories;
    });
    if (endpoint === "worktree.cached") return recover(async () => {
      return recallScan(requestedPaths(payload)) ?? null;
    });
    if (endpoint === "worktree.status") return recover(async () => {
      const path = typeof payload.path === "string" ? payload.path.trim() : "";
      if (!path) throw coded("E4005", "Worktree path is required.");
      const output = await runGit(ctx.subprocess, path, ["status", "--short", "--branch"]);
      const lines = output ? output.split(/\r?\n/) : [];
      const target = typeof payload.target === "string" ? payload.target.trim() : "";
      const ahead = target === "" ? "" : await tryRunGit(ctx.subprocess, path, ["rev-list", "--count", `${target}..HEAD`]);
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
      return classifySourceRoot(sourceRoot);
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
        configuredRoot: configuredTasksRoot()
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
        configuredRoot: configuredTasksRoot()
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
        // Why the dialog is finishing a task it never told the user existed. The
        // rollback after a create whose Workspace would not register goes through
        // this endpoint like any other, so without this the log would show the
        // worktrees and the branch being deleted and never say that the reason
        // was a create that had already half succeeded.
        cause: typeof payload.cause === "string" && payload.cause.trim() !== "" ? payload.cause.trim() : void 0
      });
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
  DEFAULT_SCAN_DEPTH,
  MAX_SCAN_DEPTH,
  MAX_SCAN_DIRECTORIES,
  MIN_SCAN_DEPTH,
  PUBLIC_ERROR_CODES,
  apply,
  branchTargets,
  cleanPath2 as cleanPath,
  configuredArchiveDirectory,
  configuredArchiveStrategy,
  configuredBranchPrefix,
  configuredHandoffEntry,
  configuredTasksRoot,
  detectDefaultBranch,
  discoverGitRoots,
  fail,
  inject,
  name,
  ok,
  parseWorktrees,
  readClientRequest,
  recover,
  requestedPaths,
  resolveScanDepth,
  runGit
};
