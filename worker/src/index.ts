/**
 * FTW Labs AI — Studio Drop worker.
 *
 * Accepts one piece of art, validates it, and streams it into R2. Nothing
 * else. It is the only writer to the bucket.
 *
 * WHY THERE ARE NO S3 CREDENTIALS HERE
 * -----------------------------------
 * The obvious design is a pre-signed-URL minter: the Worker signs a PUT and
 * the browser uploads straight to R2. That requires R2 access keys living in
 * the Worker — i.e. it reintroduces exactly the credential you were trying to
 * keep out of the browser, and it hands the client a URL you can no longer
 * inspect. Since Workers accept 100MB request bodies (Free plan) and art
 * drops are ~50MB, we stream through the Worker into the R2 *binding*
 * instead. No access key exists to leak, no bucket CORS to misconfigure, and
 * the Worker sees the actual bytes so it can enforce real rules.
 *
 * Trade-off, stated plainly: files above ~100MB will not fit this design and
 * would need pre-signed uploads. See docs/STUDIO_DROP.md.
 *
 * SECURITY MODEL
 * --------------
 *  - Cloudflare Access sits in front. Every request must carry a valid Access
 *    JWT, which is verified here against the team JWKS. The Worker never
 *    assumes it is only reachable through Access.
 *  - Content type is chosen by the SERVER from an allowlist and confirmed
 *    against the file's magic bytes. The client's claimed type is advisory.
 *  - Size is enforced server-side; the client's number is never trusted.
 *  - The bucket stays PRIVATE. Reads are served back through this Worker with
 *    a forced Content-Type and nosniff, so a hostile upload cannot become
 *    active content on the domain.
 *  - Errors are generic to the client; details go to the Worker log only.
 */

import { createRemoteJWKSet, jwtVerify } from "jose";
import {
  applyEdit,
  cancel,
  DEFAULT_WINDOW_MINUTES,
  enqueue,
  getRow,
  listQueue,
  runAutoDeploy,
  setPaused,
} from "./queue";

export interface Env {
  DROPS: R2Bucket;
  DB: D1Database;
  /** Must be exactly "true" for the cron to publish anything. */
  PUBLISH_ENABLED?: string;
  /** Grace window in minutes before a queued piece auto-publishes. */
  PUBLISH_WINDOW_MINUTES?: string;
  /** Zero Trust team domain, e.g. "ftwlabs.cloudflareaccess.com". */
  ACCESS_TEAM_DOMAIN: string;
  /** Access application AUD tag. */
  ACCESS_AUD: string;
  /** Origin permitted to call this worker, e.g. "https://ftwlabs.ai". */
  ALLOWED_ORIGIN: string;
  /** Optional: Workers rate-limiting binding. */
  UPLOAD_LIMITER?: { limit(o: { key: string }): Promise<{ success: boolean }> };
}

const MAX_BYTES = 50 * 1024 * 1024;

/**
 * Server-side allowlist. The stored Content-Type is taken from THIS table,
 * never from the request, so a client cannot cause `text/html` to be stored
 * and later served from our own hostname.
 */
const ALLOWED = {
  "image/png": { ext: "png", magic: [[0x89, 0x50, 0x4e, 0x47]] },
  "image/jpeg": { ext: "jpg", magic: [[0xff, 0xd8, 0xff]] },
  "image/webp": { ext: "webp", magic: [[0x52, 0x49, 0x46, 0x46]] }, // "RIFF"; WEBP checked at offset 8
} as const;

type AllowedType = keyof typeof ALLOWED;

const STAGES = new Set(["sketch", "wip", "final"]);

function cors(env: Env, extra: Record<string, string> = {}): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Drop-Stage, X-Drop-Filename",
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin",
    ...extra,
  };
}

/** Generic to the caller; the real reason is logged, not returned. */
function fail(env: Env, status: number, message: string, logDetail?: unknown): Response {
  if (logDetail) console.error(`[drop] ${status} ${message}:`, logDetail);
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: cors(env, { "Content-Type": "application/json" }),
  });
}

/**
 * Verify the Cloudflare Access JWT. Cloudflare recommends the
 * Cf-Access-Jwt-Assertion header over the CF_Authorization cookie, because the
 * cookie is not guaranteed to be forwarded.
 */
async function requireAccess(request: Request, env: Env): Promise<{ email: string } | null> {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return null;
  try {
    const jwks = createRemoteJWKSet(new URL(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`));
    const { payload } = await jwtVerify(token, jwks, {
      issuer: `https://${env.ACCESS_TEAM_DOMAIN}`,
      audience: env.ACCESS_AUD,
    });
    const email = typeof payload.email === "string" ? payload.email : "";
    return email ? { email } : null;
  } catch (err) {
    console.error("[drop] access token rejected:", err);
    return null;
  }
}

