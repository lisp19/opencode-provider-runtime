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
  "log": true,
  "providers": {
    "openai": {
      "mode": "oauth",
      "runtime_auth": {
        "header": "X-Runtime-Auth",
        "secret": "${RUNTIME_SHARED_SECRET}"
      }
    }
  }
}
```

If `providers.openai.runtime_auth` is configured, the runtime server requires the matching header on incoming `POST /runtime` requests and returns `401` when it is missing or invalid.

The plugin exposes:

- `POST /runtime`

The request body is a simple runtime payload from the client-side plugin.

- For `mode: "oauth"`, the response is the upstream Codex SSE stream.
- For `mode: "models"`, the response is a JSON model map fetched through the server's authenticated OpenCode provider view.

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
