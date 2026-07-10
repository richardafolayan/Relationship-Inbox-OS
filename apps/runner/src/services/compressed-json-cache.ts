import { gzipSync } from "node:zlib";

export interface CompressedJsonCacheEntry {
  expires: number;
  json: string;
  gzip: Buffer;
}

export function createCompressedJsonCacheEntry(body: unknown, expires: number): CompressedJsonCacheEntry {
  const json = JSON.stringify(body);
  return { expires, json, gzip: gzipSync(json) };
}
