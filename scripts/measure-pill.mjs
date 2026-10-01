// Measure the rendered select pill from a screenshot, so the prefix field beside it can be
// given the same width instead of a guess.
//
// Usage: node scripts/measure-pill.mjs <png> <y> <x-scale>
// Finds the pill's background colour runs along one row and reports them in CSS pixels.
import { readFileSync } from "node:fs"
import { inflateSync } from "node:zlib"

const [file, rowArg, scaleArg] = process.argv.slice(2)
const scale = Number(scaleArg ?? 1)
const b = readFileSync(file)
let p = 8
let w = 0
let h = 0
const idat = []
while (p < b.length) {
  const len = b.readUInt32BE(p)
  const type = b.toString("ascii", p + 4, p + 8)
  if (type === "IHDR") { w = b.readUInt32BE(p + 8); h = b.readUInt32BE(p + 12) }
  if (type === "IDAT") idat.push(b.subarray(p + 8, p + 8 + len))
  p += 12 + len
}
const raw = inflateSync(Buffer.concat(idat))
const stride = w * 4
const out = Buffer.alloc(h * stride)
let off = 0
for (let y = 0; y < h; y++) {
  const filter = raw[off++]
  const line = raw.subarray(off, off + stride)
  off += stride
  const prev = y ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride)
  const cur = out.subarray(y * stride, (y + 1) * stride)
  for (let x = 0; x < stride; x++) {
    const a = x >= 4 ? cur[x - 4] : 0
    const bb = prev[x]
    const c = x >= 4 ? prev[x - 4] : 0
    let v = line[x]
    if (filter === 1) v += a
    else if (filter === 2) v += bb
    else if (filter === 3) v += (a + bb) >> 1
    else if (filter === 4) {
      const pa = Math.abs(bb - c)
      const pb = Math.abs(a - c)
      const pc = Math.abs(a + bb - 2 * c)
      v += pa <= pb && pa <= pc ? a : pb <= pc ? bb : c
    }
    cur[x] = v & 255
  }
}
const row = Number(rowArg)
const runs = []
for (let x = 0; x < w; x++) {
  const i = row * stride + x * 4
  const key = `${out[i]},${out[i + 1]},${out[i + 2]}`
  const last = runs[runs.length - 1]
  if (last && last.key === key) { last.to = x; last.count++ }
  else runs.push({ key, from: x, to: x, count: 1 })
}
console.log(`${file} ${w}x${h}, y=${row}, scale=${scale}`)
for (const run of runs.filter((r) => r.count > 12)) {
  const css = ((run.to - run.from + 1) / scale)
  console.log(`  x=${run.from}..${run.to}  rgb(${run.key})  width=${run.to - run.from + 1}px device = ${css.toFixed(1)}px css`)
}
