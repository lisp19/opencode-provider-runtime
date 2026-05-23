# provider-server

`provider-server` is the server-side provider runtime host used in this repository's separated OpenCode runtime architecture.

Its responsibilities are:

- run inside a dedicated OpenCode server process
- expose a controlled HTTP entrypoint for provider runtime operations
- reuse the server machine's local provider authorization context
- return upstream streaming responses and remote model metadata to the caller

## Config

Plugin options:

```json
{
  "port": 8788,
  "hostname": "127.0.0.1",
  "responses_port": 3455,
  "responses_hostname": "0.0.0.0",
  "log": true,
  "providers": {
    "openai": {
      "mode": "oauth",
      "runtime_auth": {
        "header": "X-Runtime-Auth",
        "secret": "${RUNTIME_SHARED_SECRET}"
      },
      "codex_responses": {
        "enabled": true,
        "provider_source_url": "http://127.0.0.1:4096/provider?directory=${HOME_URLENCODED}",
        "upstream_models_url": "https://chatgpt.com/backend-api/codex/models",
        "bundled_openai_slugs": [
          "gpt-5.5",
          "gpt-5.4",
          "gpt-5.4-mini",
          "gpt-5.3-codex",
          "gpt-5.2",
          "codex-auto-review"
        ]
      }
    }
  }
}
```

If `providers.openai.runtime_auth` is configured, the runtime server requires the matching header on incoming `POST /runtime` requests and returns `401` when it is missing or invalid.

The plugin exposes:

- `POST /runtime`
- `POST /responses`
- `POST /v1/responses`
- `GET /models`
- `GET /v1/models`

The request body is a simple runtime payload from the client-side plugin.

- For `mode: "oauth"`, the response is the upstream Codex SSE stream.
- For `mode: "models"`, the response is a JSON model map fetched through the server's authenticated OpenCode provider view.

The new Codex-facing endpoints are independent of `/runtime` and use the standard Responses API shape expected by Codex.

- `POST /responses` and `POST /v1/responses` proxy directly to ChatGPT Codex responses.
- `GET /models` and `GET /v1/models` read the server's authenticated OpenCode provider view in real time, then map that provider data into the Codex `ModelsResponse` format.

If `providers.openai.runtime_auth` is configured, the new endpoints accept either:

- `Authorization: Bearer <secret>`
- the same legacy runtime header used by `POST /runtime`

This makes it possible to point Codex at the server with a custom provider that uses `auth.command`.

Example Codex config:

```toml
model_provider = "opencode-openai"

[model_providers.opencode-openai]
name = "OpenCode OpenAI"
base_url = "http://127.0.0.1:3455/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false

[model_providers.opencode-openai.auth]
command = "/bin/sh"
args = ["-lc", "printf '%s' \"$OPENCODE_PROVIDER_SECRET\""]
```

A redacted remote-facing sample config is also included at `provider-server/codex.config.example.toml`.

`GET /models` keeps the active model list and context limits aligned with the OpenCode provider response. It also emits suppression entries for configured bundled Codex OpenAI slugs that are absent upstream, so Codex does not keep showing merged bundled models that the provider no longer exposes. That is what allows `gpt-5.5` to advertise `400000` context in the current OAuth-backed ChatGPT view while still returning Codex-compatible metadata.

## Deployment

Recommended deployment is a dedicated OpenCode server process with this plugin enabled and the required provider authorization already connected on that machine.

The deployment script warms the runtime host automatically after startup. It writes a `systemd` unit with `ExecStartPost` that calls the OpenCode bootstrap endpoint and waits for the plugin port to listen, so future service restarts do not require a manual warmup request.

Example `systemd` unit outline:

```ini
[Unit]
Description=OpenCode Provider Runtime Host
After=network.target

[Service]
User=runtime-user
WorkingDirectory=/srv/opencode-runtime
ExecStart=/path/to/opencode serve --hostname 127.0.0.1 --port 4096
Restart=always
Environment=OPENCODE_CONFIG=/path/to/opencode-runtime.jsonc

[Install]
WantedBy=multi-user.target
```
