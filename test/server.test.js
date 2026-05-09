import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createProxyServer } from "../src/server.js";

test("routes Responses request to a chat provider and adapts the response", async () => {
  const upstream = createServer(async (request, response) => {
    assert.equal(request.url, "/v1/chat/completions");
    let raw = "";
    for await (const chunk of request) {
      raw += chunk;
    }

    const body = JSON.parse(raw);
    assert.equal(body.model, "real-model");
    assert.equal(body.messages[0].content, "hello");

    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        id: "chatcmpl_test",
        created: 123,
        choices: [{ message: { role: "assistant", content: "hi" } }]
      })
    );
  });

  await listen(upstream);
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/v1`;

  const config = {
    providers: {
      mock: { baseUrl: upstreamUrl, protocol: "chat" }
    },
    models: {
      alias: { provider: "mock", upstreamModel: "real-model" }
    }
  };

  const proxy = createProxyServer(config);
  await listen(proxy);

  const result = await fetch(`http://127.0.0.1:${proxy.address().port}/v1/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "alias", input: "hello" })
  });

  const json = await result.json();
  assert.equal(result.status, 200);
  assert.equal(json.output_text, "hi");

  await close(proxy);
  await close(upstream);
});

test("admin model creation persists config and updates routes", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "codex-proxy-test-"));
  const configPath = join(tempDir, "config.local.json");
  const config = {
    providers: {
      mock: { baseUrl: "http://127.0.0.1:9999/v1", protocol: "chat" }
    },
    models: {}
  };
  Object.defineProperty(config, "__configPath", {
    value: configPath,
    enumerable: false,
    configurable: true,
    writable: true
  });

  const proxy = createProxyServer(config);
  await listen(proxy);

  const result = await fetch(`http://127.0.0.1:${proxy.address().port}/admin/models`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      alias: "new-coder",
      provider: "mock",
      upstreamModel: "real-coder"
    })
  });

  const json = await result.json();
  const saved = JSON.parse(readFileSync(configPath, "utf8"));

  assert.equal(result.status, 200);
  assert.equal(json.config.models["new-coder"].upstreamModel, "real-coder");
  assert.equal(config.models["new-coder"].provider, "mock");
  assert.equal(saved.models["new-coder"].upstreamModel, "real-coder");

  await close(proxy);
  rmSync(tempDir, { recursive: true, force: true });
});

test("admin route creation persists provider and model together", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "codex-proxy-route-test-"));
  const configPath = join(tempDir, "config.local.json");
  const config = {
    providers: {},
    models: {}
  };
  Object.defineProperty(config, "__configPath", {
    value: configPath,
    enumerable: false,
    configurable: true,
    writable: true
  });

  const proxy = createProxyServer(config);
  await listen(proxy);

  const result = await fetch(`http://127.0.0.1:${proxy.address().port}/admin/routes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: {
        id: "deepseek",
        baseUrl: "https://api.deepseek.com/v1",
        protocol: "chat",
        apiKeyEnv: "DEEPSEEK_API_KEY"
      },
      model: {
        alias: "deepseek-coder",
        provider: "deepseek",
        upstreamModel: "deepseek-chat"
      }
    })
  });

  const json = await result.json();
  const saved = JSON.parse(readFileSync(configPath, "utf8"));

  assert.equal(result.status, 200);
  assert.equal(json.config.providers.deepseek.baseUrl, "https://api.deepseek.com/v1");
  assert.equal(json.config.models["deepseek-coder"].upstreamModel, "deepseek-chat");
  assert.equal(saved.providers.deepseek.apiKeyEnv, "DEEPSEEK_API_KEY");
  assert.equal(saved.models["deepseek-coder"].provider, "deepseek");

  await close(proxy);
  rmSync(tempDir, { recursive: true, force: true });
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
