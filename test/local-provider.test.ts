import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  LocalModelProvider,
  localErrorCode,
  normalizeLocalEndpoint,
} from "../src/providers/local.ts";
import { ProviderRegistry } from "../src/providers/registry.ts";
import type { ProviderRequest } from "../src/types.ts";

type Reply = (request: IncomingMessage, response: ServerResponse) => void;

interface Stub {
  origin: string;
  reply(handler: Reply): void;
  seen: Array<{ method: string; url: string; body: string }>;
}

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

async function startStub(t: TestContext): Promise<Stub> {
  const seen: Stub["seen"] = [];
  let handler: Reply = (_request, response) => json(response, {}, 404);
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      seen.push({
        method: request.method ?? "",
        url: request.url ?? "",
        body: Buffer.concat(chunks).toString("utf8"),
      });
      handler(request, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    origin: `http://127.0.0.1:${address.port}`,
    reply: (next: Reply) => {
      handler = next;
    },
    seen,
  };
}

async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

function request(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    runId: "00000000-0000-4000-8000-0000000000aa",
    role: "reviewer",
    access: "read-only",
    workspace: process.cwd(),
    prompt: "synthetic prompt",
    model: "synthetic-local-model",
    authMode: "subscription",
    timeoutMs: 5_000,
    outputLimitBytes: 65_536,
    ...overrides,
  };
}

test("local endpoint validation only accepts explicit loopback origins", () => {
  assert.equal(normalizeLocalEndpoint("http://127.0.0.1:11434"), "http://127.0.0.1:11434");
  assert.equal(normalizeLocalEndpoint("  http://127.0.0.1:11434  "), "http://127.0.0.1:11434");
  assert.equal(normalizeLocalEndpoint("http://[::1]:1234"), "http://[::1]:1234");
  // localhost is accepted but pinned to the literal loopback address so a poisoned
  // hosts file or resolver cannot move the connection off the loopback interface.
  assert.equal(normalizeLocalEndpoint("http://localhost:1234"), "http://127.0.0.1:1234");

  for (const value of ["", "   ", "127.0.0.1:11434", "not a url", `http://127.0.0.1:${"1".repeat(300)}`]) {
    assert.throws(() => normalizeLocalEndpoint(value), /LOCAL_ENDPOINT_MALFORMED/u, value);
  }
  assert.throws(() => normalizeLocalEndpoint(11434), /LOCAL_ENDPOINT_MALFORMED/u);
  assert.throws(() => normalizeLocalEndpoint(undefined), /LOCAL_ENDPOINT_MALFORMED/u);

  for (const value of ["https://api.openai.com", "https://127.0.0.1:11434", "file:///etc/hosts", "ws://127.0.0.1:11434"]) {
    assert.throws(() => normalizeLocalEndpoint(value), /LOCAL_ENDPOINT_SCHEME_DENIED/u, value);
  }
  for (const value of [
    "http://user:pass@127.0.0.1:11434",
    "http://token@127.0.0.1:11434",
    "http://:token@127.0.0.1:11434",
  ]) {
    assert.throws(() => normalizeLocalEndpoint(value), /LOCAL_ENDPOINT_CREDENTIALS_DENIED/u, value);
  }
  for (const value of [
    "http://evil.example.com:11434",
    "http://10.0.0.5:11434",
    "http://127.0.0.2:11434",
    "http://[::ffff:127.0.0.1]:11434",
    "http://169.254.169.254:80",
  ]) {
    assert.throws(() => normalizeLocalEndpoint(value), /LOCAL_ENDPOINT_NOT_LOOPBACK/u, value);
  }
  assert.throws(() => normalizeLocalEndpoint("http://127.0.0.1"), /LOCAL_ENDPOINT_PORT_REQUIRED/u);
  assert.throws(() => normalizeLocalEndpoint("http://127.0.0.1:0"), /LOCAL_ENDPOINT_PORT_REQUIRED/u);
  for (const value of [
    "http://127.0.0.1:11434/v1",
    "http://127.0.0.1:11434/?q=1",
    "http://127.0.0.1:11434/#fragment",
  ]) {
    assert.throws(() => normalizeLocalEndpoint(value), /LOCAL_ENDPOINT_PATH_DENIED/u, value);
  }
  assert.throws(
    () => new LocalModelProvider({ endpoint: "http://models.example.com:11434" }),
    /LOCAL_ENDPOINT_NOT_LOOPBACK/u,
  );
});

