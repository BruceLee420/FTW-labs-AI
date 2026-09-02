/**
 * Row <-> entity mapping for the SQLite repositories.
 *
 * Why this exists: node:sqlite binds only string | number | bigint | null |
 * Uint8Array (booleans and undefined throw), every table stores arrays and
 * objects as JSON text and booleans as 0/1, and columns are snake_case while
 * entity fields are camelCase. Each repository declares its table once as a
 * list of `ColumnSpec`s; the helpers below derive the INSERT / SELECT / UPDATE
 * fragments from that list and convert values in both directions.
 *
 * Table and column names are compile-time constants taken from the specs.
 * Values only ever travel as positional `?` parameters — nothing here (or in
 * the repositories) interpolates a value into SQL text.
 */
import type { Db } from "../../db/client.ts";

export type SqlValue = string | number | null;
export type Row = Record<string, unknown>;
export type ColumnKind = "text" | "number" | "bool" | "json";

export interface ColumnSpec<T> {
  /** Entity field name (camelCase). */
  field: keyof T & string;
  /** Table column name (snake_case). */
  column: string;
  kind: ColumnKind;
  /** Produces the value used when a JSON column is NULL or unparsable. */
  fallback: () => unknown;
}

export interface TableSpec<T> {
  name: string;
  columns: ColumnSpec<T>[];
}

type SpecFactory<T> = (field: keyof T & string, column?: string) => ColumnSpec<T>;

export interface ColumnFactories<T> {
  text: SpecFactory<T>;
  number: SpecFactory<T>;
  bool: SpecFactory<T>;
  /** Nullable JSON value; NULL or unreadable -> null. */
  json: SpecFactory<T>;
  /** JSON array column; NULL or unreadable -> []. */
  list: SpecFactory<T>;
  /** JSON object column; NULL or unreadable -> {}. */
  record: SpecFactory<T>;
}

/** "companyName" -> "company_name" */
export function snakeCase(field: string): string {
  return field.replace(/[A-Z]/g, (ch) => "_" + ch.toLowerCase());
}

/** Bind the spec helpers to one entity type so field names are type-checked. */
export function defineColumns<T>(): ColumnFactories<T> {
  const make =
    (kind: ColumnKind, fallback: () => unknown): SpecFactory<T> =>
    (field, column = snakeCase(field)) => ({ field, column, kind, fallback });
  return {
    text: make("text", () => null),
    number: make("number", () => null),
    bool: make("bool", () => false),
    json: make("json", () => null),
    list: make("json", () => []),
    record: make("json", () => ({})),
  };
}

export function parseJson<T>(value: unknown, fallback: () => T): T {
  if (typeof value !== "string" || value === "") return fallback();
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback();
  }
}

/** Entity value -> bindable SQLite value. */
export function toSql(value: unknown, kind: ColumnKind): SqlValue {
  if (value === undefined || value === null) return null;
  switch (kind) {
    case "text":
      return typeof value === "string" ? value : String(value);
    case "number": {
      const n = typeof value === "number" ? value : Number(value);
      return Number.isFinite(n) ? n : null;
    }
    case "bool":
      return value ? 1 : 0;
    case "json":
      return JSON.stringify(value);
  }
}

/** SQLite column value -> entity value. */
export function fromSql(value: unknown, spec: Pick<ColumnSpec<unknown>, "kind" | "fallback">): unknown {
  switch (spec.kind) {
    case "text":
      return value === undefined || value === null ? null : String(value);
    case "number":
      return value === undefined || value === null ? null : Number(value);
    case "bool":
      return value === 1 || value === 1n || value === true || value === "1";
    case "json":
      return parseJson(value, spec.fallback);
  }
}

export function rowToEntity<T>(row: Row, spec: TableSpec<T>): T {
  const out: Record<string, unknown> = {};
  for (const col of spec.columns) out[col.field] = fromSql(row[col.column], col);
  return out as T;
}

export function entityToParams<T>(entity: T, columns: ColumnSpec<T>[]): SqlValue[] {
  const source = entity as unknown as Record<string, unknown>;
  return columns.map((col) => toSql(source[col.field], col.kind));
}

/** "?, ?, ?" for `count` parameters. */
export function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

export function changeCount(result: { changes: number | bigint }): number {
  return Number(result.changes);
}

export function selectSql<T>(spec: TableSpec<T>, tail = ""): string {
  const cols = spec.columns.map((col) => col.column).join(", ");
  return `SELECT ${cols} FROM ${spec.name}${tail ? " " + tail : ""}`;
}

/** `tail` is a constant SQL fragment such as "WHERE id = ?"; values go in `params`. */
export function selectOne<T>(db: Db, spec: TableSpec<T>, tail: string, params: SqlValue[]): T | null {
  const row = db.prepare(selectSql(spec, tail)).get(...params) as Row | undefined;
  return row ? rowToEntity(row, spec) : null;
}

export function selectMany<T>(db: Db, spec: TableSpec<T>, tail: string, params: SqlValue[]): T[] {
  const rows = db.prepare(selectSql(spec, tail)).all(...params) as Row[];
  return rows.map((row) => rowToEntity(row, spec));
}

/** INSERT every spec column plus any `extra` derived columns (name -> value). */
export function insertEntity<T>(db: Db, spec: TableSpec<T>, entity: T, extra: Record<string, SqlValue> = {}): void {
  const columns = [...spec.columns.map((col) => col.column), ...Object.keys(extra)];
  const params = [...entityToParams(entity, spec.columns), ...Object.values(extra)];
  db.prepare(`INSERT INTO ${spec.name} (${columns.join(", ")}) VALUES (${placeholders(columns.length)})`).run(
    ...params,
  );
}

export interface Assignments {
  sets: string[];
  params: SqlValue[];
}

/** "col = ?" fragments for every patch field that is present (not undefined) and not in `skip`. */
export function patchAssignments<T>(patch: Partial<T>, spec: TableSpec<T>, skip: readonly string[] = []): Assignments {
  const sets: string[] = [];
  const params: SqlValue[] = [];
  const source = patch as unknown as Record<string, unknown>;
  for (const col of spec.columns) {
    if (skip.includes(col.field)) continue;
    const value = source[col.field];
    if (value === undefined) continue;
    sets.push(`${col.column} = ?`);
    params.push(toSql(value, col.kind));
  }
  return { sets, params };
}

/** UPDATE by primary key. Returns whether a row with that id exists. */
export function updateById<T>(db: Db, spec: TableSpec<T>, id: string, assignments: Assignments): boolean {
  if (assignments.sets.length === 0) {
    return db.prepare(`SELECT 1 FROM ${spec.name} WHERE id = ?`).get(id) !== undefined;
  }
  const result = db
    .prepare(`UPDATE ${spec.name} SET ${assignments.sets.join(", ")} WHERE id = ?`)
    .run(...assignments.params, id);
  return changeCount(result) > 0;
}

export function deleteById(db: Db, table: string, id: string): boolean {
  return changeCount(db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id)) > 0;
}

/** Removes every row; returns how many were deleted. */
export function deleteAllRows(db: Db, table: string): number {
  return changeCount(db.prepare(`DELETE FROM ${table}`).run());
}

/** True when `err` is SQLite's UNIQUE-constraint failure (extended code 2067). */
export function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; errcode?: unknown; message?: unknown };
  if (e.errcode === 2067) return true;
  return e.code === "ERR_SQLITE_ERROR" && typeof e.message === "string" && /UNIQUE constraint failed/.test(e.message);
}
