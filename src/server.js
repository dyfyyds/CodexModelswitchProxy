import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, loadEnv, saveConfig, saveEnv } from "./config.js";
import { chatCompletionToResponse, resolveRoute, responsesToChatBody } from "./adapters.js";
import { pipeChatStreamAsResponses, pipeUpstreamStream } from "./sse.js";

const PROVIDER_PRESETS = {
  deepseek: {
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    protocol: "chat",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    models: [
      { alias: "deepseek-coder", upstream: "deepseek-chat", label: "DeepSeek Chat" },
      { alias: "deepseek-reasoner", upstream: "deepseek-reasoner", label: "DeepSeek Reasoner" },
      { alias: "deepseek-v4-pro", upstream: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
      { alias: "gpt-5.5", upstream: "deepseek-v4-pro", label: "GPT-5.5 (映射到 V4 Pro)" }
    ]
  },
  openrouter: {
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    protocol: "chat",
    apiKeyEnv: "OPENROUTER_API_KEY",
    headers: { "HTTP-Referer": "http://localhost:8080", "X-Title": "Codex Model Switch Proxy" },
    models: [
      { alias: "qwen-coder", upstream: "qwen/qwen3-coder", label: "Qwen3 Coder" },
      { alias: "claude-sonnet", upstream: "anthropic/claude-sonnet-4", label: "Claude Sonnet" }
    ]
  },
  openai: {
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    protocol: "responses",
    apiKeyEnv: "OPENAI_API_KEY",
    models: [
      { alias: "gpt-4o", upstream: "gpt-4o", label: "GPT-4o" }
    ]
  },
  ollama: {
    name: "Ollama (本地)",
    baseUrl: "http://127.0.0.1:11434/v1",
    protocol: "chat",
    apiKeyEnv: "",
    models: [
      { alias: "local-coder", upstream: "qwen2.5-coder:latest", label: "Qwen2.5 Coder" }
    ]
  },
  siliconflow: {
    name: "SiliconFlow",
    baseUrl: "https://api.siliconflow.cn/v1",
    protocol: "chat",
    apiKeyEnv: "SILICONFLOW_API_KEY",
    models: [
      { alias: "sf-qwen", upstream: "Qwen/Qwen2.5-Coder-32B-Instruct", label: "Qwen2.5 Coder 32B" }
    ]
  }
};

if (isMainModule()) {
  loadEnv();
  const config = loadConfig();
  const server = createProxyServer(config);
  const host = config.host || "127.0.0.1";
  const port = config.port || 8080;

  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error(`Port already in use: http://${host}:${port}`);
      console.error("Stop the existing proxy process or change the port in config.local.json.");
      process.exit(1);
    }

    console.error(error);
    process.exit(1);
  });

  server.listen(port, host, () => {
    const address = server.address();
    console.log(`Codex model switch proxy listening on http://${address.address}:${address.port}/v1`);
  });
}

export function createProxyServer(activeConfig) {
  return createServer((request, response) => {
    handleRequest(request, response, activeConfig).catch((error) => {
      sendError(response, error.statusCode || 500, error.message || "Internal server error");
    });
  });
}

