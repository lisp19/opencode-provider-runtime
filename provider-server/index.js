import { createServer } from "node:http"
import os from "node:os"
import path from "node:path"
import { appendFile, mkdir } from "node:fs/promises"
import { createCodexResponsesServer } from "./codex-responses.js"
import { buildOpenAIHeaders, getOpenAIOAuth } from "./openai-oauth.js"

const PLUGIN_ID = "provider-server"
const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses"
const LOG_DIR = path.join(os.homedir(), ".config", "opencode", "logs")
const LOG_PATH = path.join(LOG_DIR, `${PLUGIN_ID}.log`)

let httpServer
let responsesHttpServer

const DEFAULT_BUNDLED_OPENAI_SLUGS = ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex", "gpt-5.2", "codex-auto-review"]

async function log(enabled, event, detail) {
  if (!enabled) return
  const line = `${new Date().toISOString()} [${PLUGIN_ID}] ${event} ${JSON.stringify(detail)}\n`
  try {
    await mkdir(LOG_DIR, { recursive: true })
    await appendFile(LOG_PATH, line, "utf8")
  } catch {}
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseOptions(options) {
  const value = isRecord(options) ? options : {}
  const port = typeof value.port === "number" ? value.port : 3456
  const hostname = typeof value.hostname === "string" && value.hostname.trim() ? value.hostname.trim() : "0.0.0.0"
  const responsesPort = typeof value.responses_port === "number" ? value.responses_port : 3455
  const responsesHostname =
    typeof value.responses_hostname === "string" && value.responses_hostname.trim() ? value.responses_hostname.trim() : "0.0.0.0"
  const logEnabled = value.log === true
  const providers = parseProviders(value.providers)
  return { port, hostname, responsesPort, responsesHostname, logEnabled, providers }
}

function parseProviders(value) {
  const providers = !isRecord(value)
    ? { openai: parseProvider("openai", { mode: "oauth" }) }
    : Object.fromEntries(Object.entries(value).map(([provider, config]) => [provider, parseProvider(provider, config)]))
  if (!providers.openai?.runtime_auth) {
    throw new Error("providers.openai.runtime_auth is required")
  }
  return providers
}

function parseProvider(provider, value) {
  const config = isRecord(value) ? value : {}
  const runtimeAuth = parseRuntimeAuth(provider, config.runtime_auth)
  const codexResponses = parseCodexResponses(config.codex_responses)
  return {
    ...config,
    runtime_auth: runtimeAuth,
    codex_responses: codexResponses,
  }
}

function parseCodexResponses(value) {
  if (value === undefined) {
    return {
      enabled: true,
      provider_source_url: `http://127.0.0.1:4096/provider?directory=${encodeURIComponent(os.homedir())}`,
      upstream_models_url: "https://chatgpt.com/backend-api/codex/models",
      bundled_openai_slugs: DEFAULT_BUNDLED_OPENAI_SLUGS,
    }
  }
  if (!isRecord(value)) throw new Error("providers.openai.codex_responses must be an object")
  return {
    enabled: value.enabled !== false,
    provider_source_url:
      typeof value.provider_source_url === "string" && value.provider_source_url.trim()
        ? value.provider_source_url.trim()
        : `http://127.0.0.1:4096/provider?directory=${encodeURIComponent(os.homedir())}`,
    upstream_models_url:
      typeof value.upstream_models_url === "string" && value.upstream_models_url.trim()
        ? value.upstream_models_url.trim()
        : "https://chatgpt.com/backend-api/codex/models",
    bundled_openai_slugs: Array.isArray(value.bundled_openai_slugs)
      ? value.bundled_openai_slugs.filter((item) => typeof item === "string" && item.trim())
      : DEFAULT_BUNDLED_OPENAI_SLUGS,
  }
}

function parseRuntimeAuth(provider, value) {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new Error(`providers.${provider}.runtime_auth must be an object`)
  const header = typeof value.header === "string" && value.header.trim() ? value.header.trim() : ""
  const secret = typeof value.secret === "string" && value.secret.trim() ? value.secret.trim() : ""
  if (!header) throw new Error(`providers.${provider}.runtime_auth.header must be a non-empty string`)
  if (!secret) throw new Error(`providers.${provider}.runtime_auth.secret must be a non-empty string`)
  return { header, secret }
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks).toString("utf8")
}

