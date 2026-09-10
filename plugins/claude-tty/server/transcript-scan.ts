import { open, stat } from "node:fs/promises";

/** Enough of the head of a file to know it again, so a rewrite of the same size is still noticed. */
const SIGNATURE_BYTES = 256;

/**
 * How far into a file this has read, and what the file looked like when it did. Claude's transcripts
 * are appended to for as long as the session lives and run to megabytes, and the panel polls them,
 * so they are read the way the adapter reads them: once from the beginning, then only what is new.
 */
export type FileScan = {
  offset: number;
  signature: string;
  signatureBytes: number;
  /** Reads of one scan run one at a time; two that overlapped would both read from the old offset. */
  queue: Promise<unknown>;
};

/** The whole lines one read found, and whether the file was rewritten under the scan before them. */
export type NewLines = { text: string; rewritten: boolean };

export function newScan(): FileScan {
  return { offset: 0, signature: "", signatureBytes: 0, queue: Promise.resolve() };
}

/**
 * Reads what has been written since the last read and hands it to `apply`. A compaction can land on
 * the same size or a larger one, so what identifies the file is the head of it rather than its
 * length. The last line of a file being appended to is half-written, so it is left where it is
 * until the read that finds the rest of it.
 *
 * `apply` runs inside the read rather than after it because the scans are module scope and shared
 * by every client the daemon serves: two polls that overlapped on one file would otherwise read the
 * same records twice onto one tail, and leave the offset past the end of the file.
 */
export function readNewLines<T>(file: string, scan: FileScan, apply: (lines: NewLines) => T): Promise<T> {
  const read = async () => apply(await readAhead(file, scan));
  const operation = scan.queue.then(read, read);
  scan.queue = operation.catch(() => undefined);
  return operation;
}

async function readAhead(file: string, scan: FileScan): Promise<NewLines> {
  const size = (await stat(file)).size;
  const rewritten = await rewind(file, scan, size);
  if (size <= scan.offset) return { text: "", rewritten };
  const chunk = await readRange(file, scan.offset, size - scan.offset);
  const complete = chunk.lastIndexOf("\n");
  if (complete < 0) return { text: "", rewritten };
  scan.offset += Buffer.byteLength(chunk.slice(0, complete + 1));
  return { text: chunk.slice(0, complete), rewritten };
}

export async function readHead(file: string, length: number): Promise<string> {
  return readRange(file, 0, length);
}

export async function readWhole(file: string): Promise<string | null> {
  const handle = await open(file, "r").catch(() => null);
  if (handle === null) return null;
  try {
    return await handle.readFile("utf8");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function rewind(file: string, scan: FileScan, size: number): Promise<boolean> {
  const comparable = scan.signatureBytes || Math.min(SIGNATURE_BYTES, size);
  const signature = await readRange(file, 0, comparable);
  if (size < scan.offset || (scan.offset > 0 && signature !== scan.signature)) {
    scan.offset = 0;
    await sign(file, scan, size);
    return true;
  }
  // A file signed while it was shorter than the constant is signed again once it is that long, so
  // what identifies it is the head the constant names rather than whatever the first read caught.
  if (scan.signatureBytes < Math.min(SIGNATURE_BYTES, size)) await sign(file, scan, size);
  return false;
}

async function sign(file: string, scan: FileScan, size: number): Promise<void> {
  scan.signatureBytes = Math.min(SIGNATURE_BYTES, size);
  scan.signature = await readRange(file, 0, scan.signatureBytes);
}

async function readRange(file: string, start: number, length: number): Promise<string> {
  if (length <= 0) return "";
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close().catch(() => undefined);
  }
}
