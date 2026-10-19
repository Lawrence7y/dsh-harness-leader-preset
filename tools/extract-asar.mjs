#!/usr/bin/env node
/**
 * Copy a subtree out of a running Electron app.asar (read-only source) into a
 * local directory, byte for byte. Written to validate hand-authored Cordis
 * YAML with the host's OWN dialect instead of a lookalike.
 *
 * The app.asar format: 4-byte header, then a uint32LE at offset 12 giving the
 * JSON header size, then that JSON, then the file payloads packed in offset
 * order. Files flagged `unpacked` live beside the archive in `<asar>.unpacked`.
 *
 * Usage: node extract-asar.mjs <asar-path> <asar-prefix> <dest-dir>
 */
import { openSync, readSync, closeSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'

const [asarPath, prefix, destDir] = process.argv.slice(2)
if (!asarPath || !prefix || !destDir) {
  console.error('usage: node extract-asar.mjs <asar-path> <asar-prefix> <dest-dir>')
  process.exit(2)
}

const fd = openSync(asarPath, 'r')
const sizeBytes = Buffer.alloc(16)
readSync(fd, sizeBytes, 0, 16, 0)
const headerSize = sizeBytes.readUInt32LE(12)
const headerBytes = Buffer.alloc(headerSize)
readSync(fd, headerBytes, 0, headerSize, 16)
const header = JSON.parse(headerBytes.toString('utf8'))
const base = 16 + headerSize

/** Every regular file in the archive, as archive-absolute paths. */
function walk(node, at, out) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const path = `${at}/${name}`
    if (entry.files) walk(entry, path, out)
    else out.push({ path, size: Number(entry.size), offset: Number(entry.offset), unpacked: entry.unpacked === true })
  }
  return out
}

// Address the desktop app's runtime root explicitly: `dsh/<path-inside-dsh>`.
// The `dsh` segment is the archive's own prefix, not part of the layout being
// copied, so it is dropped — `<destDir>` then mirrors `dsh/`'s contents.
const raw = String(prefix).replace(/^\/+/, '')
if (!raw.startsWith('dsh/')) {
  console.error(`prefix must start with "dsh/" (the archive's runtime root); got ${JSON.stringify(prefix)}`)
  closeSync(fd)
  process.exit(2)
}
const relative = raw.slice('dsh/'.length)
const wants = `/${raw}`
const hits = walk(header, '', []).filter(entry => entry.path === wants || entry.path.startsWith(`${wants}/`))
if (hits.length === 0) {
  console.error(`no entries under ${wants}`)
  closeSync(fd)
  process.exit(1)
}

let written = 0
let bytes = 0
for (const entry of hits) {
  const buffer = Buffer.alloc(entry.size)
  if (entry.unpacked) readSync(openSync(`${asarPath}.unpacked${entry.path.split('/').join(sep)}`, 'r'), buffer, 0, entry.size, 0)
  else if (entry.size > 0) readSync(fd, buffer, 0, entry.size, base + entry.offset)
  const dest = join(destDir, ...entry.path.slice(wants.length + 1).split('/').filter(part => part.length > 0))
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, buffer)
  written += 1
  bytes += entry.size
}
closeSync(fd)
console.log(`${written} file(s), ${(bytes / 1024).toFixed(1)} KiB → ${destDir}`)
