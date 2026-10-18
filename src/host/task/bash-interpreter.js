/**
 * The bash a deploy entry is run by.
 *
 * The deploy scripts are shell, so this plugin runs them with `bash` - but the
 * bare word `bash` names a different program on almost every Windows machine
 * than the one a shell script needs, and it does so silently: the spawn succeeds,
 * the script path is handed over, and the failure arrives as exit 127 with
 * `No such file or directory` naming a path that is plainly there.
 *
 * **The trap.** Windows ships `bash.exe` in `System32`. It is not a shell at
 * all: it is a forwarding stub for WSL (`wsl.exe`), which starts a Linux
 * distribution and runs the argument there. Everything this plugin hands to a
 * deploy script is a native Windows path - the entry is inside the task space,
 * on a drive, spelled with backslashes - and inside that Linux a backslash is an
 * escape character and `D:` is a path component rather than a drive. The path
 * arrives as one long relative name, no such file exists, and `bash` reports 127
 * naming a directory that is right there on disk. The same stub is reachable at
 * `WindowsApps\bash.exe`, which is a symlink to the same `wsl.exe`, and
 * `C:\Program Files\WSL\` is on many PATHs for the same reason - so a PATH with
 * any of those entries before Git's hits the stub. It also prints a mojibake
 * warning line about a localhost proxy on every run, which is the tell in the wild.
 *
 * So on Windows the interpreter is **resolved, not guessed**: the known stubs are
 * refused by name and the candidates are searched in a fixed order. On every other
 * platform `bash` is right by definition and is used as-is - the Windows rule
 * exists for one platform, and applying it everywhere would be the same
 * machine-specific assumption this file exists to remove.
 *
 * **No fallback to the stub, deliberately.** Running the entry through WSL instead was
 * measured on the machine this was written on, and rejected on what it costs rather than
 * on how hard it is. Three facts, each checked with a real spawn: the stub *does* translate
 * the working directory (`D:\...` arrives as `/mnt/d/...`) and *does* find the entry when
 * it is named relatively, so the path work is nearly free. But **it drops every environment
 * variable the spawn hands it** - `DEPLOY_STATE_FILE` and `DEPLOY_ENV_ID` both arrive
 * empty, while `PATH` and `HOME` are rebuilt from WSL's own environment. Those two are the
 * whole handshake: the script would fall back to its own defaults, come up under the default
 * environment id, and write its state to a path this side does not read - a run that looks
 * successful and is wrong. A failure that cannot be reported, on a path whose script is
 * usually a docker entry, is worse than a named refusal, so the stub is rejected by name
 * and a machine without a real shell is told so.
 *
 * **No cache, deliberately.** Resolving is a handful of `stat` calls over a fixed
 * candidate list, measured on this machine at 0.082 ms median over 200 runs (p95 0.150 ms,
 * max 1.048 ms). It is re-resolved on every call: at that cost a cache would be
 * bookkeeping in exchange for nothing, and it would make the answer stale in a way nobody
 * asked for - installing Git Bash while DSH runs would go unnoticed until a restart, and a
 * remembered "there is no bash here" would outlive the fix that made that untrue. The one
 * thing a cache could have bought - a faster answer on the machine that has no shell at all
 * - is also the cheapest case, since it searches a list that is mostly misses.
 */