export async function handleRequest(request, response, activeConfig) {
  const url = new URL(request.url, "http://localhost");

  if (request.method === "GET" && (url.pathname === "/" || url.pathname.startsWith("/app/"))) {
    serveStatic(url.pathname, response);
    return;
  }

  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, { ok: true, models: Object.keys(activeConfig.models) });
    return;
  }

  if (request.method === "GET" && url.pathname === "/debug/routes") {
    sendJson(response, 200, buildRouteDebugInfo(activeConfig));
    return;
  }

  if (request.method === "GET" && url.pathname === "/v1/models") {
    sendJson(response, 200, {
      object: "list",
      data: Object.keys(activeConfig.models).map((id) => ({
        id,
        object: "model",
        created: 0,
        owned_by: "codex-model-switch-proxy"
      }))
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/admin/config") {
    sendJson(response, 200, publicConfig(activeConfig));
    return;
  }

  if (request.method === "GET" && url.pathname === "/admin/presets") {
    sendJson(response, 200, { presets: PROVIDER_PRESETS });
    return;
  }

  if (request.method === "GET" && url.pathname === "/admin/env-status") {
    const keys = {};
    for (const provider of Object.values(activeConfig.providers)) {
      if (provider.apiKeyEnv) {
        keys[provider.apiKeyEnv] = Boolean(process.env[provider.apiKeyEnv]);
      }
    }
    if (activeConfig.requireProxyKeyEnv) {
      keys[activeConfig.requireProxyKeyEnv] = Boolean(process.env[activeConfig.requireProxyKeyEnv]);
    }
    sendJson(response, 200, { keys });
    return;
  }

  if (request.method === "POST" && url.pathname === "/admin/env") {
    const body = await readJson(request);
    const key = String(body.key || "").trim();
    const value = String(body.value || "");
    if (!key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw Object.assign(new Error("Invalid env key name"), { statusCode: 400 });
    }
    saveEnv(key, value);
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "POST" && url.pathname === "/admin/providers") {
    const body = await readJson(request);
    upsertProvider(activeConfig, body);
    const path = saveConfig(activeConfig);
    sendJson(response, 200, { ok: true, configPath: path, config: publicConfig(activeConfig) });
    return;
  }

  if (request.method === "POST" && url.pathname === "/admin/routes") {
    const body = await readJson(request);
    upsertProvider(activeConfig, body.provider || {});
    upsertModel(activeConfig, body.model || {});
    const path = saveConfig(activeConfig);
    sendJson(response, 200, { ok: true, configPath: path, config: publicConfig(activeConfig) });
    return;
  }

  if (request.method === "POST" && url.pathname === "/admin/models") {
    const body = await readJson(request);
    upsertModel(activeConfig, body);
    const path = saveConfig(activeConfig);
    sendJson(response, 200, { ok: true, configPath: path, config: publicConfig(activeConfig) });
    return;
  }

  const modelDeleteMatch = url.pathname.match(/^\/admin\/models\/([^/]+)$/);
  if (request.method === "DELETE" && modelDeleteMatch) {
    deleteModel(activeConfig, decodeURIComponent(modelDeleteMatch[1]));
    const path = saveConfig(activeConfig);
    sendJson(response, 200, { ok: true, configPath: path, config: publicConfig(activeConfig) });
    return;
  }

  const providerDeleteMatch = url.pathname.match(/^\/admin\/providers\/([^/]+)$/);
  if (request.method === "DELETE" && providerDeleteMatch) {
    deleteProvider(activeConfig, decodeURIComponent(providerDeleteMatch[1]));
    const path = saveConfig(activeConfig);
    sendJson(response, 200, { ok: true, configPath: path, config: publicConfig(activeConfig) });
    return;
  }

  if (request.method !== "POST") {
    sendError(response, 404, "Not found");
    return;
  }

  requireProxyKey(request, activeConfig);

  if (url.pathname === "/v1/responses") {
    const body = await readJson(request);
    await handleResponses(body, response, activeConfig);
    return;
  }

  if (url.pathname === "/v1/chat/completions") {
    const body = await readJson(request);
    await handleChatCompletions(body, response, activeConfig);
    return;
  }

  sendError(response, 404, "Not found");
}

async function handleResponses(body, response, activeConfig) {
  const route = resolveRoute(activeConfig, body.model);
  logRoute("responses", route);

  if ((route.provider.protocol || "responses") === "responses") {
    const upstreamBody = { ...body, model: route.upstreamModel };
    const upstream = await callUpstream(route.provider, "/responses", upstreamBody);
    await relayUpstream(upstream, response, route);
    return;
  }

  const chatBody = responsesToChatBody(body, route.upstreamModel);
  const upstream = await callUpstream(route.provider, "/chat/completions", chatBody);

  if (body.stream) {
    await pipeChatStreamAsResponses(upstream, response, route.publicModel);
    return;
  }

  const chat = await upstream.json();
  if (!upstream.ok) {
    sendJson(response, upstream.status, chat);
    return;
  }

  sendJson(response, 200, chatCompletionToResponse(chat, route.publicModel), routeHeaders(route));
}

async function handleChatCompletions(body, response, activeConfig) {
  const route = resolveRoute(activeConfig, body.model);
  logRoute("chat.completions", route);
  const upstreamBody = { ...body, model: route.upstreamModel };
  const upstream = await callUpstream(route.provider, "/chat/completions", upstreamBody);
  await relayUpstream(upstream, response, route);
}

async function callUpstream(provider, path, body) {
  const endpoint = buildEndpoint(provider, path);
  const headers = {
    "Content-Type": "application/json",
    ...provider.headers
  };

  if (provider.apiKeyEnv && process.env[provider.apiKeyEnv]) {
    headers.Authorization = `Bearer ${process.env[provider.apiKeyEnv]}`;
  }

  return fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
}

async function relayUpstream(upstream, response, route) {
  const contentType = upstream.headers.get("content-type") || "";
  if (contentType.includes("text/event-stream")) {
    await pipeUpstreamStream(upstream, response);
    return;
  }

  const text = await upstream.text();
  response.writeHead(upstream.status, {
    "Content-Type": contentType || "application/json; charset=utf-8",
    ...routeHeaders(route)
  });
  response.end(text);
}

function buildEndpoint(provider, path) {
  const base = provider.baseUrl.replace(/\/+$/, "");
  const endpoint = new URL(`${base}${path}`);

  for (const [key, value] of Object.entries(provider.query || {})) {
    endpoint.searchParams.set(key, value);
  }

  return endpoint;
}

async function readJson(request) {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
  }

  if (!raw.trim()) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error("Invalid JSON body"), { statusCode: 400 });
  }
}

