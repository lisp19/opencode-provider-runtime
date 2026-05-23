#!/usr/bin/env zsh
set -euo pipefail

runtime_port="${RUNTIME_PORT:-3456}"
runtime_bind_host="${RUNTIME_BIND_HOST:-0.0.0.0}"
responses_port="${RESPONSES_PORT:-3455}"
responses_bind_host="${RESPONSES_BIND_HOST:-0.0.0.0}"
opencode_server_port="${OPENCODE_SERVER_PORT:-4096}"
runtime_auth_header="${RUNTIME_AUTH_HEADER:-X-Runtime-Auth}"
runtime_auth_secret="${RUNTIME_AUTH_SECRET:?RUNTIME_AUTH_SECRET must be set}"
DOLLAR='$'
service_name="opencode-provider-runtime.service"
remote_home="$HOME"
remote_user="$(id -un)"
remote_plugin_dir="${REMOTE_PLUGIN_DIR:-$remote_home/provider-server}"
remote_config_dir="$remote_home/.config/opencode"
remote_config_path="$remote_config_dir/opencode.provider-runtime.jsonc"
opencode_bin=""
bootstrap_url="http://127.0.0.1:$opencode_server_port/path?directory=$remote_home"
bootstrap_wait_seconds="${BOOTSTRAP_WAIT_SECONDS:-30}"

test -d "$remote_plugin_dir"
mkdir -p "$remote_config_dir"

if command -v opencode >/dev/null 2>&1; then
  opencode_bin="$(command -v opencode)"
elif [ -x "$remote_home/.opencode/bin/opencode" ]; then
  opencode_bin="$remote_home/.opencode/bin/opencode"
elif [ -x "$remote_home/.bun/bin/opencode" ]; then
  opencode_bin="$remote_home/.bun/bin/opencode"
else
  printf 'opencode binary not found\n' >&2
  exit 1
fi

bootstrap_command="for i in \$(seq 1 $bootstrap_wait_seconds); do curl -fsS '$bootstrap_url' >/dev/null && break; sleep 1; done; curl -fsS '$bootstrap_url' >/dev/null; for i in \$(seq 1 $bootstrap_wait_seconds); do ss -ltn | grep -q ':$runtime_port ' && exit 0; sleep 1; done; echo 'provider runtime bootstrap timed out' >&2; exit 1"

cat > "$remote_config_path" <<EOF
{
  "${DOLLAR}schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "file://$remote_plugin_dir",
      {
        "port": $runtime_port,
        "hostname": "$runtime_bind_host",
        "responses_port": $responses_port,
        "responses_hostname": "$responses_bind_host",
        "log": true,
        "providers": {
          "openai": {
            "mode": "oauth",
            "runtime_auth": {
              "header": "$runtime_auth_header",
              "secret": "$runtime_auth_secret"
            },
            "codex_responses": {
              "provider_source_url": "http://127.0.0.1:$opencode_server_port/provider?directory=${DOLLAR}{HOME_URLENCODED}"
            }
          }
        }
      }
    ]
  ]
}
EOF

cat <<EOF | sudo tee /etc/systemd/system/$service_name >/dev/null
[Unit]
Description=OpenCode Provider Runtime
After=network.target

[Service]
Type=simple
User=$remote_user
WorkingDirectory=$remote_home
Environment=HOME=$remote_home
Environment=OPENCODE_CONFIG=$remote_config_path
ExecStart=$opencode_bin serve --hostname 127.0.0.1 --port $opencode_server_port
ExecStartPost=/bin/sh -lc "$bootstrap_command"
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now "$service_name"
sudo systemctl restart "$service_name"
/bin/sh -lc "$bootstrap_command"
sudo systemctl status "$service_name" --no-pager
