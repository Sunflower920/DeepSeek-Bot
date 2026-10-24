// A zip built by hand, so the reader is tested against the real layout: local header,
// packed data, central directory, end-of-central-directory record.
import { deflateRawSync } from 'node:zlib'

export function zipFixture(entries) {
  const parts = []
  const central = []
  let offset = 0
  for (const [name, value] of Object.entries(entries)) {
    const entryName = Buffer.from(name, 'utf8')
    const data = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8')
    const packed = deflateRawSync(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(packed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(entryName.length, 26)
    const head = Buffer.alloc(46)
    head.writeUInt32LE(0x02014b50, 0)
    head.writeUInt16LE(20, 4)
    head.writeUInt16LE(20, 6)
    head.writeUInt16LE(8, 10)
    head.writeUInt32LE(packed.length, 20)
    head.writeUInt32LE(data.length, 24)
    head.writeUInt16LE(entryName.length, 28)
    head.writeUInt32LE(offset, 42)
    parts.push(local, entryName, packed)
    central.push(head, entryName)
    offset += local.length + entryName.length + packed.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(entries).length, 8)
  end.writeUInt16LE(Object.keys(entries).length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, directory, end])
}