function resolveConfiguredURL(template) {
  return template
    .replaceAll("${HOME_URLENCODED}", encodeURIComponent(os.homedir()))
    .replaceAll("${HOME}", os.homedir())
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

async function handleOpenAIRuntime(req, reqBody, res, options) {
  const auth = await getOpenAIOAuth()
  const abortController = new AbortController()
  const abortUpstream = () => abortController.abort()
  req.once("aborted", abortUpstream)
  res.once("close", abortUpstream)
  try {
    try {
      const upstream = await fetch(CODEX_API_ENDPOINT, {
        method: reqBody.request?.method ?? "POST",
        headers: buildOpenAIHeaders(auth),
        body: typeof reqBody.request?.body === "string" ? reqBody.request.body : JSON.stringify(reqBody.request?.body ?? {}),
        signal: abortController.signal,
      })
      await log(options.logEnabled, "runtime.upstream.response", {
        status: upstream.status,
        contentType: upstream.headers.get("content-type"),
      })
      res.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") ?? "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      })
      if (!upstream.body) {
        res.end()
        return
      }
      try {
        for await (const chunk of upstream.body) {
          if (res.destroyed) break
          res.write(chunk)
        }
      } catch (error) {
        if (!(abortController.signal.aborted && res.destroyed)) throw error
      }
    } catch (error) {
      if (!(abortController.signal.aborted && (req.destroyed || res.destroyed))) throw error
    }
    if (!res.writableEnded && !res.destroyed) res.end()
  } finally {
    req.off("aborted", abortUpstream)
    res.off("close", abortUpstream)
  }
}

async function handleOpenAIModels(res, providerSourceURL) {
  const response = await fetch(resolveConfiguredURL(providerSourceURL))
  if (!response.ok) {
    sendJson(res, response.status, { error: "provider_list_failed" })
    return
  }
  const body = await response.json()
  const provider = body?.all?.find((item) => item.id === "openai")
  if (!provider) {
    sendJson(res, 404, { error: "provider_not_found" })
    return
  }
  sendJson(res, 200, {
    provider: provider.id,
    models: provider.models,
  })
}

function isSupportedOpenAIProviderMode(payload) {
  return payload.provider === "openai" && (payload.mode === "oauth" || payload.mode === "models")
}

function authorizeRuntime(req, providerOptions) {
  const runtimeAuth = providerOptions?.runtime_auth
  if (!runtimeAuth) return false
  const actual = req.headers[runtimeAuth.header.toLowerCase()]
  return typeof actual === "string" && actual === runtimeAuth.secret
}

async function handleRequest(req, res, options) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`)
  const pathname = url.pathname

  if (req.method !== "POST" || pathname !== "/runtime") {
    sendJson(res, 404, { error: "not_found" })
    return
  }
  const body = await readBody(req)
  const payload = JSON.parse(body)
  await log(options.logEnabled, "runtime.request.received", {
    provider: payload.provider,
    mode: payload.mode,
    method: payload.request?.method,
    url: payload.request?.url,
    path: pathname,
  })
  if (!isSupportedOpenAIProviderMode(payload)) {
    sendJson(res, 400, { error: "unsupported_provider_mode" })
    return
  }
  if (!authorizeRuntime(req, options.providers.openai)) {
    await log(options.logEnabled, "runtime.request.unauthorized", {
      provider: payload.provider,
      mode: payload.mode,
    })
    sendJson(res, 401, { error: "unauthorized" })
    return
  }
  if (payload.mode === "models") {
    await handleOpenAIModels(res, options.providers.openai.codex_responses.provider_source_url)
    return
  }
  await handleOpenAIRuntime(req, payload, res, options)
}

export default {
  id: PLUGIN_ID,
  async server(_input, rawOptions) {
    const options = parseOptions(rawOptions)
    if (!httpServer) {
      httpServer = createServer((req, res) => {
        void handleRequest(req, res, options).catch(async (error) => {
          await log(options.logEnabled, "runtime.request.failed", { message: error instanceof Error ? error.message : String(error) })
          sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        })
      })
      await new Promise((resolve, reject) => {
        httpServer.once("error", reject)
        httpServer.listen(options.port, options.hostname, resolve)
      })
      await log(options.logEnabled, "runtime.server.started", {
        hostname: options.hostname,
        port: options.port,
        path: "/runtime",
      })
    }
    if (!responsesHttpServer && options.providers.openai?.codex_responses?.enabled !== false) {
      const server = createCodexResponsesServer(options, log)
      try {
        await new Promise((resolve, reject) => {
          server.once("error", reject)
          server.listen(options.responsesPort, options.responsesHostname, resolve)
        })
        responsesHttpServer = server
        await log(options.logEnabled, "responses.server.started", {
          hostname: options.responsesHostname,
          port: options.responsesPort,
          paths: ["/responses", "/v1/responses", "/models", "/v1/models"],
        })
      } catch (error) {
        server.close()
        await log(options.logEnabled, "responses.server.failed", {
          hostname: options.responsesHostname,
          port: options.responsesPort,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return {}
  },
}
