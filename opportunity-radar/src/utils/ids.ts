import { randomUUID } from "node:crypto";

/** Opaque, URL-safe identifier. */
export function newId(): string {
  return randomUUID();
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Ids arrive in URL paths; keep them to a strict alphabet before they reach SQL. */
export function isValidId(value: string): boolean {
  return ID_RE.test(value);
}
