import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_CONFIG_FILE = "config.local.json";
const FALLBACK_CONFIG_FILE = "config.example.json";

export function loadEnv(file = ".env") {
  const envPath = resolve(process.cwd(), file);
  if (!existsSync(envPath)) {
    return;
  }

  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const index = trimmed.indexOf("=");
    if (index === -1) {
      continue;
    }

    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export function loadConfig(file = process.env.CONFIG_PATH || DEFAULT_CONFIG_FILE) {
  const configPath = resolve(process.cwd(), file);
  const fallbackPath = resolve(process.cwd(), FALLBACK_CONFIG_FILE);
  const selectedPath = existsSync(configPath) ? configPath : fallbackPath;

  if (!existsSync(selectedPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  const config = JSON.parse(readFileSync(selectedPath, "utf8").replace(/^\uFEFF/, ""));
  validateConfig(config, selectedPath);
  defineConfigPath(config, selectedPath);
  return config;
}

export function saveEnv(key, value, file = ".env") {
  const envPath = resolve(process.cwd(), file);
  let lines = [];

  if (existsSync(envPath)) {
    lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  }

  let found = false;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) {
      continue;
    }
    const lineKey = trimmed.slice(0, eqIndex).trim();
    if (lineKey === key) {
      lines[i] = `${key}=${value}`;
      found = true;
      break;
    }
  }

  if (!found) {
    if (lines.length > 0 && lines[lines.length - 1].trim() !== "") {
      lines.push("");
    }
    lines.push(`${key}=${value}`);
  }

  writeFileSync(envPath, lines.join("\n"), "utf8");
  process.env[key] = value;
}

export function saveConfig(config, file = config.__configPath || process.env.CONFIG_PATH || DEFAULT_CONFIG_FILE) {
  const configPath = resolve(process.cwd(), file);
  const plainConfig = stripInternalFields(config);
  validateConfig(plainConfig, configPath);
  writeFileSync(configPath, `${JSON.stringify(plainConfig, null, 2)}\n`, "utf8");
  defineConfigPath(config, configPath);
  return configPath;
}

function validateConfig(config, path) {
  if (!config.providers || typeof config.providers !== "object") {
    throw new Error(`${path}: "providers" must be an object`);
  }

  if (!config.models || typeof config.models !== "object") {
    throw new Error(`${path}: "models" must be an object`);
  }

  for (const [providerId, provider] of Object.entries(config.providers)) {
    if (!provider.baseUrl) {
      throw new Error(`${path}: provider "${providerId}" is missing baseUrl`);
    }

    if (!provider.baseUrl.endsWith("/v1")) {
      console.warn(`[warn] provider "${providerId}" baseUrl "${provider.baseUrl}" does not end with /v1 — requests may fail if the upstream expects /v1 prefix`);
    }

    if (!["responses", "chat"].includes(provider.protocol || "responses")) {
      throw new Error(`${path}: provider "${providerId}" protocol must be "responses" or "chat"`);
    }
  }

  for (const [modelId, route] of Object.entries(config.models)) {
    if (!route.provider || !config.providers[route.provider]) {
      throw new Error(`${path}: model "${modelId}" references an unknown provider`);
    }
  }
}

function defineConfigPath(config, path) {
  Object.defineProperty(config, "__configPath", {
    value: path,
    enumerable: false,
    configurable: true,
    writable: true
  });
}

function stripInternalFields(config) {
  return JSON.parse(JSON.stringify(config));
}
