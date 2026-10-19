/*
 * A minimal store-only (no compression) ZIP writer. No dependencies: the
 * format's stored-entry layout is small and fully specified, and packets are
 * already-compressed bytes (PDFs, images) where deflate buys little. Output
 * is deterministic for the same input order, so packet content hashes are
 * stable.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export type ZipEntry = { name: string; bytes: Uint8Array };

/**
 * Build a ZIP archive from already-in-memory entries. Names are written
 * UTF-8 (flag bit 11); entry order is preserved. Refuses names containing
 * backslashes or drive/absolute paths so an entry can never escape the
 * extraction directory.
 */
export function buildZip(entries: ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = entry.name.replaceAll("\\", "/");
    if (name.startsWith("/") || /^[a-zA-Z]:\//.test(name) || name.split("/").includes("..")) {
      throw new Error(`unsafe zip entry name: ${entry.name}`);
    }
    const nameBytes = encoder.encode(name);
    const crc = crc32(entry.bytes);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // stored
    local.setUint32(14, crc, true);
    local.setUint32(18, entry.bytes.length, true);
    local.setUint32(22, entry.bytes.length, true);
    local.setUint16(26, nameBytes.length, true);
    chunks.push(new Uint8Array(local.buffer), nameBytes, entry.bytes);

    const record = new DataView(new ArrayBuffer(46));
    record.setUint32(0, 0x02014b50, true);
    record.setUint16(4, 20, true);
    record.setUint16(6, 20, true);
    record.setUint16(8, 0x0800, true);
    record.setUint16(10, 0, true);
    record.setUint32(16, crc, true);
    record.setUint32(20, entry.bytes.length, true);
    record.setUint32(24, entry.bytes.length, true);
    record.setUint16(28, nameBytes.length, true);
    record.setUint32(42, offset, true);
    central.push(new Uint8Array(record.buffer), nameBytes);

    offset += 30 + nameBytes.length + entry.bytes.length;
  }

  const centralSize = central.reduce((sum, c) => sum + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);

  const total = offset + centralSize + 22;
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of [...chunks, ...central, new Uint8Array(end.buffer)]) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}
