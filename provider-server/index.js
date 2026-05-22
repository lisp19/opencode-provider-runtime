import { createServer } from "node:http"
import os from "node:os"
import path from "node:path"
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"

const PLUGIN_ID = "provider-server"
const ISSUER = "https://auth.openai.com"
const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses"
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const LOG_DIR = path.join(os.homedir(), ".config", "opencode", "logs")
const LOG_PATH = path.join(LOG_DIR, `${PLUGIN_ID}.log`)
const AUTH_PATH = path.join(os.homedir(), ".local", "share", "opencode", "auth.json")

let httpServer

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
  const logEnabled = value.log === true
  const providers = parseProviders(value.providers)
  return { port, hostname, logEnabled, providers }
}

function parseProviders(value) {
  if (!isRecord(value)) return { openai: { mode: "oauth" } }
  return Object.fromEntries(Object.entries(value).map(([provider, config]) => [provider, parseProvider(provider, config)]))
}

function parseProvider(provider, value) {
  const config = isRecord(value) ? value : {}
  const runtimeAuth = parseRuntimeAuth(provider, config.runtime_auth)
  return {
    ...config,
    runtime_auth: runtimeAuth,
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

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

async function loadAuth() {
  const raw = JSON.parse(await readFile(AUTH_PATH, "utf8"))
  return raw.openai
}

function parseJwtClaims(token) {
  const parts = token.split(".")
  if (parts.length !== 3) return undefined
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString())
  } catch {
    return undefined
  }
}

function extractAccountIdFromClaims(claims) {
  return claims.chatgpt_account_id || claims["https://api.openai.com/auth"]?.chatgpt_account_id || claims.organizations?.[0]?.id
}

function extractAccountId(tokens) {
  if (tokens.id_token) {
    const claims = parseJwtClaims(tokens.id_token)
    const accountId = claims && extractAccountIdFromClaims(claims)
    if (accountId) return accountId
  }
  if (tokens.access_token) {
    const claims = parseJwtClaims(tokens.access_token)
    return claims ? extractAccountIdFromClaims(claims) : undefined
  }
}

async function saveAuth(auth) {
  const raw = JSON.parse(await readFile(AUTH_PATH, "utf8"))
  raw.openai = auth
  await writeFile(AUTH_PATH, JSON.stringify(raw, null, 2), { mode: 0o600 })
}

async function refreshAccessToken(refreshToken) {
  const response = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }).toString(),
  })
  if (!response.ok) throw new Error(`Token refresh failed: ${response.status}`)
  return response.json()
}

async function getOpenAIOAuth() {
  const auth = await loadAuth()
  if (!auth || auth.type !== "oauth") throw new Error("Remote openai oauth auth not found")
  if (auth.access && auth.expires > Date.now()) return auth
  const tokens = await refreshAccessToken(auth.refresh)
  const next = {
    type: "oauth",
    refresh: tokens.refresh_token,
    access: tokens.access_token,
    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    accountId: extractAccountId(tokens) || auth.accountId,
  }
  await saveAuth(next)
  return next
}

function buildHeaders(auth) {
  const headers = new Headers()
  headers.set("authorization", `Bearer ${auth.access}`)
  headers.set("content-type", "application/json")
  if (auth.accountId) headers.set("ChatGPT-Account-Id", auth.accountId)
  return headers
}

async function handleOpenAIRuntime(reqBody, res, options) {
  const auth = await getOpenAIOAuth()
  const upstream = await fetch(CODEX_API_ENDPOINT, {
    method: reqBody.request?.method ?? "POST",
    headers: buildHeaders(auth),
    body: typeof reqBody.request?.body === "string" ? reqBody.request.body : JSON.stringify(reqBody.request?.body ?? {}),
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
  for await (const chunk of upstream.body) {
    res.write(chunk)
  }
  res.end()
}

async function handleOpenAIModels(res) {
  const response = await fetch(`http://127.0.0.1:4096/provider?directory=${encodeURIComponent(os.homedir())}`)
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
  if (!runtimeAuth) return true
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
    await handleOpenAIModels(res)
    return
  }
  await handleOpenAIRuntime(payload, res, options)
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
    return {}
  },
}