function requireProxyKey(request, activeConfig) {
  if (!activeConfig.requireProxyKeyEnv) {
    return;
  }

  const expected = process.env[activeConfig.requireProxyKeyEnv];
  if (!expected) {
    throw Object.assign(new Error(`Proxy key env ${activeConfig.requireProxyKeyEnv} is not set`), {
      statusCode: 500
    });
  }

  const header = request.headers.authorization || "";
  const token = header.replace(/^Bearer\s+/i, "");
  if (token !== expected) {
    throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
  }
}

function sendJson(response, statusCode, data, headers = {}) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8", ...headers });
  response.end(JSON.stringify(data));
}

function sendError(response, statusCode, message) {
  sendJson(response, statusCode, {
    error: {
      message,
      type: statusCode >= 500 ? "server_error" : "invalid_request_error"
    }
  });
}

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

function serveStatic(pathname, response) {
  const publicDir = resolve(process.cwd(), "public");
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/app\//, "");
  const filePath = normalize(join(publicDir, relativePath));

  if (!filePath.startsWith(publicDir) || !existsSync(filePath)) {
    sendError(response, 404, "Not found");
    return;
  }

  response.writeHead(200, { "Content-Type": contentTypeFor(filePath) });
  response.end(readFileSync(filePath));
}

function buildRouteDebugInfo(activeConfig) {
  return {
    defaultModel: activeConfig.defaultModel || null,
    defaultProvider: activeConfig.defaultProvider || null,
    allowDirectModels: Boolean(activeConfig.allowDirectModels),
    routes: Object.fromEntries(
      Object.entries(activeConfig.models).map(([alias, route]) => [
        alias,
        {
          provider: route.provider,
          upstreamModel: route.upstreamModel || alias,
          protocol: activeConfig.providers[route.provider]?.protocol || "responses",
          baseUrl: activeConfig.providers[route.provider]?.baseUrl || null
        }
      ])
    )
  };
}

function logRoute(endpoint, route) {
  console.log(
    `[route:${endpoint}] model=${route.publicModel} provider=${route.providerId} upstream=${route.upstreamModel}`
  );
}

function routeHeaders(route) {
  if (!route) {
    return {};
  }

  return {
    "X-Proxy-Model": route.publicModel,
    "X-Proxy-Provider": route.providerId,
    "X-Proxy-Upstream-Model": route.upstreamModel
  };
}

function publicConfig(activeConfig) {
  return {
    port: activeConfig.port || 8080,
    host: activeConfig.host || "127.0.0.1",
    requireProxyKeyEnv: activeConfig.requireProxyKeyEnv || "",
    defaultModel: activeConfig.defaultModel || "",
    allowDirectModels: Boolean(activeConfig.allowDirectModels),
    defaultProvider: activeConfig.defaultProvider || "",
    providers: activeConfig.providers,
    models: activeConfig.models,
    configPath: activeConfig.__configPath || null
  };
}