/** Confirm the bytes really are the image type claimed. */
function sniff(head: Uint8Array): AllowedType | null {
  const starts = (sig: readonly number[], offset = 0) => sig.every((b, i) => head[offset + i] === b);
  if (starts(ALLOWED["image/png"].magic[0])) return "image/png";
  if (starts(ALLOWED["image/jpeg"].magic[0])) return "image/jpeg";
  // WebP is "RIFF" .... "WEBP" — both halves must be present.
  if (starts(ALLOWED["image/webp"].magic[0]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  return null;
}

function safeName(raw: string): string {
  return (raw || "untitled").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
}

async function handleUpload(request: Request, env: Env, identity: { email: string }): Promise<Response> {
  const declared = (request.headers.get("Content-Type") || "").split(";")[0].trim();
  if (!(declared in ALLOWED)) {
    return fail(env, 415, "Only PNG, JPEG and WebP images are accepted.");
  }

  const declaredLength = Number(request.headers.get("Content-Length") || 0);
  if (declaredLength > MAX_BYTES) {
    return fail(env, 413, `File exceeds the ${MAX_BYTES / 1024 / 1024}MB limit.`);
  }
  if (!request.body) return fail(env, 400, "No file body received.");

  const stage = (request.headers.get("X-Drop-Stage") || "sketch").toLowerCase();
  if (!STAGES.has(stage)) return fail(env, 400, "Unknown drop stage.");

  // Read just enough to sniff the header, then rebuild the stream so the rest
  // still streams to R2 rather than being buffered into memory (the isolate
  // has 128MB and a 50MB buffer plus overhead gets uncomfortably close).
  const reader = request.body.getReader();
  const first = await reader.read();
  if (first.done || !first.value) return fail(env, 400, "Empty file.");

  const actual = sniff(first.value);
  if (!actual) {
    return fail(env, 415, "That file isn't a valid PNG, JPEG or WebP.");
  }
  if (actual !== declared) {
    return fail(env, 415, "File contents don't match the declared image type.");
  }

  let total = first.value.byteLength;
  let aborted = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(first.value!);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) return controller.close();
      total += value.byteLength;
      // Enforce the real limit on the wire — Content-Length can lie.
      if (total > MAX_BYTES) {
        aborted = true;
        controller.error(new Error("size limit exceeded mid-stream"));
        return;
      }
      controller.enqueue(value);
    },
    cancel() {
      void reader.cancel();
    },
  });

  const ext = ALLOWED[actual].ext;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const key = `drops/${stage}/${stamp}-${crypto.randomUUID().slice(0, 8)}-${safeName(
    request.headers.get("X-Drop-Filename") || `art.${ext}`,
  )}`;

  try {
    await env.DROPS.put(key, body, {
      // Stored type comes from the server-side allowlist, never the client.
      httpMetadata: { contentType: actual, contentDisposition: "inline" },
      customMetadata: {
        stage,
        uploadedBy: identity.email,
        uploadedAt: new Date().toISOString(),
        // Marks whether this is eligible for the publish queue. Only an
        // explicit "final" ever is — the safe default is that nothing ships.
        publishEligible: stage === "final" ? "true" : "false",
      },
    });
  } catch (err) {
    if (aborted) return fail(env, 413, `File exceeds the ${MAX_BYTES / 1024 / 1024}MB limit.`);
    return fail(env, 500, "Storing the file failed. Try again.", err);
  }

  console.log(`[drop] stored ${key} (${total} bytes, ${stage}) by ${identity.email}`);

  // Only a Final enters the queue. Sketches and WIPs are stored and nothing
  // more — the safe default is that nothing is ever queued by accident.
  let queueId: string | null = null;
  if (stage === "final") {
    const windowMinutes = Number(env.PUBLISH_WINDOW_MINUTES) || DEFAULT_WINDOW_MINUTES;
    queueId = await enqueue(env.DB, { r2Key: key, stage, windowMinutes }, identity.email);
  }

  return new Response(
    JSON.stringify({
      key,
      stage,
      bytes: total,
      contentType: actual,
      url: `/f/${encodeURIComponent(key)}`,
      queueId,
    }),
    { status: 201, headers: cors(env, { "Content-Type": "application/json" }) },
  );
}

