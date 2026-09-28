import assert from "node:assert/strict"
import { readFile, stat } from "node:fs/promises"
import { createRequire } from "node:module"
import vm from "node:vm"

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
const bundlePath = new URL("../client/client.js", import.meta.url)
const clientBundle = await readFile(bundlePath, "utf8")
const registrations = []

vm.runInNewContext(clientBundle, {
  window: {
    __ModuleLoader__: {
      load(handoff) { registrations.push(handoff) },
    },
  },
})

assert.equal(registrations.length, 1, "client bundle must register exactly one module factory")
assert.equal(registrations[0].id, packageJson.name, "client bundle must register the package name")
assert.equal(typeof registrations[0].factory, "function", "client bundle must register a factory")
const nodeRequire = createRequire(import.meta.url)
const plugin = registrations[0].factory((id) => nodeRequire(id))
assert.equal(plugin.name, packageJson.name, "client factory must return the plugin name")
assert.ok(Array.isArray(plugin.inject), "client factory must return an inject list")
assert.equal(typeof plugin.apply, "function", "client factory must return apply")
// A JSX tag is `<`, an optional `/`, a name, and then a space, `/` or `>`. A comparison
// is not: the bundle holds `<Math.min(…)` from its own code and `<Name;` from a
// dependency, and the minifier writes both without the spaces that would make them read
// as tags here.
assert.doesNotMatch(clientBundle, /<\/?[A-Z][A-Za-z0-9_]*(?:[\s/>])/, "generated bundle must not contain JSX")
assert.doesNotMatch(clientBundle, /(^|\n)\s*import\s/, "generated bundle must not contain ESM imports")
assert.match(clientBundle, /data-dsh-worktree-space-style/, "client bundle must install the plugin stylesheet")
assert.match(clientBundle, /appendChild/, "client bundle must append the plugin stylesheet")
assert.ok((await stat(bundlePath)).size > 0, "client bundle must not be empty")

console.log(`client bundle registers ${packageJson.name}`)