import { statSync } from 'node:fs'
import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Windows programs that accept `bash` and are not a POSIX shell.
 *
 * Matched on the tail of the resolved path rather than on the whole path, so a
 * Windows installed somewhere other than `C:\` - or the stub in a per-user
 * directory - is still recognised. Compared case-insensitively, because Windows
 * paths are.
 */
const WINDOWS_STUB_NAMES = [
  'system32/bash.exe',
  'syswow64/bash.exe',
  'windowsapps/bash.exe',
  'program files/wsl/bash.exe',
]

/** Where a Git for Windows install keeps a real bash, in preference order. */
const GIT_BASH_PATHS = [
  'C:/Program Files/Git/bin/bash.exe',
  'C:/Program Files/Git/usr/bin/bash.exe',
  'C:/Program Files (x86)/Git/bin/bash.exe',
  'C:/Program Files (x86)/Git/usr/bin/bash.exe',
]

/** Every `bash.exe` under the DSH ops shells root, newest version first. */
function harnessBashCandidates() {
  const root = join(homedir(), '.dsh', 'dsh-ops', 'shells', 'bash')
  let versions
  try {
    versions = readdirSync(root)
  } catch {
    return []
  }
  // Sorted descending so the newest shell wins: two versions side by side is a
  // partial upgrade, and the newer one is the one the rest of the harness expects.
  return versions
    .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))
    .map((version) => join(root, version, 'usr', 'bin', 'bash.exe'))
}

/**
 * Whether a candidate is one of the WSL forwarding stubs.
 * @param candidate - an absolute path, as this side would spawn it.
 * @returns whether the path names a stub rather than a shell.
 */
export function isWindowsBashStub(candidate) {
  const normalised = String(candidate ?? '').replace(/\\/g, '/').toLowerCase()
  return WINDOWS_STUB_NAMES.some((name) => normalised.endsWith(`/${name}`))
}

/** Whether the path is an existing file this side could spawn. */
function isExecutableFile(candidate) {
  try {
    return statSync(candidate).isFile()
  } catch {
    return false
  }
}

/**
 * The bash to run a deploy entry with on this machine, or `undefined` when there
 * is none.
 *
 * `undefined` is a real answer and not a fallback trigger: the caller turns it
 * into an error that names what is missing, because the alternative - letting the
 * spawn fail - is how a Windows stub turned a present script into exit 127.
 * @returns `{ command, toolDir }`, or `undefined`. `toolDir` is the directory to
 *   put on PATH for that shell and is `undefined` when the shell is found the way
 *   a POSIX machine finds it.
 */
export function bashInterpreter() {
  if (process.platform !== 'win32') {
    // Not "found on disk": on a POSIX machine `bash` is resolved by the spawn
    // itself against PATH, and looking for `/bin/bash` here would answer a
    // different question than the one being asked - is there a bash on PATH.
    return { command: 'bash', toolDir: undefined }
  }
  for (const candidate of [...harnessBashCandidates(), ...GIT_BASH_PATHS]) {
    if (isWindowsBashStub(candidate)) continue
    if (isExecutableFile(candidate)) return { command: candidate, toolDir: dirname(candidate) }
  }
  return undefined
}

/**
 * The PATH a deploy entry's shell needs to find its own standard tools.
 *
 * A bash that is named by absolute path does not get its neighbours for free: the
 * utilities it ships beside it - `dirname`, `basename`, `sed`, `tr` - are separate
 * executables in that same directory, and are reached by PATH lookup like any other
 * command. Neither the harness's own shell nor Git for Windows is on the PATH the
 * Host's scrubbed base gives the child, so an entry that runs `dirname` - which
 * every entry does to work out where it lives - dies on
 * `dirname: command not found` the moment the shell runs at all.
 *
 * It is a second failure that the first one was hiding: with the WSL stub on PATH
 * the script never started, so this line was never reached. Git Bash survives the
 * same missing PATH because it resolves these names internally, so the defect looks
 * like a property of the shell rather than of the PATH, and only the first choice
 * in {@link bashInterpreter} shows it.
 *
 * Prepended rather than appended: the shell's own tools must win over anything of the
 * same name further along the PATH, and prepending is what makes that hold on a
 * machine that has both.
 * @param toolDir - the directory the resolved shell lives in, when this side found it.
 * @param existing - the PATH the child would otherwise run with.
 * @returns the PATH to hand over.
 */
export function pathForShell(toolDir, existing) {
  if (typeof toolDir !== 'string' || toolDir === '') return existing
  const current = typeof existing === 'string' ? existing : ''
  const separator = current.includes(';') ? ';' : ':'
  return current === '' ? toolDir : `${toolDir}${separator}${current}`
}
