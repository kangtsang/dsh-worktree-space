// src/host/index.js
import z from "@deepseek-ai/schemastery";
import { clientRequestSchema } from "@deepseek-ai/dsh-client-connection";
import { readdir as readdir6, readFile as readFile6, rm as rm5 } from "node:fs/promises";
import { join as join8 } from "node:path";

// src/host/task/git.js
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
  const outcome = await handle.done;
  const stdout = handle.collected.stdout?.readFrom(0).text ?? "";
  const stderr = handle.collected.stderr?.readFrom(0).text ?? "";
  if (outcome.exitCode !== 0 || outcome.signal !== null) {
    throw new Error(`git ${args.join(" ")} failed${outcome.signal ? ` (${outcome.signal})` : ` (exit ${outcome.exitCode})`}: ${stderr.trim() || stdout.trim()}`);
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

// src/host/task/inspect.js
import { existsSync as existsSync4 } from "node:fs";
import { cp as cp4, mkdir as mkdir4, readdir as readdir5, readFile as readFile4, rmdir as rmdir4, rm as rm4, stat as stat5, writeFile as writeFile4 } from "node:fs/promises";
import { basename as basename4, dirname as dirname5, join as join6 } from "node:path";

// src/host/task/discover.js
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
async function isSourceRepository(directory) {
  try {
    return (await stat(join(directory, ".git"))).isDirectory();
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
    const candidate = join(sourceRoot, entry.name);
    if (await isSourceRepository(candidate)) repositories.push(candidate);
  }
  return repositories.sort();
}
async function resolveSourceRepos(sourceRoot, names) {
  const repositories = [];
  for (const name2 of names) {
    const candidate = join(sourceRoot, name2);
    if (!await isSourceRepository(candidate)) throw new Error(`not a source repository: ${name2}`);
    repositories.push(candidate);
  }
  return repositories;
}

// src/host/task/naming.js
var DEFAULT_BRANCH_PREFIX = "feat/";
var TaskNameError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "TaskNameError";
  }
};
var FORBIDDEN = /[/\\\s]/;
function validateTaskName(task) {
  const name2 = String(task ?? "");
  if (name2 === "") throw new TaskNameError("a task name is required");
  if (FORBIDDEN.test(name2)) {
    throw new TaskNameError(`task name must not contain /, \\ or whitespace: ${name2}`);
  }
  return name2;
}
function branchNameFor(task, prefix = DEFAULT_BRANCH_PREFIX) {
  return `${prefix}${task}`;
}

// src/host/task/paths.js
import { existsSync } from "node:fs";
import { dirname, join as join2, parse, resolve } from "node:path";
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
  constructor(message) {
    super(message);
    this.name = "IsolationError";
  }
};
function assertIsolated(sourceRoot, tasksRoot) {
  if (samePathLocation(sourceRoot, tasksRoot)) {
    throw new IsolationError(`tasks root must not be the source root itself: ${sourceRoot}`);
  }
  if (isInside(sourceRoot, tasksRoot)) {
    throw new IsolationError(
      `tasks root is inside the source root: ${tasksRoot}
  work and source must be isolated; pick a location outside the source tree`
    );
  }
  if (isInside(tasksRoot, sourceRoot)) {
    throw new IsolationError(
      `source root is inside the tasks root: ${tasksRoot}
  work and source must be isolated; pick a location outside the source tree`
    );
  }
}
function chooseTasksRoot(driveRoot, fallbackParent, exists) {
  if (driveRoot === void 0) return join2(fallbackParent, "worktree-space");
  const workspace = join2(driveRoot, "workspace");
  return exists(workspace) ? join2(driveRoot, "worktree-space") : workspace;
}
function recommendTasksRoot(sourceRoot, { exists = existsSync } = {}) {
  const absolute = resolve(sourceRoot);
  const { root } = parse(absolute);
  const driveRoot = /^[A-Za-z]:[\\/]$/.test(root) ? root : void 0;
  const candidate = chooseTasksRoot(driveRoot, dirname(absolute), exists);
  if (isInside(candidate, absolute) || samePathLocation(candidate, absolute)) {
    return join2(dirname(absolute), "worktree-space");
  }
  return candidate;
}

// src/host/task/create.js
import { existsSync as existsSync3 } from "node:fs";
import { cp as cp3, mkdir as mkdir3, readdir as readdir4, readFile as readFile3, rmdir as rmdir3, rm as rm3, stat as stat4, writeFile as writeFile3 } from "node:fs/promises";
import { basename as basename3, dirname as dirname4, join as join5 } from "node:path";