test("local adapter discovers models from both local surfaces", async (t) => {
  const stub = await startStub(t);
  const provider = new LocalModelProvider({ endpoint: stub.origin, displayName: "Synthetic local models" });
  assert.equal(provider.capabilities.id, "local");
  assert.equal(provider.capabilities.displayName, "Synthetic local models");
  assert.equal(provider.capabilities.api, false);
  assert.equal(provider.capabilities.canWrite, false);
  assert.equal(provider.capabilities.canWriteApi, false);
  assert.equal(provider.capabilities.modelDiscovery, "endpoint");
  assert.equal(provider.endpoint, stub.origin);

  stub.reply((_request, response) =>
    json(response, { data: [{ id: "qwen3:8b" }, { id: "llama3.2" }, { id: "qwen3:8b" }] }),
  );
  assert.deepEqual(await provider.listModels(), ["qwen3:8b", "llama3.2"]);
  assert.equal(stub.seen.at(-1)?.url, "/v1/models");
  assert.equal(stub.seen.at(-1)?.method, "GET");

  // Servers without the OpenAI-compatible listing (older Ollama) fall back to /api/tags.
  stub.reply((httpRequest, response) => {
    if (httpRequest.url === "/v1/models") {
      json(response, { error: "not found" }, 404);
      return;
    }
    json(response, { models: [{ name: "mistral:7b" }] });
  });
  assert.deepEqual(await provider.listModels(), ["mistral:7b"]);
  assert.deepEqual(stub.seen.slice(-2).map((entry) => entry.url), ["/v1/models", "/api/tags"]);

  stub.reply((_httpRequest, response) => json(response, { data: [{ id: "qwen3:8b" }] }));
  assert.deepEqual(await provider.doctor(), { ok: true, version: "1 local model(s) available" });
});

test("local adapter fails closed on malformed model discovery payloads", async (t) => {
  const stub = await startStub(t);
  const provider = new LocalModelProvider({ endpoint: stub.origin, discoveryTimeoutMs: 2_000 });

  const cases: Array<[unknown, RegExp]> = [
    [{ data: {} }, /LOCAL_RESPONSE_SCHEMA_INVALID/u],
    [{ models: [] }, /LOCAL_RESPONSE_SCHEMA_INVALID/u],
    [{ data: ["qwen3:8b"] }, /LOCAL_RESPONSE_SCHEMA_INVALID/u],
    [{ data: [{ id: 42 }] }, /LOCAL_MODEL_ID_INVALID/u],
    [{ data: [{ id: "rm -rf /; qwen" }] }, /LOCAL_MODEL_ID_INVALID/u],
    [{ data: [] }, /LOCAL_MODELS_EMPTY/u],
    [{ data: Array.from({ length: 101 }, (_value, index) => ({ id: `m${index}` })) }, /LOCAL_MODEL_LIST_TOO_LARGE/u],
  ];
  for (const [payload, expected] of cases) {
    stub.reply((_request, response) => json(response, payload));
    await assert.rejects(provider.listModels(), expected, JSON.stringify(payload).slice(0, 60));
  }

  for (const fallback of [{ models: [{ name: 42 }] }, { models: "mistral" }, {}]) {
    stub.reply((httpRequest, response) => {
      if (httpRequest.url === "/v1/models") {
        json(response, {}, 404);
        return;
      }
      json(response, fallback);
    });
    await assert.rejects(
      provider.listModels(),
      /LOCAL_MODEL_ID_INVALID|LOCAL_RESPONSE_SCHEMA_INVALID/u,
      JSON.stringify(fallback),
    );
  }

  // Both discovery surfaces missing must surface a stable status code, not an empty list.
  stub.reply((_request, response) => json(response, {}, 404));
  await assert.rejects(provider.listModels(), /LOCAL_HTTP_STATUS:404/u);
  assert.deepEqual(await provider.doctor(), { ok: false, reason: "LOCAL_HTTP_STATUS:404" });

  const bounded = new LocalModelProvider({ endpoint: stub.origin, discoveryLimitBytes: 128 });
  stub.reply((_request, response) =>
    json(response, { data: Array.from({ length: 40 }, (_value, index) => ({ id: `model-${index}` })) }),
  );
  await assert.rejects(bounded.listModels(), /LOCAL_OUTPUT_LIMIT_REACHED/u);
});

