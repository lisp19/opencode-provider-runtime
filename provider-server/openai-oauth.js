import os from "node:os"
import { readFile, writeFile } from "node:fs/promises"

const ISSUER = "https://auth.openai.com"
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const AUTH_PATH = `${os.homedir()}/.local/share/opencode/auth.json`

let inFlightAuthRefresh

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

async function refreshOpenAIOAuth() {
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

export async function getOpenAIOAuth() {
  const auth = await loadAuth()
  if (!auth || auth.type !== "oauth") throw new Error("Remote openai oauth auth not found")
  if (auth.access && auth.expires > Date.now()) return auth
  if (!inFlightAuthRefresh) {
    inFlightAuthRefresh = refreshOpenAIOAuth().finally(() => {
      inFlightAuthRefresh = undefined
    })
  }
  return inFlightAuthRefresh
}

export function buildOpenAIHeaders(auth, withContentType = true) {
  const headers = new Headers()
  headers.set("authorization", `Bearer ${auth.access}`)
  if (withContentType) headers.set("content-type", "application/json")
  if (auth.accountId) headers.set("ChatGPT-Account-Id", auth.accountId)
  return headers
}