function upsertProvider(activeConfig, body) {
  const id = validateId(body.id, "provider id");
  const existing = activeConfig.providers[id] || {};
  const baseUrl = String(body.baseUrl || existing.baseUrl || "").trim();
  const protocol = body.protocol || existing.protocol || "chat";

  if (!baseUrl) {
    throw Object.assign(new Error("Provider baseUrl is required"), { statusCode: 400 });
  }

  if (!["chat", "responses"].includes(protocol)) {
    throw Object.assign(new Error("Provider protocol must be chat or responses"), { statusCode: 400 });
  }

  const provider = { baseUrl, protocol };

  const apiKeyEnv = String(body.apiKeyEnv ?? existing.apiKeyEnv ?? "").trim();
  if (apiKeyEnv) {
    provider.apiKeyEnv = apiKeyEnv;
  }

  const headers = body.headers !== undefined ? parseHeaders(body.headers) : existing.headers;
  if (headers && Object.keys(headers).length > 0) {
    provider.headers = headers;
  }

  activeConfig.providers[id] = provider;
}

function upsertModel(activeConfig, body) {
  const alias = validateId(body.alias, "model alias");
  const provider = validateId(body.provider, "provider id");
  const upstreamModel = String(body.upstreamModel || alias).trim();

  if (!activeConfig.providers[provider]) {
    throw Object.assign(new Error(`Unknown provider "${provider}"`), { statusCode: 400 });
  }

  if (!upstreamModel) {
    throw Object.assign(new Error("Upstream model is required"), { statusCode: 400 });
  }

  activeConfig.models[alias] = {
    provider,
    upstreamModel
  };

  if (!activeConfig.defaultModel) {
    activeConfig.defaultModel = alias;
  }
}

function deleteModel(activeConfig, alias) {
  if (!activeConfig.models[alias]) {
    throw Object.assign(new Error(`Unknown model "${alias}"`), { statusCode: 404 });
  }

  delete activeConfig.models[alias];

  if (activeConfig.defaultModel === alias) {
    activeConfig.defaultModel = Object.keys(activeConfig.models)[0] || "";
  }
}

function deleteProvider(activeConfig, id) {
  if (!activeConfig.providers[id]) {
    throw Object.assign(new Error(`Unknown provider "${id}"`), { statusCode: 404 });
  }

  // Delete all models using this provider
  for (const [alias, model] of Object.entries(activeConfig.models)) {
    if (model.provider === id) {
      delete activeConfig.models[alias];
      if (activeConfig.defaultModel === alias) {
        activeConfig.defaultModel = "";
      }
    }
  }

  delete activeConfig.providers[id];

  if (activeConfig.defaultProvider === id) {
    activeConfig.defaultProvider = Object.keys(activeConfig.providers)[0] || "";
  }

  // Reset default model if needed
  if (!activeConfig.defaultModel) {
    activeConfig.defaultModel = Object.keys(activeConfig.models)[0] || "";
  }
}

function validateId(value, label) {
  const id = String(value || "").trim();
  if (!/^[A-Za-z0-9._:-]+$/.test(id)) {
    throw Object.assign(new Error(`${label} must use letters, numbers, dot, underscore, colon, or hyphen`), {
      statusCode: 400
    });
  }
  return id;
}

function parseHeaders(headers) {
  if (!headers) {
    return {};
  }

  if (typeof headers === "object") {
    return headers;
  }

  try {
    const parsed = JSON.parse(headers);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Headers must be a JSON object");
    }
    return parsed;
  } catch {
    throw Object.assign(new Error("Headers must be a valid JSON object"), { statusCode: 400 });
  }
}

function contentTypeFor(filePath) {
  const extension = extname(filePath);
  if (extension === ".css") {
    return "text/css; charset=utf-8";
  }
  if (extension === ".js") {
    return "text/javascript; charset=utf-8";
  }
  if (extension === ".html") {
    return "text/html; charset=utf-8";
  }
  return "application/octet-stream";
}
