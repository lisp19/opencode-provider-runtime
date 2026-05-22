import os from "node:os"
import path from "node:path"
import { appendFile, mkdir } from "node:fs/promises"

const RUNTIME_DUMMY_KEY = "opencode-provider-runtime-dummy-key"

const PLUGIN_ID = "provider-client"
const LOG_DIR = path.join(os.homedir(), ".config", "opencode", "logs")
const LOG_PATH = path.join(LOG_DIR, `${PLUGIN_ID}.log`)
const OPENAI_WRAPPER = new URL("./provider/openai.js", import.meta.url).href
const OPENAI_OVERRIDE_OPTION = "__opencodeProviderRuntime"

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseOptions(options) {
  if (!isRecord(options)) {
    throw new Error(`${PLUGIN_ID}: plugin options must be an object`)
  }

  const log = options.log === undefined ? false : parseBoolean(options.log, "log")
  const debug = options.debug === undefined ? false : parseBoolean(options.debug, "debug")
  const providers = parseProviders(options.providers)
  return { log, debug, providers }
}

function parseBoolean(value, field) {
  if (typeof value === "boolean") return value
  throw new Error(`${PLUGIN_ID}: ${field} must be a boolean`)
}

function parseProviders(value) {
  if (!isRecord(value)) {
    throw new Error(`${PLUGIN_ID}: providers must be an object keyed by provider id`)
  }

  const result = {}
  for (const [providerID, override] of Object.entries(value)) {
    const normalizedID = providerID.trim()
    if (!normalizedID) {
      throw new Error(`${PLUGIN_ID}: providers cannot contain an empty provider id`)
    }

    result[normalizedID] = parseProviderOverride(normalizedID, override)
  }

  if (Object.keys(result).length === 0) {
    throw new Error(`${PLUGIN_ID}: providers must define at least one provider override`)
  }

  return result
}

function parseProviderOverride(providerID, value) {
  if (!isRecord(value)) {
    throw new Error(`${PLUGIN_ID}: providers.${providerID} must be an object`)
  }

  const baseURL = parseBaseURL(providerID, value.baseURL)
  const headers = parseHeaders(providerID, value.headers)
  const runtime = parseRuntime(providerID, value.runtime)

  if (!baseURL && Object.keys(headers).length === 0 && !runtime) {
    throw new Error(`${PLUGIN_ID}: providers.${providerID} must define baseURL, headers, and/or runtime`)
  }

  return { baseURL, headers, runtime }
}

function parseBaseURL(providerID, value) {
  if (value === undefined) return undefined
  if (typeof value !== "string") {
    throw new Error(`${PLUGIN_ID}: providers.${providerID}.baseURL must be a string`)
  }

  const next = value.trim()
  if (!next) {
    throw new Error(`${PLUGIN_ID}: providers.${providerID}.baseURL must not be empty`)
  }

  return next
}

function parseHeaders(providerID, value) {
  if (value === undefined) return {}
  if (!isRecord(value)) {
    throw new Error(`${PLUGIN_ID}: providers.${providerID}.headers must be an object`)
  }

  const result = {}
  for (const [header, headerValue] of Object.entries(value)) {
    const normalizedHeader = header.trim()
    if (!normalizedHeader) {
      throw new Error(`${PLUGIN_ID}: providers.${providerID}.headers cannot contain an empty header name`)
    }
    if (typeof headerValue !== "string") {
      throw new Error(`${PLUGIN_ID}: providers.${providerID}.headers.${normalizedHeader} must be a string`)
    }
    result[normalizedHeader] = headerValue
  }

  return result
}

function parseRuntime(providerID, value) {
  if (value === undefined) return undefined
  if (!isRecord(value)) {
    throw new Error(`${PLUGIN_ID}: providers.${providerID}.runtime must be an object`)
  }
  if (typeof value.url !== "string" || !value.url.trim()) {
    throw new Error(`${PLUGIN_ID}: providers.${providerID}.runtime.url must be a non-empty string`)
  }
  const headers = parseHeaders(`${providerID}.runtime`, value.headers)
  const auth = parseRuntimeAuth(providerID, value.auth)
  return {
    url: value.url.trim(),
    auth,
    headers,
  }
}

