// Minimal deterministic ZIP writer: regular files only, deflate or store,
// fixed timestamps and attributes, UTF-8 names, no ZIP64 (the archive limit
// keeps every size and count far below the 32-bit and 16-bit fields).

import { deflateRawSync } from 'node:zlib';

// 1980-01-01 00:00:00, the earliest DOS date.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const VERSION = 20;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export class ZipLimitError extends Error {
  constructor(kind, limit) {
    super(`ZIP ${kind} limit exceeded (${limit})`);
    this.kind = kind;
    this.limit = limit;
  }
}

/**
 * Incremental writer, so the caller can read one file at a time and stop as
 * soon as the archive grows past its limit.
 */
export class ZipWriter {
  constructor({ maxBytes = Infinity, maxEntries = 65535 } = {}) {
    this.maxBytes = maxBytes;
    this.maxEntries = Math.min(maxEntries, 65535);
    this.chunks = [];
    this.central = [];
    this.offset = 0;
    this.count = 0;
    this.names = new Set();
  }

  add(name, data) {
    if (this.names.has(name)) throw new Error(`Duplicate ZIP entry: ${name}`);
    if (this.count + 1 > this.maxEntries) throw new ZipLimitError('entries', this.maxEntries);
    const nameBytes = Buffer.from(name, 'utf8');
    if (nameBytes.length > 0xffff) throw new Error(`ZIP entry name too long: ${name}`);
    if (data.length >= 0xffffffff) throw new ZipLimitError('bytes', this.maxBytes);

    const crc = crc32(data);
    const deflated = deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const method = useDeflate ? METHOD_DEFLATE : METHOD_STORE;
    const payload = useDeflate ? deflated : data;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(VERSION, 4); // made by: MS-DOS, no Unix modes
    central.writeUInt16LE(VERSION, 6);
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(this.offset, 42);

    const entryBytes = local.length + nameBytes.length + payload.length;
    const projected =
      this.offset + entryBytes + this.centralSize() + central.length + nameBytes.length + 22;
    if (projected > this.maxBytes) throw new ZipLimitError('bytes', this.maxBytes);

    this.chunks.push(local, nameBytes, payload);
    this.central.push(central, nameBytes);
    this.offset += entryBytes;
    this.count += 1;
    this.names.add(name);
  }

  centralSize() {
    let size = 0;
    for (const chunk of this.central) size += chunk.length;
    return size;
  }

  finish() {
    const centralSize = this.centralSize();
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(this.count, 8);
    end.writeUInt16LE(this.count, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(this.offset, 16);
    end.writeUInt16LE(0, 20);
    return Buffer.concat([...this.chunks, ...this.central, end]);
  }
}

/** Read back the entries of a ZIP produced by ZipWriter (used by tests). */
export function listZipEntries(buffer) {
  const endOffset = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endOffset < 0) throw new Error('Not a ZIP archive');
  const count = buffer.readUInt16LE(endOffset + 10);
  let cursor = buffer.readUInt32LE(endOffset + 16);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Bad central header');
    const method = buffer.readUInt16LE(cursor + 10);
    const time = buffer.readUInt16LE(cursor + 12);
    const date = buffer.readUInt16LE(cursor + 14);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    entries.push({ name, method, time, date, crc, compressedSize, size, localOffset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
