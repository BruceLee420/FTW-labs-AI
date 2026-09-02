/**
 * AI layer: the Ollama provider against an injected fetch fake, the disabled
 * provider, provider selection, JSON candidate extraction and the
 * validate-then-repair loop in generateStructured. No network.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { modelMatches, OllamaProvider } from "../src/ai/ollama.ts";
import { NoneProvider } from "../src/ai/none.ts";
import { createAiProvider } from "../src/ai/index.ts";
import { AiInvalidOutputError, AiUnavailableError } from "../src/ai/provider.ts";
import { extractJsonCandidate, generateStructured } from "../src/ai/structured.ts";
import { FakeAiProvider } from "./helpers/harness.ts";

// ---------------------------------------------------------------- helpers

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}
type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

function fakeFetch(handler: Handler): typeof fetch & { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    return handler(url, init);
  };
  return Object.assign(fn as unknown as typeof fetch, { calls });
}

const BASE = "http://ollama.test:11434";
const jsonResponse = (data: unknown, status = 200): Response => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

function ollama(handler: Handler, overrides: Partial<{ model: string; timeoutMs: number; baseUrl: string }> = {}) {
  const fetchImpl = fakeFetch(handler);
  const provider = new OllamaProvider({ baseUrl: `${BASE}/`, model: "llama3.1", timeoutMs: 1_000, fetchImpl, ...overrides });
  return { provider, fetchImpl };
}

const hanging: Handler = (_url, init) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });

// --------------------------------------------------------- OllamaProvider

describe("OllamaProvider.health", () => {
  test("reports reachable + modelAvailable when /api/tags lists the model", async () => {
    const { provider, fetchImpl } = ollama(() => jsonResponse({ models: [{ name: "llama3.1:latest" }, { name: "mistral:latest" }] }));
    const h = await provider.health();
    assert.equal(h.provider, "ollama");
    assert.equal(h.model, "llama3.1");
    assert.equal(h.reachable, true);
    assert.equal(h.modelAvailable, true);
    assert.deepEqual(h.availableModels, ["llama3.1:latest", "mistral:latest"]);
    assert.match(h.message, /available/);
    assert.ok(!Number.isNaN(Date.parse(h.checkedAt)));
    assert.equal(fetchImpl.calls[0]?.url, `${BASE}/api/tags`, "trailing slash on baseUrl is stripped");
  });

  test("reachable but model missing → modelAvailable false with a pull hint", async () => {
    const { provider } = ollama(() => jsonResponse({ models: [{ name: "mistral:latest" }] }));
    const h = await provider.health();
    assert.equal(h.reachable, true);
    assert.equal(h.modelAvailable, false);
    assert.deepEqual(h.availableModels, ["mistral:latest"]);
    assert.match(h.message, /ollama pull llama3\.1/);
  });

  test("network error → reachable false with a serve hint", async () => {
    const { provider } = ollama(async () => {
      throw new TypeError("fetch failed");
    });
    const h = await provider.health();
    assert.equal(h.reachable, false);
    assert.equal(h.modelAvailable, false);
    assert.deepEqual(h.availableModels, []);
    assert.match(h.message, /ollama serve/);
  });

  test("non-2xx → reachable false mentioning the status", async () => {
    const { provider } = ollama(() => new Response("boom", { status: 500 }));
    const h = await provider.health();
    assert.equal(h.reachable, false);
    assert.match(h.message, /HTTP 500/);
  });

  test("tolerates an empty or malformed tag list", async () => {
    const { provider } = ollama(() => jsonResponse({}));
    const h = await provider.health();
    assert.equal(h.reachable, true);
    assert.equal(h.modelAvailable, false);
    assert.deepEqual(h.availableModels, []);
  });
});

describe("modelMatches", () => {
  test("table", () => {
    const cases: [string, string, boolean][] = [
      ["llama3.1", "llama3.1", true],
      ["llama3.1", "llama3.1:latest", true],
      ["llama3.1", "llama3.1:8b", true],
      ["llama3.1", "llama3.10:latest", false],
      ["llama3.1", "llama3", false],
      ["llama3.1:8b", "llama3.1:8b", true],
      ["llama3.1:8b", "llama3.1:latest", false],
      ["mistral", "llama3.1:latest", false],
    ];
    for (const [configured, listed, expected] of cases) assert.equal(modelMatches(configured, listed), expected, `${configured} vs ${listed}`);
  });
});

describe("OllamaProvider.generate", () => {
  test("POSTs the expected body and returns text/model", async () => {
    const schema = { type: "object", properties: { a: { type: "number" } }, required: ["a"] };
    const { provider, fetchImpl } = ollama(() => jsonResponse({ response: '{"a":1}', model: "llama3.1:latest" }));
    const result = await provider.generate("hello", { system: "sys", jsonSchema: schema, temperature: 0.7 });
    assert.equal(result.text, '{"a":1}');
    assert.equal(result.model, "llama3.1:latest");
    assert.equal(result.provider, "ollama");
    assert.ok(result.durationMs >= 0);

    const call = fetchImpl.calls[0];
    assert.equal(call?.url, `${BASE}/api/generate`);
    assert.equal(call?.init?.method, "POST");
    assert.equal((call?.init?.headers as Record<string, string>)["Content-Type"], "application/json");
    const body = JSON.parse(String(call?.init?.body)) as Record<string, unknown>;
    assert.equal(body.model, "llama3.1");
    assert.equal(body.prompt, "hello");
    assert.equal(body.system, "sys");
    assert.equal(body.stream, false);
    assert.deepEqual(body.format, schema);
    assert.deepEqual(body.options, { temperature: 0.7 });
  });

  test("defaults: format 'json', temperature 0.2, model falls back to the configured name", async () => {
    const { provider, fetchImpl } = ollama(() => jsonResponse({ response: "{}" }));
    const result = await provider.generate("p");
    assert.equal(result.model, "llama3.1");
    const body = JSON.parse(String(fetchImpl.calls[0]?.init?.body)) as Record<string, unknown>;
    assert.equal(body.format, "json");
    assert.deepEqual(body.options, { temperature: 0.2 });
    assert.equal("system" in body, false, "undefined system is omitted from JSON");
  });

  test("HTTP 500 → AiUnavailableError", async () => {
    const { provider } = ollama(() => new Response("boom", { status: 500 }));
    await assert.rejects(provider.generate("p"), (err: unknown) => err instanceof AiUnavailableError && /HTTP 500/.test(err.message));
  });

  test("fetch rejection → AiUnavailableError", async () => {
    const { provider } = ollama(async () => {
      throw new TypeError("fetch failed");
    });
    await assert.rejects(provider.generate("p"), (err: unknown) => err instanceof AiUnavailableError && /not reachable/.test(err.message));
  });

  test("timeout → AiUnavailableError mentioning the timeout", async () => {
    const { provider } = ollama(hanging, { timeoutMs: 20 });
    await assert.rejects(provider.generate("p"), (err: unknown) => err instanceof AiUnavailableError && /timeout/i.test(err.message));
    // Per-call override.
    const slow = ollama(hanging, { timeoutMs: 60_000 });
    await assert.rejects(slow.provider.generate("p", { timeoutMs: 20 }), AiUnavailableError);
  });
});

// ----------------------------------------------- NoneProvider + selection

describe("NoneProvider and createAiProvider", () => {
  test("NoneProvider reports unreachable and refuses to generate", async () => {
    const p = new NoneProvider();
    assert.equal(p.id, "none");
    assert.equal(p.model, null);
    const h = await p.health();
    assert.equal(h.reachable, false);
    assert.equal(h.modelAvailable, false);
    assert.match(h.message, /disabled/i);
    await assert.rejects(p.generate(), AiUnavailableError);
  });

  test("createAiProvider selects by config", () => {
    const base = { ollamaBaseUrl: BASE, ollamaModel: "llama3.1", aiTimeoutMs: 1_000 };
    assert.ok(createAiProvider({ ...base, aiProvider: "none" }) instanceof NoneProvider);
    const p = createAiProvider({ ...base, aiProvider: "ollama" }, fakeFetch(() => jsonResponse({})));
    assert.ok(p instanceof OllamaProvider);
    assert.equal(p.id, "ollama");
    assert.equal(p.model, "llama3.1");
  });
});

// ---------------------------------------------------- extractJsonCandidate

describe("extractJsonCandidate", () => {
  test("strips ```json fences", () => {
    assert.equal(extractJsonCandidate('```json\n{"a": 1}\n```'), '{"a": 1}');
    assert.equal(extractJsonCandidate('Sure:\n```\n{"a": 1}\n```\nDone.'), '{"a": 1}');
  });

  test("ignores prose before and after", () => {
    assert.equal(extractJsonCandidate('Here you go: {"a": 1} hope it helps'), '{"a": 1}');
  });

  test("braces inside strings do not end the object", () => {
    const s = '{"a": "}{", "b": {"c": "say \\"hi\\" }"}, "d": [1, "]"]}';
    assert.equal(extractJsonCandidate(`prefix ${s} suffix`), s);
  });

  test("arrays are candidates too", () => {
    assert.equal(extractJsonCandidate('Result: [1, 2, {"x": 3}] end'), '[1, 2, {"x": 3}]');
  });

  test("returns null when nothing balanced is found", () => {
    assert.equal(extractJsonCandidate("no json here"), null);
    assert.equal(extractJsonCandidate('{"unterminated": 1'), null);
    assert.equal(extractJsonCandidate(""), null);
  });
});

// ------------------------------------------------------ generateStructured

const Schema = z.object({ score: z.number().int().min(0).max(100), note: z.string() });
const prompt = { system: "sys", user: "user prompt" };

describe("generateStructured", () => {
  test("valid first answer → attempts 1, derived JSON schema passed to the provider", async () => {
    const fake = new FakeAiProvider("fake-model");
    fake.responses.push({ score: 50, note: "ok" });
    const r = await generateStructured(fake, Schema, prompt);
    assert.deepEqual(r.data, { score: 50, note: "ok" });
    assert.equal(r.attempts, 1);
    assert.equal(r.model, "fake-model");
    assert.ok(r.durationMs >= 0);
    assert.equal(fake.calls.length, 1);
    const call = fake.calls[0];
    assert.equal(call?.prompt, "user prompt");
    assert.equal(call?.options?.system, "sys");
    const js = call?.options?.jsonSchema;
    assert.ok(js, "jsonSchema derived from zod");
    assert.equal(js.type, "object");
    assert.deepEqual(Object.keys(js.properties as Record<string, unknown>).sort(), ["note", "score"]);
  });

  test("invalid then valid → attempts 2 with a repair prompt naming the issue", async () => {
    const fake = new FakeAiProvider();
    fake.responses.push({ score: "high", note: "x" }, 'Fixed:\n```json\n{"score": 90, "note": "x"}\n```');
    const r = await generateStructured(fake, Schema, prompt, { temperature: 0.5 });
    assert.equal(r.attempts, 2);
    assert.deepEqual(r.data, { score: 90, note: "x" });
    assert.equal(fake.calls.length, 2);
    assert.equal(fake.calls[0]?.options?.temperature, 0.5);
    const second = fake.calls[1];
    assert.ok(second);
    assert.match(second.prompt, /score/);
    assert.match(second.prompt, /fixes every problem/);
    assert.ok(second.prompt.includes('"high"'), "repair prompt carries the previous raw reply");
    assert.equal(second.options?.temperature, 0, "repair runs at temperature 0");
    assert.equal(second.options?.system, "sys");
  });

  test("invalid twice → AiInvalidOutputError carrying the issues", async () => {
    const fake = new FakeAiProvider();
    fake.responses.push({ score: 500, note: "x" }, { score: 7 });
    await assert.rejects(generateStructured(fake, Schema, prompt), (err: unknown) => {
      assert.ok(err instanceof AiInvalidOutputError);
      assert.equal(err.name, "AiInvalidOutputError");
      assert.ok(err.issues.length > 0);
      assert.match(err.issues.join("\n"), /note/);
      return true;
    });
    assert.equal(fake.calls.length, 2);
  });

  test("non-JSON output produces a 'No JSON object found' issue", async () => {
    const fake = new FakeAiProvider();
    fake.responses.push("I cannot help with that.", "Still no.");
    await assert.rejects(generateStructured(fake, Schema, prompt), (err: unknown) => err instanceof AiInvalidOutputError && err.issues.some((i) => /No JSON object found/.test(i)));
    assert.match(fake.calls[1]?.prompt ?? "", /No JSON object found/);
  });

  test("an explicit jsonSchema and repairPrompt are used verbatim", async () => {
    const fake = new FakeAiProvider();
    fake.responses.push("nope", { score: 1, note: "n" });
    const jsonSchema = { type: "object", custom: true };
    const r = await generateStructured(fake, Schema, prompt, { jsonSchema, repairPrompt: (issues, raw) => `REPAIR ${issues.length} ${raw}` });
    assert.equal(r.attempts, 2);
    assert.deepEqual(fake.calls[0]?.options?.jsonSchema, jsonSchema);
    assert.equal(fake.calls[1]?.prompt, "REPAIR 1 nope");
  });

  test("provider failures propagate as AiUnavailableError", async () => {
    const fake = new FakeAiProvider();
    fake.reachable = false;
    await assert.rejects(generateStructured(fake, Schema, prompt), AiUnavailableError);
  });
});
