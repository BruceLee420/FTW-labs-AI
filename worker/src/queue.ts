/**
 * Studio Drop review queue — state, edits, and the auto-deploy timer.
 *
 * The deal: a piece marked Final gets drafted copy and a price, then sits for
 * a grace window. If you don't touch it, it publishes itself. If you do, your
 * edits win. After it's live you can still edit and re-publish in place.
 *
 * The timer runs in a Cloudflare Cron Trigger, not the browser — a countdown
 * that dies when the tab closes would defeat the whole point.
 *
 * HOLD CONDITIONS OVERRIDE THE TIMER. Auto-deploy is for the ordinary case;
 * anything that looks wrong stops and waits for a human no matter how long the
 * clock has run. Those checks are in `evaluateHolds` and are deliberately
 * conservative — the cost of a delayed listing is an hour, the cost of a bad
 * one going live is a refund and a bad review.
 */

import { publishListing, updateListing, type EtsyEnv } from "./etsy";

/** What the publish step needs: Etsy config, the bucket, and the master switch. */
export type PublishEnv = EtsyEnv & {
  PUBLISH_ENABLED?: string;
  DROPS: R2Bucket;
};

export interface QueueRow {
  id: string;
  r2_key: string;
  stage: string;
  title: string | null;
  description: string | null;
  tags: string | null;
  price_cents: number | null;
  currency: string;
  base_cost_cents: number | null;
  margin_floor_pct: number;
  status: "queued" | "held" | "publishing" | "published" | "failed" | "cancelled";
  hold_reasons: string | null;
  publish_after: number | null;
  paused: number;
  external_id: string | null;
  external_url: string | null;
  /** Price at the moment it last went live, so a later price edit is detectable. */
  published_price_cents: number | null;
  attempts: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  published_at: number | null;
}

export const now = () => Math.floor(Date.now() / 1000);

/** Default grace window before a queued piece publishes itself. */
export const DEFAULT_WINDOW_MINUTES = 120;

const MAX_ATTEMPTS = 3;

/**
 * Reasons a piece must not auto-publish. An empty array means the timer is
 * allowed to fire; anything else pins it to `held` until a human resolves it.
 */
export function evaluateHolds(row: QueueRow): string[] {
  const holds: string[] = [];

  const title = (row.title ?? "").trim();
  const description = (row.description ?? "").trim();

  if (!title) holds.push("No title was drafted.");
  else if (title.length < 8) holds.push("Title looks too short to be a real listing.");
  if (!description) holds.push("No description was drafted.");
  else if (description.length < 40) holds.push("Description looks too short to be a real listing.");

  if (row.price_cents === null || row.price_cents <= 0) {
    holds.push("No price was set.");
  } else if (row.base_cost_cents !== null && row.base_cost_cents > 0) {
    // The margin floor is the whole reason pricing is automated at all —
    // never let the timer ship something that loses money.
    const margin = (row.price_cents - row.base_cost_cents) / row.price_cents;
    const floor = row.margin_floor_pct / 100;
    if (margin < floor) {
      holds.push(
        `Margin ${(margin * 100).toFixed(1)}% is below your ${row.margin_floor_pct}% floor ` +
          `(price ${(row.price_cents / 100).toFixed(2)} vs cost ${(row.base_cost_cents / 100).toFixed(2)}).`,
      );
    }
  }

  if (row.stage !== "final") holds.push("Only pieces marked Final can be published.");

  return holds;
}

export async function logEvent(db: D1Database, queueId: string, event: string, detail: string, actor: string) {
  await db
    .prepare("INSERT INTO queue_events (queue_id, event, detail, actor, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(queueId, event, detail, actor, now())
    .run();
}

export async function listQueue(db: D1Database, limit = 50): Promise<QueueRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM queue ORDER BY created_at DESC LIMIT ?")
    .bind(limit)
    .all<QueueRow>();
  return results ?? [];
}

export async function getRow(db: D1Database, id: string): Promise<QueueRow | null> {
  return db.prepare("SELECT * FROM queue WHERE id = ?").bind(id).first<QueueRow>();
}