function parseRuntimeAuth(providerID, value) {
  if (value === undefined) return undefined
  if (!isRecord(value)) {
    throw new Error(`${PLUGIN_ID}: providers.${providerID}.runtime.auth must be an object`)
  }
  const header = typeof value.header === "string" ? value.header.trim() : ""
  const secret = typeof value.secret === "string" ? value.secret.trim() : ""
  if (!header) {
    throw new Error(`${PLUGIN_ID}: providers.${providerID}.runtime.auth.header must be a non-empty string`)
  }
  if (!secret) {
    throw new Error(`${PLUGIN_ID}: providers.${providerID}.runtime.auth.secret must be a non-empty string`)
  }
  return { header, secret }
}

function summary(overrides) {
  return Object.fromEntries(
    Object.entries(overrides).map(([providerID, override]) => [
      providerID,
      {
        hasBaseURL: Boolean(override.baseURL),
        headerKeys: Object.keys(override.headers),
        hasRuntime: Boolean(override.runtime),
      },
    ]),
  )
}

function safeStringify(detail) {
  return JSON.stringify(detail)
}

async function log(enabled, event, detail) {
  if (!enabled) return

  const line = `${new Date().toISOString()} [${PLUGIN_ID}] ${event}${detail === undefined ? "" : ` ${safeStringify(detail)}`}\n`
  try {
    await mkdir(LOG_DIR, { recursive: true })
    await appendFile(LOG_PATH, line, "utf8")
  } catch {}
}

async function runtimeModels(runtime) {
  const headers = new Headers({
    "content-type": "application/json",
  })
  for (const [key, value] of Object.entries(runtime.headers ?? {})) {
    headers.set(key, value)
  }
  if (runtime.auth) {
    headers.set(runtime.auth.header, runtime.auth.secret)
  }
  const response = await fetch(runtime.url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      provider: "openai",
      mode: "models",
    }),
  })
  if (!response.ok) {
    throw new Error(`Failed to load runtime models: ${response.status}`)
  }
  return response.json()
}

const runtimeInstructions = new Map()

