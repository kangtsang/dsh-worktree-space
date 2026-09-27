// Ruler over a screenshot: report the colour runs along one row, in CSS pixels, for the
// questions a browser preview cannot answer because the page belongs to the Host.
//
// Usage: node scripts/measure-row.mjs <png> <y> [scale]
import { readFileSync } from "node:fs"
import { inflateSync } from "node:zlib"

const [file, rowArg, scaleArg] = process.argv.slice(2)
const scale = Number(scaleArg ?? 1)
const b = readFileSync(file)
let p = 8
let w = 0
let h = 0
let depth = 0
let colorType = 0
const idat = []
while (p < b.length) {
  const len = b.readUInt32BE(p)
  const type = b.toString("ascii", p + 4, p + 8)
  if (type === "IHDR") {
    w = b.readUInt32BE(p + 8)
    h = b.readUInt32BE(p + 12)
    depth = b[p + 16]
    colorType = b[p + 17]
  }
  if (type === "IDAT") idat.push(b.subarray(p + 8, p + 8 + len))
  p += 12 + len
}
const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0
if (channels === 0 || depth !== 8) throw new Error(`unsupported png: colorType=${colorType} depth=${depth}`)
const raw = inflateSync(Buffer.concat(idat))
const stride = w * channels
const out = Buffer.alloc(h * stride)
let off = 0
for (let y = 0; y < h; y++) {
  const filter = raw[off++]
  const line = raw.subarray(off, off + stride)
  off += stride
  const prev = y ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride)
  const cur = out.subarray(y * stride, (y + 1) * stride)
  for (let x = 0; x < stride; x++) {
    const a = x >= channels ? cur[x - channels] : 0
    const bb = prev[x]
    const c = x >= channels ? prev[x - channels] : 0
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
  const i = row * stride + x * channels
  const key = channels >= 3 ? `${out[i]},${out[i + 1]},${out[i + 2]}` : `${out[i]}${channels === 2 ? `,a${out[i + 1]}` : ""}`
  const last = runs[runs.length - 1]
  if (last && last.key === key) { last.to = x; last.count++ }
  else runs.push({ key, from: x, to: x, count: 1 })
}
console.log(`${file} ${w}x${h} colorType=${colorType}, y=${row}, scale=${scale}`)
for (const run of runs.filter((r) => r.count > 6)) {
  console.log(`  x=${run.from}..${run.to}  ${run.key}  device=${run.to - run.from + 1}  css=${((run.to - run.from + 1) / scale).toFixed(1)}`)
}