test("local adapter runs a bounded non-streamed completion", async (t) => {
  const stub = await startStub(t);
  const provider = new LocalModelProvider({ endpoint: stub.origin });

  stub.reply((_request, response) =>
    json(response, {
      choices: [{ message: { role: "assistant", content: "local answer" } }],
      usage: { prompt_tokens: 3, completion_tokens: 5 },
    }),
  );
  const result = await provider.invoke(request());
  assert.equal(result.provider, "local");
  assert.equal(result.model, "synthetic-local-model");
  assert.equal(result.text, "local answer");
  assert.equal(result.exitCode, 0);
  assert.equal(result.outputBytes, Buffer.byteLength("local answer"));
  assert.equal(result.inputTokens, 3);
  assert.equal(result.outputTokens, 5);
  assert.equal(result.estimatedCostUsd, 0);
  assert.ok(result.durationMs >= 0);

  const sent = stub.seen.at(-1);
  assert.equal(sent?.method, "POST");
  assert.equal(sent?.url, "/v1/chat/completions");
  assert.deepEqual(JSON.parse(sent?.body ?? "{}"), {
    model: "synthetic-local-model",
    messages: [{ role: "user", content: "synthetic prompt" }],
    stream: false,
  });

  // Untrusted local output is redacted like every other provider surface.
  stub.reply((_request, response) =>
    json(response, { choices: [{ message: { content: "contact user@example.invalid" } }] }),
  );
  const redacted = await provider.invoke(request());
  assert.equal(redacted.text, "contact [EMAIL_REDACTED]");
  assert.equal(redacted.inputTokens, undefined);
  assert.equal(redacted.outputTokens, undefined);

  stub.reply((_request, response) =>
    json(response, {
      choices: [{ message: { content: "a" } }, { message: { content: "b" } }],
      usage: null,
    }),
  );
  assert.equal((await provider.invoke(request())).text, "ab");

  stub.reply((_request, response) =>
    json(response, {
      choices: [{ message: { content: "c" } }],
      usage: { prompt_tokens: "3", completion_tokens: 1.5 },
    }),
  );
  const looseUsage = await provider.invoke(request());
  assert.equal(looseUsage.inputTokens, undefined);
  assert.equal(looseUsage.outputTokens, undefined);

  stub.reply((_request, response) =>
    json(response, { choices: [{ message: { content: "d" } }], usage: { prompt_tokens: -1 } }),
  );
  assert.equal((await provider.invoke(request())).inputTokens, undefined);

  // A live (never aborted) caller signal must not disturb the success path.
  const live = new AbortController();
  assert.equal((await provider.invoke(request({ signal: live.signal }))).text, "d");
});

test("local adapter rejects unsupported modes and invalid request fields before the network", async (t) => {
  const stub = await startStub(t);
  const provider = new LocalModelProvider({ endpoint: stub.origin });
  stub.reply((_request, response) => json(response, { choices: [{ message: { content: "never" } }] }));

  await assert.rejects(provider.invoke(request({ authMode: "api" })), /LOCAL_AUTH_MODE_UNSUPPORTED/u);
  await assert.rejects(
    provider.invoke(request({ access: "workspace-write" })),
    /LOCAL_WRITER_NOT_SUPPORTED/u,
  );
  await assert.rejects(provider.invoke(request({ model: "bad model" })), /LOCAL_MODEL_ID_INVALID/u);
  await assert.rejects(provider.invoke(request({ model: "" })), /LOCAL_MODEL_ID_INVALID/u);
  await assert.rejects(provider.invoke(request({ prompt: "" })), /LOCAL_PROMPT_INVALID/u);
  await assert.rejects(provider.invoke(request({ prompt: "a\0b" })), /LOCAL_PROMPT_INVALID/u);
  await assert.rejects(
    provider.invoke(request({ prompt: "x".repeat(500_001) })),
    /LOCAL_PROMPT_INVALID/u,
  );
  assert.deepEqual(stub.seen, []);
});

