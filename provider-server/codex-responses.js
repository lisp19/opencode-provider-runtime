import { createServer } from "node:http"
import os from "node:os"
import { buildOpenAIHeaders, getOpenAIOAuth } from "./openai-oauth.js"

const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses"
const DEFAULT_CLIENT_VERSION = "0.0.0"
const DEFAULT_BASE_INSTRUCTIONS =
  "You are Codex, a coding agent based on GPT-5. You and the user share the same workspace and collaborate to achieve the user's goals."
const GENERIC_REASONING_LEVELS = [
  { effort: "low", description: "Fast responses with lighter reasoning" },
  { effort: "medium", description: "Balances speed and reasoning depth for everyday tasks" },
  { effort: "high", description: "Greater reasoning depth for complex problems" },
  { effort: "xhigh", description: "Extra high reasoning depth for complex problems" },
]

class HttpError extends Error {
  constructor(status, code, message = code) {
    super(message)
    this.name = "HttpError"
    this.status = status
    this.code = code
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function cloneJSON(value) {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value))
}

function uniqueStrings(values) {
  const result = []
  const seen = new Set()
  for (const value of values) {
    if (typeof value !== "string") continue
    const trimmed = value.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    result.push(trimmed)
  }
  return result
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

function sendMethodNotAllowed(res, allowed) {
  res.writeHead(405, { "content-type": "application/json", allow: allowed.join(", ") })
  res.end(JSON.stringify({ error: "method_not_allowed" }))
}

function sendError(res, error) {
  if (error instanceof HttpError) {
    sendJson(res, error.status, { error: error.code })
    return
  }
  sendJson(res, 500, { error: "internal_error" })
}

function resolveConfiguredURL(template) {
  return template
    .replaceAll("${HOME_URLENCODED}", encodeURIComponent(os.homedir()))
    .replaceAll("${HOME}", os.homedir())
}

function getHeaderValue(headers, name) {
  const value = headers[name.toLowerCase()]
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : undefined
  return typeof value === "string" ? value : undefined
}

function bearerToken(req) {
  const authorization = getHeaderValue(req.headers, "authorization")
  if (!authorization) return undefined
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim())
  return match?.[1]
}

function authorizeResponses(req, providerOptions) {
  const runtimeAuth = providerOptions?.runtime_auth
  if (!runtimeAuth) return false
  if (bearerToken(req) === runtimeAuth.secret) return true
  const actual = getHeaderValue(req.headers, runtimeAuth.header)
  return typeof actual === "string" && actual === runtimeAuth.secret
}

function isResponsesPath(pathname) {
  return pathname === "/responses" || pathname === "/v1/responses"
}

function isModelsPath(pathname) {
  return pathname === "/models" || pathname === "/v1/models"
}