export async function enqueue(
  db: D1Database,
  input: { r2Key: string; stage: string; windowMinutes?: number },
  actor: string,
): Promise<string> {
  const id = crypto.randomUUID();
  const t = now();
  const windowMinutes = input.windowMinutes ?? DEFAULT_WINDOW_MINUTES;

  await db
    .prepare(
      `INSERT INTO queue (id, r2_key, stage, status, publish_after, created_at, updated_at)
       VALUES (?, ?, ?, 'queued', ?, ?, ?)`,
    )
    .bind(id, input.r2Key, input.stage, t + windowMinutes * 60, t, t)
    .run();

  await logEvent(db, id, "queued", `Window ${windowMinutes}m`, actor);
  return id;
}

/**
 * Apply an edit. Works before OR after publishing — after, it flips the row
 * back to `queued` with a fresh window so the change actually reaches the
 * store rather than only living in the database.
 */
export async function applyEdit(
  db: D1Database,
  id: string,
  patch: Partial<Pick<QueueRow, "title" | "description" | "tags" | "price_cents">>,
  opts: { windowMinutes?: number },
  actor: string,
): Promise<QueueRow | null> {
  const row = await getRow(db, id);
  if (!row) return null;
  if (row.status === "publishing") return row; // don't mutate mid-flight

  const merged: QueueRow = { ...row, ...patch };
  const holds = evaluateHolds(merged);
  const wasPublished = row.status === "published";
  const windowMinutes = opts.windowMinutes ?? DEFAULT_WINDOW_MINUTES;
  const t = now();

  // Edits re-arm the clock. Publishing something the moment you stop typing
  // would remove the very grace period the queue exists to provide.
  const status = holds.length > 0 ? "held" : "queued";
  const publishAfter = holds.length > 0 ? null : t + windowMinutes * 60;

  await db
    .prepare(
      `UPDATE queue SET title = ?, description = ?, tags = ?, price_cents = ?,
        status = ?, hold_reasons = ?, publish_after = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      merged.title,
      merged.description,
      merged.tags,
      merged.price_cents,
      status,
      holds.length ? JSON.stringify(holds) : null,
      publishAfter,
      t,
      id,
    )
    .run();

  await logEvent(
    db,
    id,
    wasPublished ? "edited_after_publish" : "edited",
    holds.length ? `Held: ${holds.join(" ")}` : `Re-queued, window ${windowMinutes}m`,
    actor,
  );

  return getRow(db, id);
}

export async function setPaused(db: D1Database, id: string, paused: boolean, actor: string) {
  await db.prepare("UPDATE queue SET paused = ?, updated_at = ? WHERE id = ?").bind(paused ? 1 : 0, now(), id).run();
  await logEvent(db, id, paused ? "paused" : "resumed", "", actor);
}

export async function cancel(db: D1Database, id: string, actor: string) {
  await db
    .prepare("UPDATE queue SET status = 'cancelled', publish_after = NULL, updated_at = ? WHERE id = ?")
    .bind(now(), id)
    .run();
  await logEvent(db, id, "cancelled", "", actor);
}

/** Rows whose window has elapsed and which nothing is holding back. */
export async function dueForPublish(db: D1Database): Promise<QueueRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM queue
        WHERE status = 'queued' AND paused = 0
          AND publish_after IS NOT NULL AND publish_after <= ?
          AND attempts < ?
        ORDER BY publish_after ASC LIMIT 10`,
    )
    .bind(now(), MAX_ATTEMPTS)
    .all<QueueRow>();
  return results ?? [];
}

/**
 * The storefront adapter — Etsy Open API v3.
 *
 * Etsy rather than Shopify because Shopify is still returning
 * `operation_not_allowed` (a billing/plan state), and Etsy rather than
 * Printful because Printful's Products API only operates on Manual-order/API
 * stores, not on a store connected to a marketplace. See src/etsy.ts for the
 * full reasoning and for the fulfilment gap this leaves.
 *
 * Two paths, decided by whether the row already has a listing:
 *   - no external_id  -> create draft, attach art, set active
 *   - has external_id -> edit the live listing in place, never duplicate
 */
