# provider-client

`provider-client` is the client-side provider runtime adapter used in this repository's separated OpenCode runtime architecture.

Its responsibilities are:

- override a provider's `baseURL`
- inject provider-specific request headers at LLM request time
- optionally write operational logs to a file without polluting the OpenCode TUI
- adapt selected provider entries so model interaction can be served by a detached OpenCode server runtime

## Install

Add the plugin to your OpenCode config using the tuple form `[pluginSpec, options]`.

Project config example:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "file:///absolute/path/to/provider-client",
      {
        "log": true,
        "debug": true,
        "providers": {
          "anthropic": {
            "baseURL": "https://gateway.example.com/anthropic",
            "headers": {
              "Authorization": "Bearer ${GATEWAY_TOKEN}",
              "X-Tenant": "acme"
            }
          }
        }
      }
    ]
  ]
}
```

Restart OpenCode after updating the config.

Notes:

- point the plugin spec at the repository root, not at `index.js`
- use an absolute `file://` URL; `~` is not expanded by OpenCode plugin config
- environment variables in the config are resolved before plugin loading

## Config Reference

Plugin options shape:

```json
{
  "log": false,
  "debug": false,
  "providers": {
    "provider-id": {
      "baseURL": "https://example.com/v1",
      "runtime": {
        "url": "http://runtime-server.internal:8788/runtime",
        "auth": {
          "header": "X-Runtime-Auth",
          "secret": "${RUNTIME_SHARED_SECRET}"
        }
      },
      "headers": {
        "Header-Name": "value"
      }
    }
  }
}
```

Fields:

- `log`: optional boolean, defaults to `false`
- `debug`: optional boolean, defaults to `false`
- `providers`: required object keyed by OpenCode provider id
- `providers.<id>.baseURL`: optional non-empty string; if set, the plugin writes it into `cfg.provider[providerID].options.baseURL`
- `providers.<id>.runtime.url`: optional string used by the local `openai` wrapper when that provider is backed by a detached runtime
- `providers.<id>.runtime.auth.header`: optional non-empty string; sent as the runtime server auth header name
- `providers.<id>.runtime.auth.secret`: optional non-empty string; sent as the runtime server auth header value
- `providers.<id>.headers`: optional string map; injected on each request for that provider via the `chat.headers` hook

Each provider override must define at least one of:

- `baseURL`
- `runtime`
- `headers`

## Behavior

The plugin uses OpenCode plugin hooks to shape provider behavior at runtime.

- `config(cfg)`: applies provider `baseURL` overrides before provider resolution
- `chat.headers(input, output)`: injects custom headers for matching providers at request time

When an override `baseURL` is configured, the plugin injects a provider-level custom `fetch` and rewrites the outbound request URL there.

For `openai`, the plugin also swaps the runtime provider implementation to a local wrapper module that still uses `@ai-sdk/openai`.

That wrapper preserves any original provider `fetch` already supplied by OpenCode plugins. This matters for the built-in OpenAI OAuth flow, where OpenCode's Codex plugin prepares the final authenticated upstream request.

If `providers.openai.runtime.url` is configured, the wrapper can also switch OpenAI OAuth requests into a detached runtime mode. In that mode, only the selected OpenAI runtime path is handed to the remote server plugin. API-key-based OpenAI requests and other providers continue using the existing local behavior.

When `providers.openai.runtime` is configured, the local OpenAI provider is treated as remote-runtime-backed at runtime. The client no longer depends on local OpenAI authorization for provider availability, and model metadata is fetched from the remote runtime server.

Precedence:

- `baseURL` from this plugin overwrites any existing `provider.<id>.options.baseURL`
- original provider auth headers are preserved on the client side
- header keys from this plugin are appended on top and may explicitly override same-name headers when you configure them
- original provider authentication settings are left untouched; the plugin does not clear `apiKey` and does not remove original auth headers
- for OpenAI OAuth, the original Codex OAuth `fetch` remains responsible for authentication preparation on the client side
- when detached runtime mode is configured, runtime auth is sent separately from the business request payload

## Logging

Set `log: true` to enable override lifecycle logs.

Set `debug: true` to enable request-level logs for plugin-controlled rewritten outbound requests.

Logs are written to the standard OpenCode log directory for the current user under a plugin-specific filename.

The plugin does not write logs to `stdout` or `stderr`, so it does not pollute the OpenCode TUI.

When `debug: true` is enabled, the plugin writes:

- `request.rewrite.started`
- `request.rewrite.completed`

Those entries include request method, original URL path, rewritten URL path, query parameter names, and response status. Query parameter values and header values are not logged.

Interpretation:

- `request.headers.applied` means the plugin injected headers before the request was sent
- `request.rewrite.started` means the plugin is about to send the rewritten outbound request
- `request.rewrite.completed` means the rewritten request returned an HTTP response

Example log output:

```text
2026-05-21T01:30:00.000Z [provider-client] initialized {"logPath":"~/.config/opencode/logs/provider-client.log","providers":{"anthropic":{"hasBaseURL":true,"headerKeys":["Authorization","X-Tenant"]}}}
2026-05-21T01:30:00.100Z [provider-client] baseurl.override.applied {"providerID":"anthropic","baseURL":"https://gateway.example.com/anthropic","nativeRuntimeDisabled":true}
2026-05-21T01:30:01.500Z [provider-client] request.headers.applied {"providerID":"anthropic","headerKeys":["Authorization","X-Tenant"]}
2026-05-21T01:30:01.501Z [provider-client] request.rewrite.started {"providerID":"anthropic","method":"POST","original":"https://api.anthropic.com/v1/messages","rewritten":"https://gateway.example.com/anthropic/messages","queryKeys":[]}
2026-05-21T01:30:01.820Z [provider-client] request.rewrite.completed {"providerID":"anthropic","method":"POST","original":"https://api.anthropic.com/v1/messages","rewritten":"https://gateway.example.com/anthropic/messages","queryKeys":[],"ok":true,"status":200}
```

Safety rules:

- header values are never written to logs
- query parameter values are never written to logs

## Multiple Providers

You can configure more than one provider in a single plugin instance:

```json
{
  "plugin": [
    [
      "file:///absolute/path/to/provider-client",
      {
        "debug": true,
        "providers": {
          "anthropic": {
            "baseURL": "https://gateway.example.com/anthropic",
            "headers": {
              "Authorization": "Bearer ${ANTHROPIC_GATEWAY_TOKEN}"
            }
          },
          "openai": {
            "baseURL": "https://gateway.example.com/openai",
            "headers": {
              "X-Route": "team-a"
            }
          }
        }
      }
    ]
  ]
}
```