// src/host/task/archive.js
import { existsSync as existsSync2 } from "node:fs";
import { cp, mkdir, readdir as readdir2, readFile, rmdir, rm, stat as stat2, writeFile } from "node:fs/promises";
import { basename, dirname as dirname2, join as join3 } from "node:path";
async function resolveMergeTarget(subprocess, mainRepo, requested) {
  const explicit = typeof requested === "string" ? requested.trim() : "";
  if (explicit !== "") {
    if (!await gitSucceeded(subprocess, mainRepo, ["show-ref", "--verify", "--quiet", `refs/heads/${explicit}`])) {
      throw new Error(`merge target '${explicit}' is not a local branch of '${basename(mainRepo)}'`);
    }
    return explicit;
  }
  const remoteHead = await tryRunGit(subprocess, mainRepo, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  if (remoteHead !== "") {
    const derived = remoteHead.replace(/^refs\/remotes\/[^/]+\//, "");
    if (await gitSucceeded(subprocess, mainRepo, ["show-ref", "--verify", "--quiet", `refs/heads/${derived}`])) {
      return derived;
    }
  }
  for (const candidate of MERGE_TARGET_CANDIDATES) {
    if (await gitSucceeded(subprocess, mainRepo, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`])) {
      return candidate;
    }
  }
  throw new Error(`cannot determine the merge target of '${basename(mainRepo)}' (tried origin/HEAD, main, master); name one explicitly`);
}
async function planTask(subprocess, { task, tasksRoot } = {}) {
  if (typeof tasksRoot !== "string" || tasksRoot.trim() === "") throw new Error("a tasks root is required");
  const taskPath = join3(tasksRoot.trim(), validateTaskName(task));
  if (!existsSync2(taskPath)) throw new Error(`no such task space: ${taskPath}`);
  const entries = await readdir2(taskPath, { withFileTypes: true });
  const worktrees = [];
  const strays = [];
  for (const entry of entries) {
    const entryPath = join3(taskPath, entry.name);
    if (entry.isDirectory() && await isLinkedWorktree(entryPath)) {
      worktrees.push(entryPath);
      continue;
    }
    if (entry.name === BREADCRUMB) continue;
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
  if (worktrees.length === 0) throw new Error(`no git worktrees found in ${taskPath}`);
  const repositories = [];
  let mergeTarget;
  let changedFiles = 0;
  let commits = 0;
  for (const worktreePath of worktrees) {
    const name2 = basename(worktreePath);
    const branch = await tryRunGit(subprocess, worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const status = await tryRunGit(subprocess, worktreePath, ["status", "--short", "--branch"]);
    const lines = status === "" ? [] : status.split(/\r?\n/);
    const changed = lines.filter((line) => line !== "" && !line.startsWith("## ")).length;
    const plan = { name: name2, path: worktreePath, branch, changedFiles: changed, commits: 0 };
    const porcelain = await tryRunGit(subprocess, worktreePath, ["worktree", "list", "--porcelain"]);
    const mainRepo = parseWorktrees(porcelain).find((row) => row.isMain)?.path ?? "";
    if (mainRepo === "") plan.error = "cannot locate the source repository";
    else {
      try {
        plan.target = await resolveMergeTarget(subprocess, mainRepo, void 0);
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
  return { task, path: taskPath, tasksRoot: tasksRoot.trim(), mergeTarget, changedFiles, commits, repositories, strays };
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
      children = await readdir2(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      seen += 1;
      if (seen > maxEntries) break;
      if (child.isDirectory()) queue.push(join3(current, child.name));
      else if (isDocument(child.name)) found += 1;
    }
  }
  return found;
}
async function finishTask(subprocess, options) {
  const {
    task,
    tasksRoot,
    merge = false,
    target,
    deleteBranch = false,
    force = false,
    cleanStray = false,
    keep = [],
    documentsDirectory,
    discardDocuments = false
  } = options;
  if (deleteBranch && !merge) {
    throw new Error("deleting a branch requires merging it first");
  }
  if (typeof tasksRoot !== "string" || tasksRoot.trim() === "") throw new Error("a tasks root is required");
  const destination = typeof documentsDirectory === "string" ? documentsDirectory.trim() : "";
  if (destination !== "") assertIsolated(join3(tasksRoot.trim(), validateTaskName(task)), destination);
  const taskPath = join3(tasksRoot.trim(), validateTaskName(task));
  if (!existsSync2(taskPath)) throw new Error(`no such task space: ${taskPath}`);
  const entries = await readdir2(taskPath, { withFileTypes: true });
  const worktrees = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const worktreePath = join3(taskPath, entry.name);
    if (await isLinkedWorktree(worktreePath)) worktrees.push(worktreePath);
  }
  if (worktrees.length === 0) throw new Error(`no git worktrees found in ${taskPath}`);
  const repositories = [];
  const warnings = [];
  let failed = false;
  for (const worktreePath of worktrees) {
    const name2 = basename(worktreePath);
    const branch = await tryRunGit(subprocess, worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const porcelain = await tryRunGit(subprocess, worktreePath, ["worktree", "list", "--porcelain"]);
    const mainRepo = parseWorktrees(porcelain).find((row) => row.isMain)?.path ?? "";
    if (mainRepo === "") {
      repositories.push({ name: name2, path: worktreePath, branch, merged: false, removed: false, branchDeleted: false, error: "cannot locate the source repository" });
      failed = true;
      continue;
    }
    const outcome = { name: name2, path: worktreePath, branch, merged: false, removed: false, branchDeleted: false };
    if (merge) {
      try {
        const mergeTarget = await resolveMergeTarget(subprocess, mainRepo, target);
        outcome.target = mergeTarget;
        await runGit(subprocess, mainRepo, ["merge", "--no-ff", "--no-edit", branch]);
        outcome.merged = true;
      } catch (error) {
        await gitSucceeded(subprocess, mainRepo, ["merge", "--abort"]);
        outcome.error = `${error.message}; worktree and branch kept`;
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
  await rm(join3(taskPath, BREADCRUMB), { force: true });
  const leftovers = await readdir2(taskPath, { withFileTypes: true });
  const strays = [];
  const content = [];
  for (const entry of leftovers) {
    if (entry.isDirectory() && await isLinkedWorktree(join3(taskPath, entry.name))) continue;
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
        await mkdir(destination, { recursive: true });
        await cp(join3(taskPath, name2), join3(destination, name2), { recursive: true, force: false, errorOnExist: true });
      } catch (error) {
        warnings.push(`could not archive '${name2}' to '${destination}': ${error.message}`);
        keptByFailure.push(name2);
        continue;
      }
      archivedStrays.push(name2);
    }
    await rm(join3(taskPath, name2), { recursive: true, force: true });
    if (destination === "") removedStrays.push(name2);
  }
  if (cleanStray) {
    for (const name2 of strays) {
      if (keep.includes(name2) || keptByFailure.includes(name2)) continue;
      if (archivedStrays.includes(name2) || removedStrays.includes(name2)) continue;
      await rm(join3(taskPath, name2), { recursive: true, force: true });
      removedStrays.push(name2);
    }
  }
  const remaining = await readdir2(taskPath);
  let containerRemoved = false;
  if (remaining.length === 0) {
    containerRemoved = true;
    try {
      await rmdir(taskPath);
    } catch {
      containerRemoved = false;
    }
  }
  return {
    task,
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

// src/host/task/shared.js
import { cp as cp2, mkdir as mkdir2, readdir as readdir3, readFile as readFile2, rmdir as rmdir2, rm as rm2, stat as stat3, writeFile as writeFile2 } from "node:fs/promises";
import { basename as basename2, dirname as dirname3, join as join4 } from "node:path";
var BREADCRUMB = "README.md";
var MERGE_TARGET_CANDIDATES = ["main", "master"];
async function isLinkedWorktree(directory) {
  try {
    return (await stat3(join4(directory, ".git"))).isFile();
  } catch {
    return false;
  }
}
function resolveTasksRoot(sourceRoot, requestedRoot) {
  const requested = typeof requestedRoot === "string" ? requestedRoot.trim() : "";
  return requested === "" ? recommendTasksRoot(sourceRoot) : requested;
}
async function listTaskWorktrees(subprocess, taskPath) {
  let entries;
  try {
    entries = await readdir3(taskPath, { withFileTypes: true });
  } catch {
    return [];
  }
  const repositories = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const worktreePath = join4(taskPath, entry.name);
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

// src/host/task/create.js
function breadcrumb(details) {
  const { task, branch, baseRef, sourceRoot, repositories } = details;
  return [
    `# Task: ${task}`,
    "",
    `- Branch: \`${branch}\` (one branch per repository below)`,
    `- Base: ${baseRef === void 0 ? "each repository's current HEAD" : `\`${baseRef}\``}`,
    `- Created: ${(/* @__PURE__ */ new Date()).toISOString()}`,
    `- Source root: \`${sourceRoot}\``,
    "- This folder is the agent session working directory.",
    "",
    "## Repositories",
    ...repositories.map((name2) => `- \`${name2}\``),
    "",
    "## Conventions",
    "- Commit in each repository separately (the same branch name everywhere).",
    "- Source repositories are read-only: never edit or commit there.",
    "- Merging back to the main branch is the user's action, not the agent's.",
    ""
  ].join("\n");
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
    const ours = leftovers.every((name2) => name2 === BREADCRUMB || created.some((entry) => basename3(entry.path) === name2));
    if (ours) await rm3(taskPath, { recursive: true, force: true });
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
    push = false
  } = options;
  const name2 = validateTaskName(task);
  const tasksRoot = resolveTasksRoot(sourceRoot, requestedRoot);
  assertIsolated(sourceRoot, tasksRoot);
  if (Array.isArray(repos) && repos.length === 0) {
    throw new Error("select at least one repository for the task");
  }
  const selected = Array.isArray(repos) ? await resolveSourceRepos(sourceRoot, repos) : await discoverSourceRepos(sourceRoot);
  if (selected.length === 0) {
    throw new Error(
      `no source repositories found under ${sourceRoot}: expected a repository, or .git directories in its top-level subdirectories`
    );
  }
  const names = selected.map((repoPath) => basename3(repoPath));
  const duplicate = names.find((entry, index) => names.indexOf(entry) !== index);
  if (duplicate !== void 0) {
    throw new Error(`two selected repositories are both named '${duplicate}'; select repositories with distinct names`);
  }
  const branch = branchNameFor(name2, branchPrefix);
  const taskPath = join5(tasksRoot, name2);
  if (existsSync3(taskPath)) throw new Error(`task space already exists: ${taskPath}`);
  for (const repoPath of selected) {
    if (await gitSucceeded(subprocess, repoPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])) {
      throw new Error(`branch '${branch}' already exists in '${basename3(repoPath)}'; pick another task name`);
    }
  }
  if (baseRef !== void 0 && `${baseRef}`.trim() !== "") {
    for (const repoPath of selected) {
      if (!await gitSucceeded(subprocess, repoPath, ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`])) {
        throw new Error(`base '${baseRef}' not found in '${basename3(repoPath)}'`);
      }
    }
  }
  await mkdir3(tasksRoot, { recursive: true });
  await mkdir3(taskPath);
  const created = [];
  const warnings = [];
  try {
    for (const repoPath of selected) {
      const worktreePath = join5(taskPath, basename3(repoPath));
      const args = baseRef === void 0 || `${baseRef}`.trim() === "" ? ["worktree", "add", worktreePath, "-b", branch] : ["worktree", "add", worktreePath, "-b", branch, `${baseRef}`];
      await runGit(subprocess, repoPath, args);
      created.push({ name: basename3(repoPath), path: worktreePath, repoPath });
    }
    if (push) {
      for (const entry of created) {
        if (!await gitSucceeded(subprocess, entry.repoPath, ["push", "-u", "origin", branch])) {
          warnings.push(`push to origin failed for '${entry.name}'; the branch is kept locally`);
        }
      }
    }
    await writeFile3(
      join5(taskPath, BREADCRUMB),
      breadcrumb({ task: name2, branch, baseRef: baseRef === void 0 || `${baseRef}`.trim() === "" ? void 0 : `${baseRef}`, sourceRoot, repositories: created.map((entry) => entry.name) }),
      "utf8"
    );
  } catch (error) {
    const stranded = await rollbackTask(subprocess, taskPath, created);
    const suffix = stranded.length === 0 ? "" : ` (could not roll back: ${stranded.join(", ")})`;
    throw new Error(`${error.message}${suffix}`);
  }
  return {
    task: name2,
    branch,
    path: taskPath,
    tasksRoot,
    baseRef: baseRef === void 0 || `${baseRef}`.trim() === "" ? void 0 : `${baseRef}`,
    repositories: created.map((entry) => ({ name: entry.name, path: entry.path })),
    warnings
  };
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
async function suggestTaskRoot(sourceRoot, { tasksRoot, branchPrefix = DEFAULT_BRANCH_PREFIX } = {}) {
  const requested = typeof tasksRoot === "string" ? tasksRoot.trim() : "";
  const suggested = resolveTasksRoot(sourceRoot, requested);
  assertIsolated(sourceRoot, suggested);
  const repositories = await discoverSourceRepos(sourceRoot);
  return {
    sourceRoot,
    suggested,
    explicit: requested !== "",
    branchPrefix,
    repositories: repositories.map((repoPath) => ({ name: basename4(repoPath), path: repoPath }))
  };
}
function parseBreadcrumb(text) {
  const source = String(text ?? "");
  const task = /^# Task:\s*(.+)$/m.exec(source)?.[1]?.trim();
  if (task === void 0 || task === "") return void 0;
  const branch = /^-\s*Branch:\s*`([^`]+)`/m.exec(source)?.[1]?.trim();
  const sourceRoot = /^-\s*Source root:\s*`([^`]+)`/m.exec(source)?.[1]?.trim();
  return {
    task,
    ...branch === void 0 || branch === "" ? {} : { branch },
    ...sourceRoot === void 0 || sourceRoot === "" ? {} : { sourceRoot }
  };
}
async function inspectTask(taskPath) {
  const path = String(taskPath ?? "").trim();
  const name2 = basename4(path);
  const notATask = { path, isTask: false, task: name2, tasksRoot: dirname5(path), repositories: [] };
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
    if (await isLinkedWorktree(join6(path, entry.name))) repositories.push(entry.name);
  }
  const details = parseBreadcrumb(await readFile4(join6(path, BREADCRUMB), "utf8").catch(() => ""));
  if (details === void 0 && repositories.length === 0) return notATask;
  return {
    path,
    isTask: true,
    task: details?.task ?? name2,
    tasksRoot: dirname5(path),
    ...details?.branch === void 0 ? {} : { branch: details.branch },
    ...details?.sourceRoot === void 0 ? {} : { sourceRoot: details.sourceRoot },
    repositories: repositories.sort()
  };
}
async function listTasks(subprocess, { tasksRoot } = {}) {
  if (typeof tasksRoot !== "string" || tasksRoot.trim() === "") throw new Error("a tasks root is required");
  const root = tasksRoot.trim();
  if (!existsSync4(root)) return { tasksRoot: root, tasks: [] };
  const entries = await readdir5(root, { withFileTypes: true });
  const tasks = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const taskPath = join6(root, entry.name);
    tasks.push({ name: entry.name, path: taskPath, repositories: await listTaskWorktrees(subprocess, taskPath) });
  }
  tasks.sort((left, right) => left.name.localeCompare(right.name));
  return { tasksRoot: root, tasks };
}

// src/host/task/skill.js
import { existsSync as existsSync5, readFileSync } from "node:fs";
import { readFile as readFile5 } from "node:fs/promises";
import { dirname as dirname6, join as join7 } from "node:path";
import { fileURLToPath } from "node:url";
var PROVIDER_NAME = "dsh-worktree-space";
var SKILL_NAME = "task-worktree-space";
var PACKAGE_NAME = "dsh-worktree-space";
var BUNDLED_SKILL_RANK = 600;
var SKILL_FILE = "SKILL.md";
function packageRoot() {
  let directory = dirname6(fileURLToPath(import.meta.url));
  for (; ; ) {
    const manifest = join7(directory, "package.json");
    if (existsSync5(manifest)) {
      try {
        if (JSON.parse(readFileSync(manifest, "utf8")).name === PACKAGE_NAME) return directory;
      } catch {
      }
    }
    const parent = dirname6(directory);
    if (parent === directory) {
      throw new Error(`${PACKAGE_NAME}: cannot locate the package root for the bundled skill`);
    }
    directory = parent;
  }
}
function parseSkillFile(raw, path) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw);
  if (frontmatter?.[1] === void 0) throw new Error(`${PACKAGE_NAME}: ${path} has no YAML frontmatter`);
  const description = /^description:[ \t]*(.+?)[ \t]*$/mu.exec(frontmatter[1])?.[1];
  const declared = /^name:[ \t]*(.+?)[ \t]*$/mu.exec(frontmatter[1])?.[1];
  if (description === void 0 || description === "") throw new Error(`${PACKAGE_NAME}: ${path} has no description`);
  if (declared !== SKILL_NAME) {
    throw new Error(`${PACKAGE_NAME}: ${path} declares name '${declared}' where '${SKILL_NAME}' is served`);
  }
  return { description, content: raw.slice(frontmatter[0].length).trim() };
}
function registerTaskSkill(ctx) {
  if (typeof ctx.get !== "function") return void 0;
  const skills = ctx.get("skills");
  if (skills === void 0 || skills === null || typeof skills.registerProvider !== "function") return void 0;
  const directory = join7(packageRoot(), "assets", "skill", SKILL_NAME);
  const skillPath = join7(directory, SKILL_FILE);
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
      const raw = await readFile5(path, { encoding: "utf8", signal: options?.signal });
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
  "Create, list and finish a per-task Git worktree workspace that spans one or more repositories: one directory outside the source tree holding a worktree of every selected repository, all on one branch.",
  "",
  "Drive it in order: suggest-root, then create, then list, then done. Ask the user for the task name and the task space location before creating anything.",
  "Pass merge only when the user asked to merge, deleteBranch only after a merge, and force only when the user has decided to discard uncommitted work."
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
  if (text === "") throw new Error(`${name2} is required for this action`);
  return text;
}
async function containerFor(tasksRoot, sourceRoot) {
  const explicit = typeof tasksRoot === "string" ? tasksRoot.trim() : "";
  if (explicit !== "") return explicit;
  const source = typeof sourceRoot === "string" ? sourceRoot.trim() : "";
  if (source === "") throw new Error("tasksRoot is required (or sourceRoot, to use its recommended task space)");
  return (await suggestTaskRoot(source)).suggested;
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
  return `Task '${value.task}' finished. Task space ${value.container === "" ? "removed" : `kept at ${value.container}`}.${failed}${attention}${value.warnings.length === 0 ? "" : ` Warnings: ${value.warnings.join("; ")}.`}`;
}
function registerTaskTool(ctx) {
  if (typeof ctx.get !== "function") return void 0;
  const tools = ctx.get("tools");
  if (tools === void 0 || tools === null || typeof tools.register !== "function") return void 0;
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
      sourceRoot: { type: "string", description: "Directory of the repositories. Required for suggest-root and create." },
      tasksRoot: { type: "string", description: "Container root, outside the source tree. Omit for the recommendation." },
      repos: { type: "array", items: { type: "string" }, description: "Repository names (create). Omit for all discovered." },
      baseRef: { type: "string", description: "Start point (create). Omit for each repository HEAD." },
      merge: { type: "boolean", description: "Merge before removing the worktrees (done). Only on request." },
      target: { type: "string", description: "Branch to merge into (done). Omit to detect origin/HEAD, main, master." },
      deleteBranch: { type: "boolean", description: "Delete each branch after a merge (done). Needs merge." },
      cleanStray: { type: "boolean", description: "Remove leftovers in the task space (done), except keep. Off by default." },
      keep: { type: "array", items: { type: "string" }, description: "Entries to keep with cleanStray (done)." },
      force: { type: "boolean", description: "Discard uncommitted changes, force-delete branches (done). Only on the user decision." }
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: "text", text: value.summary }]
    },
    async execute(args) {
      const action = args.action;
      if (action === "suggest-root") {
        const sourceRoot = required(args.sourceRoot, "sourceRoot");
        const result = await suggestTaskRoot(sourceRoot, { tasksRoot: args.tasksRoot });
        const value = envelope(action);
        value.tasksRoot = result.sourceRoot;
        value.suggested = result.suggested;
        value.repositories = result.repositories.map((entry) => ({ ...emptyRow(entry.name), path: entry.path }));
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
          push: false
        });
        const value = envelope(action);
        value.task = result.task;
        value.branch = result.branch;
        value.container = result.path;
        value.tasksRoot = result.tasksRoot;
        value.warnings = result.warnings;
        value.repositories = result.repositories.map((entry) => ({ ...emptyRow(entry.name), path: entry.path, branch: result.branch }));
        value.summary = summarize(action, value);
        return value;
      }
      if (action === "list") {
        const tasksRoot = await containerFor(args.tasksRoot, args.sourceRoot);
        const result = await listTasks(ctx.subprocess, { tasksRoot });
        const value = envelope(action);
        value.tasksRoot = result.tasksRoot;
        for (const task of result.tasks) {
          if (task.repositories.length === 0) {
            value.repositories.push({ ...emptyRow(task.name), path: task.path });
            continue;
          }
          for (const repository of task.repositories) {
            value.repositories.push({
              ...emptyRow(`${task.name}/${repository.name}`),
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
        const tasksRoot = await containerFor(args.tasksRoot, args.sourceRoot);
        const result = await finishTask(ctx.subprocess, {
          task,
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
          error: entry.error ?? ""
        }));
        value.summary = summarize(action, value);
        return value;
      }
      throw new Error(`unknown action: ${action}`);
    },
    presentCall: (args) => ({
      card: "generic",
      title: `task_worktree_space: ${args.action}`,
      kind: "other",
      rawInput: args
    })
  }));
}

// src/host/index.js
var API_PREFIX = "/api/dsh-worktree-space";
var WORKTREE_ENDPOINTS = ["worktree.scan", "worktree.status"];
var TASK_ENDPOINTS = ["task.classify-root", "task.suggest-root", "task.create", "task.list", "task.inspect", "task.plan", "task.done"];
var ENDPOINTS = [...WORKTREE_ENDPOINTS, ...TASK_ENDPOINTS];
var ok = (value) => ({ ok: true, value });
var PUBLIC_ERROR_CODES = /* @__PURE__ */ new Set([
  "bad-request",
  "cancelled"
]);
var fail = (code, message, details = {}) => ({
  ok: false,
  error: { code: PUBLIC_ERROR_CODES.has(code) ? code : "bad-request", message, details: { issues: [], ...details } }
});
var cleanPath = (value) => {
  const text = String(value ?? "");
  return text.length > 1 ? text.replace(/[\\/]+$/, "") : text;
};
var IGNORED_SCAN_DIRECTORIES = /* @__PURE__ */ new Set(["node_modules", "Library", "dist", "build", "vendor"]);
var MIN_SCAN_DEPTH = 1;
var MAX_SCAN_DEPTH = 5;
var DEFAULT_SCAN_DEPTH = 2;
var MAX_SCAN_DIRECTORIES = 1e3;
var scanBounds = { depth: DEFAULT_SCAN_DEPTH, directories: MAX_SCAN_DIRECTORIES };
function resolveScanDepth(value) {
  if (value === void 0 || value === null || value === "") return DEFAULT_SCAN_DEPTH;
  const depth = Math.trunc(Number(value));
  if (!Number.isFinite(depth)) return DEFAULT_SCAN_DEPTH;
  return Math.min(MAX_SCAN_DEPTH, Math.max(MIN_SCAN_DEPTH, depth));
}
async function discoverGitRoots(rootPath, { signal, maxDepth = DEFAULT_SCAN_DEPTH, maxDirectories = MAX_SCAN_DIRECTORIES } = {}) {
  const roots = [];
  const queue = [{ path: cleanPath(rootPath), depth: 0 }];
  let inspected = 0;
  for (let cursor = 0; cursor < queue.length; ) {
    signal?.throwIfAborted();
    const batch = queue.slice(cursor, cursor + 8);
    cursor += batch.length;
    inspected += batch.length;
    if (inspected > maxDirectories) throw new Error("Worktree scan limit reached; choose a more specific Workspace.");
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
        queue.push({ path: join8(path, entry.name), depth: depth + 1 });
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
    return fail(classify?.(message) ?? "bad-request", message);
  }
}
var name = "dsh-worktree-space";
var inject = ["connection", "subprocess"];
var Config = z.object({
  sidebarEntry: z.union(["show", "hide"]).default("show").loose().volatile().description("Show the Worktree Space entry in the sidebar footer."),
  settingsEntry: z.union(["show", "hide"]).default("hide").loose().volatile().description("Also show a Worktree Space section inside Settings."),
  /** The Web UI's control is gone: this is the one place the depth is chosen. */
  scanDepth: z.number().min(MIN_SCAN_DEPTH).max(MAX_SCAN_DEPTH).step(1).default(DEFAULT_SCAN_DEPTH).volatile().description("How many directory levels a scan descends from a Workspace root."),
  maxScanDirectories: z.number().min(1).step(1).default(MAX_SCAN_DIRECTORIES).volatile().description("Directories one scan may inspect before it stops looking.")
});
function apply(ctx, config = {}) {
  scanBounds.depth = resolveScanDepth(config.scanDepth);
  if (Number.isFinite(Number(config.maxScanDirectories))) {
    scanBounds.directories = Math.max(1, Math.trunc(Number(config.maxScanDirectories)));
  }
  if (typeof ctx.inject === "function") {
    ctx.inject(["tools"], (toolsCtx) => registerTaskTool(toolsCtx));
  } else {
    registerTaskTool(ctx);
  }
  if (typeof ctx.inject === "function") {
    ctx.inject(["skills"], (skillsCtx) => registerTaskSkill(skillsCtx));
  } else {
    registerTaskSkill(ctx);
  }
  const handle = async (endpoint, payload = {}, signal) => {
    if (signal?.aborted) return fail("cancelled", "The request was cancelled.");
    const listRepository = async (path) => {
      if (!path) throw new Error("Select a DSH Workspace.");
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
      const paths = Array.isArray(payload.paths) ? payload.paths.filter((path) => typeof path === "string").map((path) => path.trim()).filter(Boolean) : [];
      const maxDepth = resolveScanDepth(payload.depth ?? scanBounds.depth);
      const roots = [...new Set((await Promise.all([...new Set(paths)].map((path) => discoverGitRoots(path, { signal, maxDepth, maxDirectories: scanBounds.directories })))).flat())];
      const seen = /* @__PURE__ */ new Set();
      const repositories = [];
      for (const root of roots) {
        signal?.throwIfAborted();
        try {
          const repository = await listRepository(root);
          const key = cleanPath(repository.repoPath);
          if (key && !seen.has(key)) {
            seen.add(key);
            repositories.push(repository);
          }
        } catch {
        }
      }
      return repositories;
    });
    if (endpoint === "worktree.status") return recover(async () => {
      const path = typeof payload.path === "string" ? payload.path.trim() : "";
      if (!path) throw new Error("Worktree path is required.");
      const output = await runGit(ctx.subprocess, path, ["status", "--short", "--branch"]);
      const lines = output ? output.split(/\r?\n/) : [];
      return {
        branchLine: lines.find((line) => line.startsWith("## ")) ?? "",
        changedFiles: lines.filter((line) => line && !line.startsWith("## ")).length,
        output
      };
    });
    if (endpoint === "task.classify-root") return recover(async () => {
      const sourceRoot = typeof payload.sourceRoot === "string" ? payload.sourceRoot.trim() : "";
      if (!sourceRoot) throw new Error("A source root is required.");
      return classifySourceRoot(sourceRoot);
    });
    if (endpoint === "task.suggest-root") return recover(async () => {
      const sourceRoot = typeof payload.sourceRoot === "string" ? payload.sourceRoot.trim() : "";
      if (!sourceRoot) throw new Error("A source root is required.");
      return suggestTaskRoot(sourceRoot, {
        tasksRoot: payload.tasksRoot,
        branchPrefix: typeof payload.branchPrefix === "string" && payload.branchPrefix !== "" ? payload.branchPrefix : void 0
      });
    });
    if (endpoint === "task.create") return recover(async () => {
      const sourceRoot = typeof payload.sourceRoot === "string" ? payload.sourceRoot.trim() : "";
      const task = typeof payload.task === "string" ? payload.task.trim() : "";
      if (!sourceRoot) throw new Error("A source root is required.");
      if (!task) throw new Error("A task name is required.");
      const repos = Array.isArray(payload.repos) ? payload.repos.filter((name2) => typeof name2 === "string" && name2.trim() !== "").map((name2) => name2.trim()) : void 0;
      return createTask(ctx.subprocess, {
        sourceRoot,
        task,
        tasksRoot: payload.tasksRoot,
        repos,
        baseRef: typeof payload.baseRef === "string" ? payload.baseRef.trim() : void 0,
        branchPrefix: typeof payload.branchPrefix === "string" && payload.branchPrefix !== "" ? payload.branchPrefix : void 0,
        push: payload.push === true
      });
    });
    if (endpoint === "task.list") return recover(async () => {
      const tasksRoot = typeof payload.tasksRoot === "string" ? payload.tasksRoot.trim() : "";
      return listTasks(ctx.subprocess, { tasksRoot });
    });
    if (endpoint === "task.inspect") return recover(async () => {
      const path = typeof payload.path === "string" ? payload.path.trim() : "";
      if (!path) throw new Error("A task path is required.");
      return inspectTask(path);
    });
    if (endpoint === "task.plan") return recover(async () => {
      const task = typeof payload.task === "string" ? payload.task.trim() : "";
      if (!task) throw new Error("A task name is required.");
      return planTask(ctx.subprocess, {
        task,
        tasksRoot: typeof payload.tasksRoot === "string" ? payload.tasksRoot.trim() : ""
      });
    });
    if (endpoint === "task.done") return recover(async () => {
      const task = typeof payload.task === "string" ? payload.task.trim() : "";
      if (!task) throw new Error("A task name is required.");
      return finishTask(ctx.subprocess, {
        task,
        tasksRoot: typeof payload.tasksRoot === "string" ? payload.tasksRoot.trim() : "",
        merge: payload.merge === true,
        target: typeof payload.target === "string" ? payload.target : void 0,
        deleteBranch: payload.deleteBranch === true,
        force: payload.force === true,
        cleanStray: payload.cleanStray === true,
        keep: Array.isArray(payload.keep) ? payload.keep.filter((name2) => typeof name2 === "string") : [],
        documentsDirectory: typeof payload.documentsDirectory === "string" ? payload.documentsDirectory : void 0,
        discardDocuments: payload.discardDocuments === true
      });
    });
    return fail("bad-request", `Unknown endpoint: ${endpoint}`);
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
        const parsed = clientRequestSchema.safeParse(body);
        if (!parsed.success) return new Response("invalid client-request message", { status: 400 });
        const message = parsed.data;
        const result = message.method === `dsh-worktree-space/${endpoint}` ? await handle(endpoint, message.payload, request.signal) : fail("bad-request", "RPC method does not match endpoint.");
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
  apply,
  cleanPath,
  detectDefaultBranch,
  discoverGitRoots,
  fail,
  inject,
  name,
  ok,
  parseWorktrees,
  recover,
  resolveScanDepth,
  runGit
};