async function pipeUpstreamResponse(upstream, res, defaultContentType) {
  res.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") ?? defaultContentType,
    "cache-control": upstream.headers.get("cache-control") ?? "no-cache",
    connection: upstream.headers.get("connection") ?? "keep-alive",
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

function normalizeTemplateModels(payload) {
  return Array.isArray(payload?.models) ? payload.models.filter(isRecord) : []
}

function canonicalOpenAIModelSlug(model) {
  const api = isRecord(model.api) ? model.api : undefined
  if (typeof api?.id === "string" && api.id.trim()) return api.id.trim()
  if (typeof model.id === "string" && model.id.trim()) return model.id.trim()
  return undefined
}

function providerModelDescription(model) {
  if (typeof model.family === "string" && model.family.trim()) return model.family.trim()
  if (typeof model.name === "string" && model.name.trim()) return model.name.trim()
  return undefined
}

function providerModelContextLimit(model) {
  const limit = isRecord(model.limit) ? model.limit : undefined
  return typeof limit?.context === "number" && Number.isFinite(limit.context) && limit.context > 0 ? limit.context : undefined
}

function providerModelReasoningEnabled(model) {
  const capabilities = isRecord(model.capabilities) ? model.capabilities : undefined
  return capabilities?.reasoning === true
}

function providerModelInputModalities(model) {
  const capabilities = isRecord(model.capabilities) ? model.capabilities : undefined
  const input = isRecord(capabilities?.input) ? capabilities.input : {}
  const modalities = []
  if (input.text !== false) modalities.push("text")
  if (input.image === true) modalities.push("image")
  return uniqueStrings(modalities.length ? modalities : ["text"])
}

function normalizeCodexModelInfo(modelInfo) {
  const normalized = isRecord(modelInfo) ? { ...modelInfo } : {}
  if (!Array.isArray(normalized.additional_speed_tiers)) normalized.additional_speed_tiers = []
  if (!Array.isArray(normalized.service_tiers)) normalized.service_tiers = []
  if (!Array.isArray(normalized.supported_reasoning_levels)) normalized.supported_reasoning_levels = []
  if (!Array.isArray(normalized.experimental_supported_tools)) normalized.experimental_supported_tools = []
  if (!Array.isArray(normalized.input_modalities) || normalized.input_modalities.length === 0) normalized.input_modalities = ["text", "image"]
  if (!isRecord(normalized.truncation_policy)) normalized.truncation_policy = { mode: "tokens", limit: 10000 }
  return normalized
}

function genericCodexModelTemplate(slug, providerModel) {
  const reasoningEnabled = providerModel ? providerModelReasoningEnabled(providerModel) : false
  return {
    slug,
    display_name: slug,
    description: providerModelDescription(providerModel ?? {}) ?? slug,
    default_reasoning_level: reasoningEnabled ? "medium" : null,
    supported_reasoning_levels: reasoningEnabled ? GENERIC_REASONING_LEVELS.slice() : [],
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority: 0,
    additional_speed_tiers: [],
    service_tiers: [],
    default_service_tier: null,
    availability_nux: null,
    upgrade: null,
    base_instructions: DEFAULT_BASE_INSTRUCTIONS,
    model_messages: null,
    supports_reasoning_summaries: reasoningEnabled,
    default_reasoning_summary: "auto",
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: "freeform",
    web_search_tool_type: "text",
    truncation_policy: { mode: "tokens", limit: 10000 },
    supports_parallel_tool_calls: false,
    supports_image_detail_original: providerModelInputModalities(providerModel ?? {}).includes("image"),
    context_window: null,
    max_context_window: null,
    auto_compact_token_limit: null,
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: providerModelInputModalities(providerModel ?? {}),
    supports_search_tool: false,
  }
}

function findLongestPrefixTemplate(slug, templates) {
  let bestMatch
  for (const template of templates) {
    if (typeof template.slug !== "string") continue
    if (!slug.startsWith(template.slug)) continue
    if (!bestMatch || template.slug.length > bestMatch.slug.length) bestMatch = template
  }
  return bestMatch
}

function selectTemplateForSlug(slug, templateModels) {
  const exact = templateModels.find((model) => model.slug === slug)
  if (exact) return exact
  const prefixed = findLongestPrefixTemplate(slug, templateModels)
  if (prefixed) return prefixed
  const [namespace, suffix] = slug.split("/", 2)
  if (namespace && suffix) return findLongestPrefixTemplate(suffix, templateModels)
  return undefined
}

function buildCodexModelInfo(providerModel, index, templateModels) {
  const slug = canonicalOpenAIModelSlug(providerModel)
  if (!slug) throw new Error("provider model is missing api.id")
  const base = genericCodexModelTemplate(slug, providerModel)
  const template = normalizeCodexModelInfo(cloneJSON(selectTemplateForSlug(slug, templateModels)))
  const merged = { ...base, ...template }
  const inputModalities = providerModelInputModalities(providerModel)
  const contextLimit = providerModelContextLimit(providerModel)
  merged.slug = slug
  merged.display_name = typeof providerModel.name === "string" && providerModel.name.trim() ? providerModel.name.trim() : merged.display_name
  merged.description = providerModelDescription(providerModel) ?? merged.description ?? null
  merged.priority = index
  merged.visibility = "list"
  merged.supported_in_api = true
  merged.input_modalities = inputModalities
  merged.context_window = contextLimit ?? merged.context_window ?? merged.max_context_window ?? null
  merged.max_context_window = contextLimit ?? merged.max_context_window ?? merged.context_window ?? null
  if (!providerModelReasoningEnabled(providerModel)) {
    merged.default_reasoning_level = null
    merged.supported_reasoning_levels = []
    merged.supports_reasoning_summaries = false
    merged.default_reasoning_summary = "auto"
  }
  return merged
}

function buildSuppressionModel(slug, templateModels, priority) {
  const base = genericCodexModelTemplate(slug)
  const template = normalizeCodexModelInfo(cloneJSON(selectTemplateForSlug(slug, templateModels)))
  return {
    ...base,
    ...template,
    slug,
    display_name: typeof template.display_name === "string" && template.display_name.trim() ? template.display_name : slug,
    description: template.description ?? slug,
    visibility: "none",
    supported_in_api: false,
    priority,
  }
}

async function fetchProviderDirectory(providerOptions) {
  let response
  try {
    response = await fetch(resolveConfiguredURL(providerOptions.codex_responses.provider_source_url))
  } catch {
    throw new HttpError(502, "provider_source_failed")
  }
  if (!response.ok) throw new HttpError(502, "provider_source_failed")
  const body = await response.json()
  if (!isRecord(body) || !Array.isArray(body.all)) throw new HttpError(502, "provider_source_invalid")
  return body
}

function extractOpenAIProvider(directory) {
  const provider = directory.all.find((item) => isRecord(item) && item.id === "openai")
  if (!provider) throw new HttpError(404, "provider_not_found")
  if (!isRecord(provider.models)) throw new HttpError(502, "provider_models_invalid")
  return provider
}

function providerModelsInOrder(provider) {
  const result = []
  const seen = new Set()
  for (const model of Object.values(provider.models)) {
    if (!isRecord(model)) continue
    const slug = canonicalOpenAIModelSlug(model)
    if (!slug || seen.has(slug)) continue
    seen.add(slug)
    result.push(model)
  }
  return result
}

async function fetchOfficialCodexModels(providerOptions, clientVersion, options, log) {
  try {
    const auth = await getOpenAIOAuth()
    const upstreamURL = new URL(providerOptions.codex_responses.upstream_models_url)
    upstreamURL.searchParams.set("client_version", clientVersion || DEFAULT_CLIENT_VERSION)
    const response = await fetch(upstreamURL, { method: "GET", headers: buildOpenAIHeaders(auth, false) })
    if (!response.ok) {
      await log(options.logEnabled, "responses.models.templates.failed", { status: response.status, url: upstreamURL.href })
      return []
    }
    return normalizeTemplateModels(await response.json())
  } catch (error) {
    await log(options.logEnabled, "responses.models.templates.failed", {
      message: error instanceof Error ? error.message : String(error),
    })
    return []
  }
}

async function buildCodexModelsResponse(options, log, clientVersion) {
  const providerOptions = options.providers.openai
  const directory = await fetchProviderDirectory(providerOptions)
  const provider = extractOpenAIProvider(directory)
  const providerModels = providerModelsInOrder(provider)
  const templateModels = await fetchOfficialCodexModels(providerOptions, clientVersion, options, log)
  const models = []
  const seenSlugs = new Set()

  for (const [index, providerModel] of providerModels.entries()) {
    try {
      const modelInfo = buildCodexModelInfo(providerModel, index, templateModels)
      models.push(modelInfo)
      seenSlugs.add(modelInfo.slug)
    } catch (error) {
      await log(options.logEnabled, "responses.models.model_skipped", {
        modelID: providerModel.id,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const suppressionSlugs = uniqueStrings(providerOptions.codex_responses.bundled_openai_slugs)
  for (const [index, slug] of suppressionSlugs.entries()) {
    if (seenSlugs.has(slug)) continue
    models.push(buildSuppressionModel(slug, templateModels, 10000 + index))
  }

  return { models }
}

async function handleModels(url, res, options, log) {
  const clientVersion = url.searchParams.get("client_version") || DEFAULT_CLIENT_VERSION
  const body = await buildCodexModelsResponse(options, log, clientVersion)
  sendJson(res, 200, body)
}

async function handleResponses(req, res, reqBody, options, log) {
  const auth = await getOpenAIOAuth()
  const abortController = new AbortController()
  const abortUpstream = () => abortController.abort()
  req.once("aborted", abortUpstream)
  res.once("close", abortUpstream)
  try {
    try {
      const upstream = await fetch(CODEX_API_ENDPOINT, {
        method: "POST",
        headers: buildOpenAIHeaders(auth, true),
        body: reqBody,
        signal: abortController.signal,
      })
      await log(options.logEnabled, "responses.upstream.response", {
        status: upstream.status,
        contentType: upstream.headers.get("content-type"),
      })
      try {
        await pipeUpstreamResponse(upstream, res, "text/event-stream")
      } catch (error) {
        if (!(abortController.signal.aborted && res.destroyed)) throw error
      }
    } catch (error) {
      if (!(abortController.signal.aborted && (req.destroyed || res.destroyed))) throw error
    }
  } finally {
    req.off("aborted", abortUpstream)
    res.off("close", abortUpstream)
  }
}

async function handleRequest(req, res, options, log) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`)
  const pathname = url.pathname

  if (!authorizeResponses(req, options.providers.openai)) {
    sendJson(res, 401, { error: "unauthorized" })
    return
  }

  if (isModelsPath(pathname)) {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, ["GET"])
      return
    }
    await log(options.logEnabled, "responses.models.requested", {
      path: pathname,
      clientVersion: url.searchParams.get("client_version") || DEFAULT_CLIENT_VERSION,
    })
    await handleModels(url, res, options, log)
    return
  }

  if (isResponsesPath(pathname)) {
    if (req.method !== "POST") {
      sendMethodNotAllowed(res, ["POST"])
      return
    }
    await log(options.logEnabled, "responses.request.received", { path: pathname })
    await handleResponses(req, res, await readBody(req), options, log)
    return
  }

  sendJson(res, 404, { error: "not_found" })
}

export function createCodexResponsesServer(options, log) {
  return createServer((req, res) => {
    void handleRequest(req, res, options, log).catch(async (error) => {
      await log(options.logEnabled, "responses.request.failed", {
        message: error instanceof Error ? error.message : String(error),
      })
      sendError(res, error)
    })
  })
}
