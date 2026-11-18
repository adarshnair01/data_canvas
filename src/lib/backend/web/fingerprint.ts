/** Source fingerprint: a port of `import::fingerprint` (SHA-256 of size + first and last 1 MB). */

import type { Fingerprint } from "@/types/dataset";

const CHUNK = 1024 * 1024;

export interface BlobLike {
  size: number;
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
}

export async function partialSha256(blob: BlobLike): Promise<string> {
  const size = blob.size;
  const header = new Uint8Array(8);
  new DataView(header.buffer).setBigUint64(0, BigInt(size), true);
  const parts: Uint8Array[] = [header, new Uint8Array(await blob.slice(0, Math.min(size, CHUNK)).arrayBuffer())];
  if (size > CHUNK) {
    const tail = Math.min(size - CHUNK, CHUNK);
    parts.push(new Uint8Array(await blob.slice(size - tail, size).arrayBuffer()));
  }
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", all));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function fingerprintFile(file: File): Promise<Fingerprint> {
  return {
    path: file.name,
    size: file.size,
    modifiedMs: file.lastModified,
    partialSha256: await partialSha256(file),
  };
}
