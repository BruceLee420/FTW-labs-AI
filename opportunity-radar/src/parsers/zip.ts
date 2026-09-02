/**
 * Minimal ZIP reader for DOCX containers, using Node built-ins only.
 *
 * Why: a DOCX file is a ZIP archive, and pulling in a ZIP library for one
 * entry is not worth the dependency. This reads the End Of Central Directory
 * record and the central directory (the authoritative index), supports the
 * two methods Word writes (STORE and DEFLATE), and refuses anything that
 * looks broken or hostile: encrypted or ZIP64 entries, offsets outside the
 * buffer, CRC mismatches, more than MAX_ZIP_ENTRIES entries, or more than
 * MAX_INFLATED_BYTES of output in total. Directory entries are skipped.
 * Nothing here touches the filesystem or the network.
 */
import { crc32, inflateRawSync } from "node:zlib";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_SIZE = 22;
const CENTRAL_HEADER_SIZE = 46;
const LOCAL_HEADER_SIZE = 30;
const MAX_COMMENT_LENGTH = 0xffff;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const FLAG_ENCRYPTED = 0x0001;

/** Upper bound on entries read from one archive. */
export const MAX_ZIP_ENTRIES = 2000;
/** Upper bound on the sum of uncompressed entry sizes (50 MB). */
export const MAX_INFLATED_BYTES = 50 * 1024 * 1024;

const utf8 = new TextDecoder("utf-8");

function fail(reason: string): never {
  throw new Error(`Malformed ZIP archive: ${reason}`);
}

/** Entry names come from the file; keep them short in error messages. */
function shortName(name: string): string {
  return name.length > 80 ? `${name.slice(0, 77)}...` : name;
}

function findEndOfCentralDirectory(view: DataView): number {
  const lowest = Math.max(0, view.byteLength - EOCD_SIZE - MAX_COMMENT_LENGTH);
  for (let pos = view.byteLength - EOCD_SIZE; pos >= lowest; pos--) {
    if (view.getUint32(pos, true) !== EOCD_SIGNATURE) continue;
    const commentLength = view.getUint16(pos + 20, true);
    if (pos + EOCD_SIZE + commentLength <= view.byteLength) return pos;
  }
  return fail("end of central directory record not found");
}

function readLocalEntry(
  data: Uint8Array,
  view: DataView,
  name: string,
  localOffset: number,
  method: number,
  compressedSize: number,
  uncompressedSize: number,
): Uint8Array {
  const label = shortName(name);
  if (localOffset + LOCAL_HEADER_SIZE > data.byteLength) fail(`local header for "${label}" lies outside the archive`);
  if (view.getUint32(localOffset, true) !== LOCAL_SIGNATURE) fail(`bad local header signature for "${label}"`);
  const nameLength = view.getUint16(localOffset + 26, true);
  const extraLength = view.getUint16(localOffset + 28, true);
  const start = localOffset + LOCAL_HEADER_SIZE + nameLength + extraLength;
  const end = start + compressedSize;
  if (end > data.byteLength) fail(`data for "${label}" lies outside the archive`);
  const raw = data.subarray(start, end);

  if (method === METHOD_STORE) {
    if (compressedSize !== uncompressedSize) fail(`stored entry "${label}" has inconsistent sizes`);
    return new Uint8Array(raw);
  }
  let inflated: Uint8Array;
  try {
    inflated = inflateRawSync(raw, { maxOutputLength: Math.max(1, uncompressedSize) });
  } catch {
    fail(`entry "${label}" could not be inflated`);
  }
  if (inflated.byteLength !== uncompressedSize) fail(`entry "${label}" inflated to an unexpected size`);
  return inflated;
}

/**
 * Read every file entry of a ZIP archive into memory, keyed by its path
 * inside the archive (forward slashes, as stored). Throws an Error with a
 * plain-language reason on malformed or unsupported input.
 */
export function readZipEntries(data: Uint8Array): Map<string, Uint8Array> {
  if (data.byteLength < EOCD_SIZE) fail("file is too small to be a ZIP archive");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const eocd = findEndOfCentralDirectory(view);
  const entryCount = view.getUint16(eocd + 10, true);
  const directorySize = view.getUint32(eocd + 12, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    fail("ZIP64 archives are not supported");
  }
  if (entryCount > MAX_ZIP_ENTRIES) fail(`too many entries (${entryCount}; the limit is ${MAX_ZIP_ENTRIES})`);
  if (directoryOffset + directorySize > eocd) fail("central directory lies outside the archive");

  const entries = new Map<string, Uint8Array>();
  let inflatedTotal = 0;
  let pos = directoryOffset;
  for (let i = 0; i < entryCount; i++) {
    if (pos + CENTRAL_HEADER_SIZE > eocd) fail("central directory is truncated");
    if (view.getUint32(pos, true) !== CENTRAL_SIGNATURE) fail("bad central directory signature");
    const flags = view.getUint16(pos + 8, true);
    const method = view.getUint16(pos + 10, true);
    const crc = view.getUint32(pos + 16, true);
    const compressedSize = view.getUint32(pos + 20, true);
    const uncompressedSize = view.getUint32(pos + 24, true);
    const nameLength = view.getUint16(pos + 28, true);
    const extraLength = view.getUint16(pos + 30, true);
    const commentLength = view.getUint16(pos + 32, true);
    const localOffset = view.getUint32(pos + 42, true);
    const nameStart = pos + CENTRAL_HEADER_SIZE;
    if (nameStart + nameLength > eocd) fail("entry name is truncated");
    const name = utf8.decode(data.subarray(nameStart, nameStart + nameLength));
    pos = nameStart + nameLength + extraLength + commentLength;

    if (name === "" || name.endsWith("/")) continue; // directory entry
    if (flags & FLAG_ENCRYPTED) fail(`entry "${shortName(name)}" is encrypted`);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) fail("ZIP64 entries are not supported");
    if (method !== METHOD_STORE && method !== METHOD_DEFLATE) {
      fail(`entry "${shortName(name)}" uses unsupported compression method ${method}`);
    }
    inflatedTotal += uncompressedSize;
    if (inflatedTotal > MAX_INFLATED_BYTES) fail("archive expands beyond the 50 MB limit");

    const content = readLocalEntry(data, view, name, localOffset, method, compressedSize, uncompressedSize);
    if (crc32(content) !== crc) fail(`entry "${shortName(name)}" failed its CRC check`);
    entries.set(name, content);
  }
  return entries;
}