test("local adapter fails closed on hostile and malformed HTTP responses", async (t) => {
  const stub = await startStub(t);
  const provider = new LocalModelProvider({ endpoint: stub.origin });

  stub.reply((_request, response) => {
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end('{"error":"boom"}');
  });
  await assert.rejects(provider.invoke(request()), /LOCAL_HTTP_STATUS:500/u);
  const live = new AbortController();
  await assert.rejects(
    provider.invoke(request({ signal: live.signal })),
    /LOCAL_HTTP_STATUS:500/u,
  );

  // A redirect is never followed: an off-loopback Location would be an exfiltration channel.
  stub.reply((_request, response) => {
    response.writeHead(302, { Location: "https://models.example.com/v1/chat/completions" });
    response.end("moved");
  });
  await assert.rejects(provider.invoke(request()), /LOCAL_ENDPOINT_REDIRECT_DENIED/u);
  stub.reply((_request, response) => {
    response.writeHead(307, { Location: "http://127.0.0.1:1/v1/chat/completions" });
    response.end("moved");
  });
  await assert.rejects(provider.invoke(request()), /LOCAL_ENDPOINT_REDIRECT_DENIED/u);

  stub.reply((_request, response) => {
    response.writeHead(204);
    response.end();
  });
  await assert.rejects(provider.invoke(request()), /LOCAL_RESPONSE_BODY_MISSING/u);

  stub.reply((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end("<html>not json</html>");
  });
  await assert.rejects(provider.invoke(request()), /LOCAL_RESPONSE_JSON_INVALID/u);

  stub.reply((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end('{"choices":[{"message":{"content":"tru');
  });
  await assert.rejects(provider.invoke(request()), /LOCAL_RESPONSE_JSON_INVALID/u);

  stub.reply((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n');
  });
  await assert.rejects(provider.invoke(request()), /LOCAL_RESPONSE_JSON_INVALID/u);

  for (const payload of ["null", '"text"', "[]"]) {
    stub.reply((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(payload);
    });
    await assert.rejects(provider.invoke(request()), /LOCAL_RESPONSE_SCHEMA_INVALID/u, payload);
  }

  for (const payload of [{}, { choices: "text" }, { choices: [1] }]) {
    stub.reply((_request, response) => json(response, payload));
    await assert.rejects(provider.invoke(request()), /LOCAL_RESPONSE_SCHEMA_INVALID/u, JSON.stringify(payload));
  }

  for (const payload of [{ choices: [] }, { choices: [{}] }, { choices: [{ message: { content: "" } }] }, { choices: [{ message: null }] }]) {
    stub.reply((_request, response) => json(response, payload));
    await assert.rejects(provider.invoke(request()), /LOCAL_RESPONSE_TEXT_MISSING/u, JSON.stringify(payload));
  }

  stub.reply((_request, response) =>
    json(response, { choices: [{ message: { content: "x".repeat(4_096) } }] }),
  );
  await assert.rejects(
    provider.invoke(request({ outputLimitBytes: 256 })),
    /LOCAL_OUTPUT_LIMIT_REACHED/u,
  );
});

test("local adapter fails closed when the endpoint is unreachable, slow or cancelled", async (t) => {
  const port = await closedPort();
  const offline = new LocalModelProvider({ endpoint: `http://127.0.0.1:${port}` });
  await assert.rejects(offline.invoke(request()), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "LOCAL_ENDPOINT_UNREACHABLE");
    return true;
  });
  await assert.rejects(offline.listModels(), /LOCAL_ENDPOINT_UNREACHABLE/u);
  assert.deepEqual(await offline.doctor(), { ok: false, reason: "LOCAL_ENDPOINT_UNREACHABLE" });

  const stub = await startStub(t);
  const provider = new LocalModelProvider({ endpoint: stub.origin, discoveryTimeoutMs: 150 });

  stub.reply(() => {
    // Never answers: the adapter must give up on its own timeout.
  });
  await assert.rejects(provider.invoke(request({ timeoutMs: 150 })), /LOCAL_TIMEOUT/u);
  await assert.rejects(provider.listModels(), /LOCAL_TIMEOUT/u);

  stub.reply((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.write('{"choices":');
    // Headers arrive, the body stalls: the byte pump must still respect the timeout.
  });
  await assert.rejects(provider.invoke(request({ timeoutMs: 150 })), /LOCAL_TIMEOUT/u);

  const controller = new AbortController();
  stub.reply(() => controller.abort());
  await assert.rejects(
    provider.invoke(request({ timeoutMs: 5_000, signal: controller.signal })),
    /LOCAL_CANCELLED/u,
  );
});