function runtimeInstructionKey(sessionID, providerID) {
  return `${sessionID}:${providerID}`
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

function hasVersionPrefix(pathname) {
  return /^\/v\d+(?:(?:alpha|beta)\d*)?(?=\/|$)/.test(pathname)
}

function googleBasePath(basePath) {
  if (basePath === "/") return "/v1beta"
  if (hasVersionPrefix(basePath)) return basePath
  return `${basePath}/v1beta`
}

function googlePath(pathname, basePath) {
  const normalized = normalizePathname(pathname)
  const versionedBase = googleBasePath(basePath)
  if (normalized === "/") return versionedBase
  if (hasVersionPrefix(normalized)) {
    const tail = versionTail(normalized)
    return `${versionedBase}${tail === "/" ? "" : tail}`
  }
  if (normalized.startsWith("/models/")) {
    return `${versionedBase}${normalized}`
  }
  return `${versionedBase}${normalized}`
}

function rewriteURL(baseURL, input, providerID) {
  const original = new URL(input instanceof URL ? input.href : typeof input === "string" ? input : input.url)
  const target = new URL(baseURL)
  const basePath = normalizePathname(target.pathname)
  if (providerID === "google") {
    target.pathname = googlePath(original.pathname, basePath)
    target.search = original.search
    return { original, target }
  }
  const tail = versionTail(original.pathname)
  target.pathname = `${basePath === "/" ? "" : basePath}${tail === "/" ? "" : tail}` || "/"
  target.search = original.search
  return { original, target }
}

function mergeHeaders(requestInput, initHeaders, extraHeaders) {
  const headers = new Headers(requestInput instanceof Request ? requestInput.headers : undefined)
  if (initHeaders instanceof Headers) {
    initHeaders.forEach((value, key) => headers.set(key, value))
  } else if (Array.isArray(initHeaders)) {
    for (const [key, value] of initHeaders) {
      if (value !== undefined) headers.set(key, String(value))
    }
  } else if (isRecord(initHeaders)) {
    for (const [key, value] of Object.entries(initHeaders)) {
      if (value !== undefined) headers.set(key, String(value))
    }
  }

  for (const [key, value] of Object.entries(extraHeaders)) {
    headers.set(key, value)
  }

  return headers
}

function overrideFetch(providerID, override, parsed) {
  if (!override.baseURL) return undefined

  return async (requestInput, init) => {
    const { original, target } = rewriteURL(override.baseURL, requestInput, providerID)
    const headers = mergeHeaders(requestInput, init?.headers, override.headers)
    const requestInfo = {
      providerID,
      method: typeof init?.method === "string" ? init.method.toUpperCase() : requestInput instanceof Request ? requestInput.method : "GET",
      original: `${original.origin}${original.pathname}`,
      rewritten: `${target.origin}${target.pathname}`,
      queryKeys: Array.from(new Set(target.searchParams.keys())),
    }

    await log(parsed.log && parsed.debug, "request.rewrite.started", requestInfo)

    const response = await fetch(target, {
      ...init,
      headers,
    })

    await log(parsed.log && parsed.debug, "request.rewrite.completed", {
      ...requestInfo,
      ok: response.ok,
      status: response.status,
    })

    return response
  }
}

function patchProviderEntry(providerID, entry, override, parsed) {
  entry.options ??= {}

  if (providerID === "openai") {
    if (override.baseURL) {
      entry.options[OPENAI_OVERRIDE_OPTION] = {
        baseURL: override.baseURL,
        debug: parsed.log && parsed.debug,
        headers: override.headers,
        runtime: override.runtime,
      }
    } else if (override.runtime) {
      entry.options[OPENAI_OVERRIDE_OPTION] = {
        debug: parsed.log && parsed.debug,
        headers: override.headers,
        runtime: override.runtime,
      }
    }
    if (override.runtime) {
      entry.options.apiKey = RUNTIME_DUMMY_KEY
    }
    entry.npm = OPENAI_WRAPPER
    return
  }

  if (override.baseURL) {
    entry.options.baseURL = override.baseURL
    entry.options.fetch = overrideFetch(providerID, override, parsed)
  }
}

const plugin = {
  id: PLUGIN_ID,
  async server(_input, options) {
    const parsed = parseOptions(options)
    await log(parsed.log, "initialized", { logPath: LOG_PATH, providers: summary(parsed.providers) })

    return {
      async config(cfg) {
        cfg.provider ??= {}

        for (const [providerID, override] of Object.entries(parsed.providers)) {
          cfg.provider[providerID] ??= {}
          patchProviderEntry(providerID, cfg.provider[providerID], override, parsed)
          if (!override.baseURL) continue
          await log(parsed.log, "baseurl.override.applied", {
            providerID,
            baseURL: override.baseURL,
            providerNpm: cfg.provider[providerID].npm,
          })
        }
      },
      async "chat.headers"(input, output) {
        const override = parsed.providers[input.model.providerID]
        if (!override) return

        Object.assign(output.headers, override.headers)
        const headerKeys = Object.keys(output.headers)
        if (headerKeys.length === 0) return

        await log(parsed.log, "request.headers.applied", {
          providerID: input.model.providerID,
          headerKeys,
        })
      },
      async "experimental.chat.system.transform"(input, output) {
        const override = parsed.providers[input.model.providerID]
        if (!override?.runtime) return
        if (input.model.providerID !== "openai") return
        if (!input.sessionID) return

        runtimeInstructions.set(runtimeInstructionKey(input.sessionID, input.model.providerID), output.system.join("\n"))
        output.system.length = 0
      },
      async "chat.params"(input, output) {
        const override = parsed.providers[input.model.providerID]
        if (!override?.runtime) return
        if (input.model.providerID !== "openai") return

        const key = runtimeInstructionKey(input.sessionID, input.model.providerID)
        const instructions = runtimeInstructions.get(key)
        if (!instructions) return

        output.options.instructions = instructions
        runtimeInstructions.delete(key)
      },
      provider: {
        id: "openai",
        async models(provider) {
          const override = parsed.providers.openai
          if (!override) return provider.models

          if (override.runtime) {
            const remote = await runtimeModels(override.runtime)
            return Object.fromEntries(
              Object.entries(remote.models ?? {}).map(([modelID, model]) => [
                modelID,
                {
                  ...model,
                  api: {
                    ...model.api,
                    npm: OPENAI_WRAPPER,
                  },
                },
              ]),
            )
          }

          return Object.fromEntries(
            Object.entries(provider.models).map(([modelID, model]) => [
              modelID,
              {
                ...model,
                api: {
                  ...model.api,
                  npm: OPENAI_WRAPPER,
                },
              },
            ]),
          )
        },
      },
    }
  },
}

export default plugin
