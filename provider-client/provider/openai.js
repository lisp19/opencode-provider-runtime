import { createOpenAI } from "@ai-sdk/openai"
import os from "node:os"
import path from "node:path"
import { appendFile, mkdir } from "node:fs/promises"

const OVERRIDE_OPTION = "__opencodeProviderRuntime"
const RUNTIME_DUMMY_KEY = "opencode-provider-runtime-dummy-key"
const LOG_DIR = path.join(os.homedir(), ".config", "opencode", "logs")
const LOG_PATH = path.join(LOG_DIR, "provider-client.log")
const GLOBAL_FETCH_STATE = {
  installed: false,
  originalFetch: globalThis.fetch,
  route: undefined,
}

async function log(enabled, event, detail) {
  if (!enabled) return
  const line = `${new Date().toISOString()} [provider-client] ${event} ${JSON.stringify(detail)}\n`
  try {
    await mkdir(LOG_DIR, { recursive: true })
    await appendFile(LOG_PATH, line, "utf8")
  } catch {}
}

function normalizePathname(pathname) {
  if (!pathname || pathname === "/") return "/"
  return pathname.endsWith("/") ? pathname.slice(0, -1) : pathname
}

function versionTail(pathname) {
  const match = /^\/v\d+(?:(?:alpha|beta)\d*)?(?=\/|$)/.exec(pathname)
  if (!match) return pathname || "/"
  const tail = pathname.slice(match[0].length)
  return tail || "/"
}

function rewriteURL(baseURL, input) {
  const original = new URL(input instanceof URL ? input.href : typeof input === "string" ? input : input.url)
  const target = new URL(baseURL)
  const basePath = normalizePathname(target.pathname)
  const tail = versionTail(original.pathname)
  target.pathname = `${basePath === "/" ? "" : basePath}${tail === "/" ? "" : tail}` || "/"
  target.search = original.search
  return { original, target }
}

function toHeaders(input, initHeaders) {
  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  if (initHeaders instanceof Headers) {
    initHeaders.forEach((value, key) => headers.set(key, value))
    return headers
  }
  if (Array.isArray(initHeaders)) {
    for (const [key, value] of initHeaders) {
      if (value !== undefined) headers.set(key, String(value))
    }
    return headers
  }
  if (initHeaders && typeof initHeaders === "object") {
    for (const [key, value] of Object.entries(initHeaders)) {
      if (value !== undefined) headers.set(key, String(value))
    }
  }
  return headers
}

function summarizeBody(body) {
  if (body === undefined || body === null) return undefined
  if (typeof body === "string") {
    try {
      return JSON.parse(body)
    } catch {
      return body
    }
  }
  if (body instanceof URLSearchParams) return body.toString()
  if (body instanceof ArrayBuffer) return { type: "ArrayBuffer", byteLength: body.byteLength }
  if (ArrayBuffer.isView(body)) return { type: body.constructor.name, byteLength: body.byteLength }
  return { type: typeof body }
}

function toHeaderObject(headers) {
  return Object.fromEntries(headers.entries())
}

function requestURL(input) {
  return new URL(input instanceof URL ? input.href : typeof input === "string" ? input : input.url)
}

function isModelForwardRequest(url) {
  if (url.hostname === "api.openai.com") {
    return /^\/v\d+(?:(?:alpha|beta)\d*)?(?=\/|$)/.test(url.pathname) || url.pathname.startsWith("/chat/completions")
  }
  return url.hostname === "chatgpt.com" && url.pathname === "/backend-api/codex/responses"
}

function isOauthRequest(options) {
  return options.apiKey === RUNTIME_DUMMY_KEY
}

function createRedirectFetch(baseURL, baseFetch, debug) {
  return async (requestInput, init) => {
    const { original, target } = rewriteURL(baseURL, requestInput)
    const headers = toHeaders(requestInput, init?.headers)
    await log(debug, "request.rewrite.final", {
      original: original.href,
      rewritten: target.href,
      method: typeof init?.method === "string" ? init.method.toUpperCase() : requestInput instanceof Request ? requestInput.method : "GET",
      headers: toHeaderObject(headers),
      body: summarizeBody(init?.body),
    })
    return baseFetch(target, {
      ...init,
      headers,
    })
  }
}

function installGlobalRedirectFetch(redirectFetch) {
  GLOBAL_FETCH_STATE.route = redirectFetch
  if (GLOBAL_FETCH_STATE.installed) return
  GLOBAL_FETCH_STATE.installed = true
  globalThis.fetch = async (requestInput, init) => {
    const route = GLOBAL_FETCH_STATE.route
    if (!route) return GLOBAL_FETCH_STATE.originalFetch(requestInput, init)
    try {
      if (isModelForwardRequest(requestURL(requestInput))) return route(requestInput, init)
    } catch {}
    return GLOBAL_FETCH_STATE.originalFetch(requestInput, init)
  }
}

async function runtimeOauthRequest(runtime, requestInput, init, debug) {
  const original = requestURL(requestInput)
  const headers = toHeaders(requestInput, init?.headers)
  const runtimeHeaders = new Headers({
    "content-type": "application/json",
  })
  for (const [key, value] of Object.entries(runtime.headers ?? {})) {
    runtimeHeaders.set(key, value)
  }
  if (runtime.auth) {
    runtimeHeaders.set(runtime.auth.header, runtime.auth.secret)
  }
  const payload = {
    provider: "openai",
    mode: "oauth",
    request: {
      url: original.href,
      method: typeof init?.method === "string" ? init.method.toUpperCase() : requestInput instanceof Request ? requestInput.method : "GET",
      headers: toHeaderObject(headers),
      body: summarizeBody(init?.body),
    },
  }
  await log(debug, "request.runtime.started", {
    runtimeUrl: runtime.url,
    upstream: original.href,
    method: payload.request.method,
  })
  const response = await fetch(runtime.url, {
    method: "POST",
    headers: runtimeHeaders,
    body: JSON.stringify(payload),
  })
  await log(debug, "request.runtime.completed", {
    runtimeUrl: runtime.url,
    upstream: original.href,
    ok: response.ok,
    status: response.status,
    contentType: response.headers.get("content-type"),
  })
  return response
}

function composeFetch(options) {
  const override = options[OVERRIDE_OPTION]
  if (!override?.baseURL && !override?.runtime) return options.fetch

  const baseFetch = options.fetch ?? fetch
  const debug = override.debug === true
  if (override.runtime && isOauthRequest(options)) {
    return async (requestInput, init) => runtimeOauthRequest(override.runtime, requestInput, init, debug)
  }

  if (!override.baseURL) return baseFetch
  const redirectFetch = createRedirectFetch(override.baseURL, GLOBAL_FETCH_STATE.originalFetch, debug)
  if (!options.fetch) return redirectFetch
  installGlobalRedirectFetch(redirectFetch)

  return async (requestInput, init) => baseFetch(requestInput, init)
}

export function createOpenAIRedirect(options = {}) {
  const next = { ...options }
  delete next[OVERRIDE_OPTION]
  return createOpenAI({
    ...next,
    fetch: composeFetch(options),
  })
}