test("local adapter never leaks raw transport failures", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const provider = new LocalModelProvider({ endpoint: "http://127.0.0.1:11434" });
  globalThis.fetch = async () => {
    throw "ECONNREFUSED 127.0.0.1:11434";
  };
  await assert.rejects(provider.invoke(request()), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "LOCAL_ENDPOINT_UNREACHABLE");
    return true;
  });

  assert.equal(localErrorCode(new Error("LOCAL_TIMEOUT")), "LOCAL_TIMEOUT");
  assert.equal(localErrorCode(new Error("ECONNREFUSED")), "LOCAL_ENDPOINT_UNREACHABLE");
  assert.equal(localErrorCode("ECONNREFUSED"), "LOCAL_ENDPOINT_UNREACHABLE");
});

test("provider registry exposes the local adapter only when an endpoint is configured", async (t) => {
  const stub = await startStub(t);
  stub.reply((_request, response) => json(response, { data: [{ id: "qwen3:8b" }] }));

  const disabled = new ProviderRegistry();
  assert.equal(disabled.capabilities().length, 4);
  assert.throws(() => disabled.get("local"), /PROVIDER_NOT_REGISTERED:local/u);

  const registry = new ProviderRegistry([], { localEndpoint: stub.origin });
  assert.equal(registry.capabilities().length, 5);
  assert.equal(registry.canWrite("local", "subscription"), false);
  assert.equal(registry.canWrite("local", "api"), false);
  assert.deepEqual(await registry.listModels("local", "subscription"), ["qwen3:8b"]);
  assert.deepEqual(await registry.listModels("local", "subscription"), ["qwen3:8b"]);
  await assert.rejects(registry.listModels("local", "api"), /LOCAL_PROVIDER_HAS_NO_API_MODE/u);
  await assert.rejects(
    registry.prepareApiCall("local", "qwen3:8b", "synthetic"),
    /LOCAL_PROVIDER_HAS_NO_API_MODE/u,
  );

  assert.throws(
    () => new ProviderRegistry([], { localEndpoint: "http://models.example.com:11434" }),
    /LOCAL_ENDPOINT_NOT_LOOPBACK/u,
  );
});

test("owner-initiated local registration stays default-off and loopback-only", async (t) => {
  const stub = await startStub(t);
  stub.reply((_request, response) => json(response, { data: [{ id: "qwen3:8b" }] }));

  const registry = new ProviderRegistry();
  // Default off: nothing is registered until the owner asks for it.
  assert.equal(registry.has("local"), false);
  assert.throws(() => registry.get("local"), /PROVIDER_NOT_REGISTERED:local/u);

  for (const rejected of [
    "http://models.example.com:11434",
    "https://127.0.0.1:11434",
    "http://user:pass@127.0.0.1:11434",
    "http://127.0.0.1:11434/v1",
    "http://127.0.0.1",
    "file:///etc/passwd",
    "  ",
    "not a url",
    11434,
    undefined,
    null,
    { endpoint: "http://127.0.0.1:11434" },
  ]) {
    assert.throws(() => registry.enableLocalEndpoint(rejected), /^Error: LOCAL_/u, String(rejected));
    assert.equal(registry.has("local"), false);
  }

  const capabilities = registry.enableLocalEndpoint(stub.origin);
  assert.equal(capabilities.id, "local");
  // The menu label itself has to say what the provider is.
  assert.match(capabilities.displayName, /地端模型/u);
  assert.match(capabilities.displayName, /loopback/u);
  assert.match(capabilities.displayName, /不使用訂閱或 API 額度/u);
  assert.equal(capabilities.canWrite, false);
  assert.equal(capabilities.canWriteSubscription, false);
  assert.equal(capabilities.canWriteApi, false);
  assert.equal(capabilities.api, false);
  assert.ok(registry.has("local"));
  assert.deepEqual(await registry.listModels("local", "subscription"), ["qwen3:8b"]);

  // Single-shot: an already-registered id can never be re-pointed at another port.
  assert.throws(
    () => registry.enableLocalEndpoint("http://127.0.0.1:1"),
    /LOCAL_PROVIDER_ALREADY_REGISTERED/u,
  );
  assert.throws(
    () => new ProviderRegistry([], { localEndpoint: stub.origin }).enableLocalEndpoint(stub.origin),
    /LOCAL_PROVIDER_ALREADY_REGISTERED/u,
  );

  // The returned capability arrays are copies; a caller cannot mutate the registry.
  capabilities.subscriptionModels.push("smuggled");
  assert.deepEqual(registry.get("local").capabilities.subscriptionModels, []);
});
