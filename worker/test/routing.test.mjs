/** Routing: the Workers route `ftwlabs.ai/api/studio/*` does not strip its prefix. */
import assert from "node:assert/strict";
import worker from "./index.bundle.mjs";

let pass = 0; const ok = (n) => { pass++; console.log(`  ok  ${n}`); };
const env = { ALLOWED_ORIGIN: "https://ftwlabs.ai", ACCESS_TEAM_DOMAIN: "t.cloudflareaccess.com", ACCESS_AUD: "aud" };
const get = (p) => worker.fetch(new Request(`https://ftwlabs.ai${p}`), env);

console.log("\nRoute prefix handling");
// /etsy/callback is the one handler that runs before the Access check, so it
// is the probe that can tell "route matched" from "rejected by Access".
for (const p of ["/api/studio/etsy/callback", "/etsy/callback"]) {
  const r = await get(p);
  assert.equal(r.status, 400, `${p} -> ${r.status}`);
  assert.match(await r.text(), /did not send back an authorization code/);
  ok(`${p} reaches the callback handler`);
}

for (const p of ["/api/studio/upload", "/api/studio/queue", "/api/studio/whoami", "/whoami"]) {
  const r = await get(p);
  assert.equal(r.status, 401, `${p} -> ${r.status} (want 401 = matched, blocked by Access; 404 = route bug)`);
  ok(`${p} matched a route and was stopped by Access, not lost as 404`);
}

const r = await get("/api/studio/nope");
assert.equal(r.status, 401);
ok("an unknown path still requires Access first (no pre-auth surface)");

const pre = await worker.fetch(new Request("https://ftwlabs.ai/api/studio/queue/x", { method: "OPTIONS" }), env);
assert.match(pre.headers.get("Access-Control-Allow-Methods"), /PATCH/);
ok("CORS preflight advertises PATCH, so queue edits are not blocked by the browser");

console.log(`\n${pass} checks passed.`);
