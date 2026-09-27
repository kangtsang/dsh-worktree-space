/**
 * Measure the rendered status dots in a preview screenshot.
 *
 * The user reported that the green state dot looks larger than the amber one
 * even though both are 7.5px. This walks the PNG pixels, finds every strongly
 * saturated orange blob (the amber dot on the warning colour) and every
 * saturated green blob (the success dot), and prints each blob's width and
 * height in device pixels plus the colour at its centre. Blob geometry is what
 * matters: an identical size with a different colour is an optical effect, a
 * different size is a real one.
 *
 * Usage: node scripts/preview.measure.mjs _preview/panel.png [scale]
 * The PNG is decoded by the browser-free decoder in zlib + a scanline pass:
 * only 8-bit RGBA/RGB non-interlaced files are handled, which is what Chrome
 * writes.
 */
import { readFileSync } from "node:fs"
import { inflateSync } from "node:zlib"

const file = process.argv[2] ?? "_preview/panel.png"
const scale = Number(process.argv[3] ?? 4)

const png = readFileSync(file)
let offset = 8
let width = 0
let height = 0
let bitDepth = 0
let colorType = 0
const idat = []

while (offset < png.length) {
  const length = png.readUInt32BE(offset)
  const type = png.toString("ascii", offset + 4, offset + 8)
  const body = png.subarray(offset + 8, offset + 8 + length)
  if (type === "IHDR") {
    width = body.readUInt32BE(0)
    height = body.readUInt32BE(4)
    bitDepth = body[8]
    colorType = body[9]
  } else if (type === "IDAT") {
    idat.push(body)
  } else if (type === "IEND") {
    break
  }
  offset += 12 + length
}

if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) {
  throw new Error(`unsupported PNG: bitDepth=${bitDepth} colorType=${colorType}`)
}

const channels = colorType === 6 ? 4 : 3
const raw = inflateSync(Buffer.concat(idat))
const stride = width * channels
const pixels = Buffer.alloc(height * stride)

for (let y = 0; y < height; y += 1) {
  const filter = raw[y * (stride + 1)]
  const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
  const out = pixels.subarray(y * stride, (y + 1) * stride)
  const prior = y === 0 ? null : pixels.subarray((y - 1) * stride, y * stride)
  for (let x = 0; x < stride; x += 1) {
    const left = x >= channels ? out[x - channels] : 0
    const up = prior === null ? 0 : prior[x]
    const upLeft = prior === null || x < channels ? 0 : prior[x - channels]
    let value = line[x]
    if (filter === 1) value += left
    else if (filter === 2) value += up
    else if (filter === 3) value += (left + up) >> 1
    else if (filter === 4) {
      const p = left + up - upLeft
      const pa = Math.abs(p - left)
      const pb = Math.abs(p - up)
      const pc = Math.abs(p - upLeft)
      value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
    }
    out[x] = value & 0xff
  }
}

const at = (x, y) => {
  const i = y * stride + x * channels
  return [pixels[i], pixels[i + 1], pixels[i + 2]]
}

const isAmber = ([r, g, b]) => r > 150 && g > 90 && g < 190 && b < 90 && r - b > 90 && r > g
const isGreen = ([r, g, b]) => g > 120 && g - r > 45 && g - b > 45

/** Four-connected blobs of pixels matching `match`. */
function blobs(match) {
  const seen = new Uint8Array(width * height)
  const found = []
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x
      if (seen[index] === 1 || !match(at(x, y))) continue
      let minX = x
      let maxX = x
      let minY = y
      let maxY = y
      let count = 0
      const stack = [[x, y]]
      seen[index] = 1
      while (stack.length > 0) {
        const [cx, cy] = stack.pop()
        count += 1
        if (cx < minX) minX = cx
        if (cx > maxX) maxX = cx
        if (cy < minY) minY = cy
        if (cy > maxY) maxY = cy
        for (const [nx, ny] of [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]]) {
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
          const next = ny * width + nx
          if (seen[next] === 1 || !match(at(nx, ny))) continue
          seen[next] = 1
          stack.push([nx, ny])
        }
      }
      if (count >= scale * scale) found.push({ minX, maxX, minY, maxY, count })
    }
  }
  return found
}

function report(label, match) {
  const list = blobs(match)
  console.log(`\n${label}: ${list.length} blob(s)`)
  for (const blob of list) {
    const w = blob.maxX - blob.minX + 1
    const h = blob.maxY - blob.minY + 1
    const centre = at(Math.round((blob.minX + blob.maxX) / 2), Math.round((blob.minY + blob.maxY) / 2))
    console.log(
      `  x=${blob.minX} y=${blob.minY}  ${w}x${h} device px  -> ${(w / scale).toFixed(2)}x${(h / scale).toFixed(2)} css px` +
        `  rgb(${centre.join(", ")})  area=${blob.count}`,
    )
  }
}

console.log(`${file}: ${width}x${height} at ${scale}x device scale`)
report("amber dots", isAmber)
report("green dots", isGreen)