export async function publishToStore(
  row: QueueRow,
  env: PublishEnv,
): Promise<{ ok: false; error: string } | { ok: true; externalId: string; externalUrl: string }> {
  if (!row.title || !row.description || !row.price_cents) {
    return { ok: false, error: "Missing title, description or price — nothing to publish." };
  }

  try {
    // Already live: edit in place.
    if (row.external_id) {
      // updateListing cannot change price; saying so beats a silent no-op that
      // leaves the storefront selling at the old number.
      if (row.published_price_cents !== null && row.published_price_cents !== row.price_cents) {
        return {
          ok: false,
          error:
            `Price changed (${(row.published_price_cents / 100).toFixed(2)} -> ` +
            `${(row.price_cents / 100).toFixed(2)}) but Etsy's updateListing cannot set price. ` +
            `Change it on the listing directly, or implement updateListingInventory. ` +
            `Title, description and tags were not written either, so the listing is unchanged.`,
        };
      }
      await updateListing(env, row.external_id, {
        title: row.title,
        description: row.description,
        tags: row.tags,
      });
      return {
        ok: true,
        externalId: row.external_id,
        externalUrl: row.external_url ?? `https://www.etsy.com/listing/${row.external_id}`,
      };
    }

    const object = await env.DROPS.get(row.r2_key);
    if (!object) return { ok: false, error: `Artwork ${row.r2_key} is no longer in the bucket.` };

    const result = await publishListing(
      env,
      {
        title: row.title,
        description: row.description,
        priceCents: row.price_cents,
        currency: row.currency,
        tags: row.tags,
      },
      {
        bytes: await object.arrayBuffer(),
        contentType: object.httpMetadata?.contentType ?? "image/png",
        filename: row.r2_key.split("/").pop() || "art.png",
      },
    );
    return { ok: true, externalId: result.listingId, externalUrl: result.url };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Publish (or re-publish) one row and record the outcome.
 *
 * Shared by the cron and the manual "publish now" action so a hand-triggered
 * test takes exactly the same path the timer will — testing a different code
 * path than the one that runs unattended proves nothing.
 */
export async function publishRow(
  db: D1Database,
  row: QueueRow,
  env: PublishEnv,
  actor: string,
): Promise<{ ok: boolean; detail: string }> {
  // Re-evaluate at fire time, not just at queue time — the data may have
  // changed since, and a stale "safe" verdict is exactly how bad listings
  // slip out.
  const holds = evaluateHolds(row);
  if (holds.length > 0) {
    await db
      .prepare("UPDATE queue SET status = 'held', hold_reasons = ?, publish_after = NULL, updated_at = ? WHERE id = ?")
      .bind(JSON.stringify(holds), now(), row.id)
      .run();
    await logEvent(db, row.id, "held", holds.join(" "), actor);
    return { ok: false, detail: holds.join(" ") };
  }

  if (env.PUBLISH_ENABLED !== "true") {
    const reason = "Publishing is disabled (PUBLISH_ENABLED is not 'true').";
    await db
      .prepare("UPDATE queue SET status = 'held', hold_reasons = ?, publish_after = NULL, updated_at = ? WHERE id = ?")
      .bind(JSON.stringify([reason]), now(), row.id)
      .run();
    await logEvent(db, row.id, "held", "Publishing disabled", actor);
    return { ok: false, detail: reason };
  }

  await db.prepare("UPDATE queue SET status = 'publishing', updated_at = ? WHERE id = ?").bind(now(), row.id).run();

  const result = await publishToStore(row, env);
  const t = now();

  if (result.ok) {
    await db
      .prepare(
        `UPDATE queue SET status = 'published', external_id = ?, external_url = ?,
           published_price_cents = ?, published_at = ?, updated_at = ?, last_error = NULL
         WHERE id = ?`,
      )
      .bind(result.externalId, result.externalUrl, row.price_cents, t, t, row.id)
      .run();
    await logEvent(db, row.id, "published", result.externalUrl, actor);
    return { ok: true, detail: result.externalUrl };
  }

  const attempts = row.attempts + 1;
  // Give up rather than retry forever — a stuck row that keeps hammering the
  // store is worse than one that waits for a human.
  const status = attempts >= MAX_ATTEMPTS ? "failed" : "queued";
  await db
    .prepare(
      `UPDATE queue SET status = ?, attempts = ?, last_error = ?,
         publish_after = ?, updated_at = ? WHERE id = ?`,
    )
    .bind(status, attempts, result.error, status === "queued" ? t + 900 : null, t, row.id)
    .run();
  await logEvent(db, row.id, status === "failed" ? "failed" : "publish_error", result.error, actor);
  return { ok: false, detail: result.error };
}

/** Cron entry point. Walks due rows, re-checks holds, publishes or defers. */
export async function runAutoDeploy(db: D1Database, env: PublishEnv): Promise<void> {
  const due = await dueForPublish(db);
  for (const row of due) {
    await publishRow(db, row, env, "system");
  }
}
