/** Query-string → object for zod. Repeated keys and comma lists both become arrays. */
const ARRAY_KEYS = new Set(["status", "sourceType", "workMode", "geographicEligibility", "verificationStatus"]);

export function queryToObject(url: URL): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key).flatMap((v) => (ARRAY_KEYS.has(key) ? v.split(",") : [v])).map((v) => v.trim()).filter(Boolean);
    if (!values.length) continue;
    out[key] = ARRAY_KEYS.has(key) ? values : values[values.length - 1];
  }
  return out;
}
