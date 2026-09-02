import { createHash } from "node:crypto";

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Short stable hash for dedup keys. */
export function shortHash(input: string): string {
  return sha256Hex(input).slice(0, 16);
}
