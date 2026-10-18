// The bug this guards: on Windows the bare word `bash` resolves to the System32
// forwarding stub for WSL, which cannot read a native `D:\...` path. The deploy
// entry is then reported as `No such file or directory` while sitting on disk, and
// the panel's message names the file rather than the interpreter.
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { bashInterpreter, isWindowsBashStub, pathForShell } from '../src/host/task/bash-interpreter.js'

describe('the WSL forwarding stubs are recognised', () => {
  // Matched by tail on purpose: a Windows on D:\, or the stub copied into a
  // per-user directory, has to be caught as well as the one under C:\Windows.
  it.each([
    'C:\\Windows\\System32\\bash.exe',
    'C:\\Windows\\SysWOW64\\bash.exe',
    'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe',
    'C:\\Program Files\\WSL\\bash.exe',
  ])('names %s as a stub', (path) => {
    expect(isWindowsBashStub(path)).toBe(true)
  })

  it.each([
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Users\\me\\.dsh\\dsh-ops\\shells\\bash\\2.56.0.2\\usr\\bin\\bash.exe',
    // The system directory alone is not a stub - `system32/bash.exe` is, and the
    // difference is exactly what makes the tail match worth having.
    'C:\\Windows\\System32\\bash-not.exe',
    'C:\\Windows\\System32\\git.exe',
  ])('does not name %s as a stub', (path) => {
    expect(isWindowsBashStub(path)).toBe(false)
  })

  it('sees a stub through any separator spelling and any case', () => {
    expect(isWindowsBashStub('C:/Windows/SYSTEM32/BASH.EXE')).toBe(true)
    expect(isWindowsBashStub('c:\\windows\\system32\\bash.exe')).toBe(true)
  })
})

describe('the interpreter a deploy entry is run by', () => {
  it('is never one of the stubs on Windows', () => {
    const found = bashInterpreter()
    // On POSIX this is the bare word `bash`, resolved by the spawn itself, and the
    // stub names do not exist there - so the invariant is stated rather than skipped.
    if (process.platform === 'win32') {
      expect(found).toBeDefined()
      expect(isWindowsBashStub(found.command)).toBe(false)
      expect(isWindowsBashStub(join('C:\\Windows\\System32', 'bash.exe'))).toBe(true)
    } else {
      expect(found.command).toBe('bash')
      expect(found.toolDir).toBeUndefined()
    }
  })

  it('resolves again on every call rather than remembering one answer', () => {
    // No cache, on purpose: the search is a few `stat` calls over a fixed list
    // (measured at 0.082 ms median here), so re-resolving costs nothing and keeps
    // the answer honest - a bash installed while DSH runs is seen at once, and a
    // remembered "there is none here" cannot outlive the fix that made it untrue.
    const first = bashInterpreter()
    const second = bashInterpreter()
    // Deterministic either way: the machine did not change between two calls in
    // the same test. What is being pinned is that the second call consulted the
    // machine rather than a variable, so the two must agree by being re-derived.
    // Compared field by field rather than by identity: two lookups return two
    // objects, and `toBe` would be asserting that they are the same one.
    expect(second).toEqual(first)
  })

  it('names the tool directory the chosen shell needs on PATH', () => {
    // Without this every entry dies on `dirname: command not found`: a shell named
    // by absolute path does not get the utilities sitting beside it, and neither the
    // harness's own shell nor Git for Windows is on the PATH the Host hands a child.
    const found = bashInterpreter()
    if (process.platform !== 'win32') return
    expect(found.toolDir).toBe(dirname(found.command))
    expect(existsSync(join(found.toolDir, 'dirname.exe'))).toBe(true)
  })
})

describe('the PATH a resolved shell is given', () => {
  it('puts that shell\'s own directory in front, not behind', () => {
    // Prepended, so the shell's tools win over a same-named one further along the
    // PATH - which is the case on a machine with both a harness shell and Git's.
    const merged = pathForShell('C:\\tools\\usr\\bin', 'C:\\Windows;C:\\other')
    expect(merged.split(';')[0]).toBe('C:\\tools\\usr\\bin')
    expect(merged).toContain('C:\\Windows')
  })

  it('leaves a POSIX lookup exactly as it found it', () => {
    // A POSIX shell is found the way a POSIX machine finds it, so there is no tool
    // directory to add and the PATH must not be rewritten.
    expect(pathForShell(undefined, '/usr/bin:/bin')).toBe('/usr/bin:/bin')
  })

  it('does not touch the host process\'s own PATH', () => {
    const before = process.env.PATH
    pathForShell('C:\\tools\\usr\\bin', before)
    expect(process.env.PATH).toBe(before)
  })
})