/** Queue routes: list, edit (pre- and post-publish), pause, cancel. */
async function handleQueue(
  request: Request,
  env: Env,
  identity: { email: string },
  path: string,
): Promise<Response | null> {
  const windowMinutes = Number(env.PUBLISH_WINDOW_MINUTES) || DEFAULT_WINDOW_MINUTES;

  if (path === "/queue" && request.method === "GET") {
    const rows = await listQueue(env.DB);
    return new Response(
      JSON.stringify({
        items: rows,
        windowMinutes,
        publishEnabled: env.PUBLISH_ENABLED === "true",
        serverTime: Math.floor(Date.now() / 1000),
      }),
      { headers: cors(env, { "Content-Type": "application/json" }) },
    );
  }

  const match = path.match(/^\/queue\/([a-z0-9-]+)(\/[a-z]+)?$/i);
  if (!match) return null;
  const [, id, action] = match;

  if (request.method === "PATCH" && !action) {
    const body = (await request.json()) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    if (typeof body.title === "string") patch.title = body.title.slice(0, 300);
    if (typeof body.description === "string") patch.description = body.description.slice(0, 5000);
    if (typeof body.tags === "string") patch.tags = body.tags.slice(0, 500);
    if (typeof body.price_cents === "number" && Number.isFinite(body.price_cents)) {
      patch.price_cents = Math.max(0, Math.round(body.price_cents));
    }
    const updated = await applyEdit(env.DB, id, patch, { windowMinutes }, identity.email);
    if (!updated) return fail(env, 404, "No such queue item.");
    return new Response(JSON.stringify(updated), { headers: cors(env, { "Content-Type": "application/json" }) });
  }

  if (request.method === "POST" && (action === "/pause" || action === "/resume")) {
    await setPaused(env.DB, id, action === "/pause", identity.email);
    const row = await getRow(env.DB, id);
    return new Response(JSON.stringify(row), { headers: cors(env, { "Content-Type": "application/json" }) });
  }

  if (request.method === "POST" && action === "/cancel") {
    await cancel(env.DB, id, identity.email);
    return new Response(JSON.stringify({ ok: true }), { headers: cors(env, { "Content-Type": "application/json" }) });
  }

  return null;
}

/**
 * Serve a stored file back. The bucket itself stays private so this is the
 * only read path — which is what lets us force the content type and prevent a
 * stored file from ever executing as active content on the domain.
 */
async function handleFetchFile(key: string, env: Env): Promise<Response> {
  const object = await env.DROPS.get(key);
  if (!object) return new Response("Not found", { status: 404 });

  const stored = object.httpMetadata?.contentType ?? "";
  const type = (stored in ALLOWED ? stored : "application/octet-stream") as string;

  return new Response(object.body, {
    headers: {
      "Content-Type": type,
      "Content-Disposition": "inline",
      // Belt and braces against content sniffing turning an image into script.
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": "private, max-age=3600",
      etag: object.httpEtag,
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      // Without this the browser's preflight fails and no upload ever lands.
      return new Response(null, { status: 204, headers: cors(env) });
    }

    // Everything below requires a verified Access identity.
    const identity = await requireAccess(request, env);
    if (!identity) return fail(env, 401, "Not signed in.");

    if (url.pathname === "/upload" && request.method === "POST") {
      if (env.UPLOAD_LIMITER) {
        // Per-location and eventually consistent by design — abuse dampening,
        // not a quota. Access is the real gate.
        const { success } = await env.UPLOAD_LIMITER.limit({ key: identity.email });
        if (!success) return fail(env, 429, "Slow down a moment, then try again.");
      }
      return handleUpload(request, env, identity);
    }

    if (url.pathname.startsWith("/f/") && request.method === "GET") {
      return handleFetchFile(decodeURIComponent(url.pathname.slice(3)), env);
    }

    if (url.pathname.startsWith("/queue")) {
      const handled = await handleQueue(request, env, identity, url.pathname);
      if (handled) return handled;
    }

    if (url.pathname === "/whoami" && request.method === "GET") {
      return new Response(JSON.stringify({ email: identity.email }), {
        headers: cors(env, { "Content-Type": "application/json" }),
      });
    }

    return fail(env, 404, "No such endpoint.");
  },

  /**
   * Cron entry point — this is what makes auto-deploy real. The countdown has
   * to live server-side; a timer running in the browser stops the moment the
   * tab closes, which is precisely when you're off living your life.
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runAutoDeploy(env.DB, env).catch((err) => {
        console.error("[drop] auto-deploy run failed:", err);
      }),
    );
  },
};
