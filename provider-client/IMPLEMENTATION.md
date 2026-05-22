# Detached Provider Runtime Implementation Notes

- Keep existing provider baseURL and header override behavior for API-based providers.
- Keep the existing direct OpenAI OAuth path as a fallback path.
- Add a detached runtime mode that activates only for `openai` when the runtime request is using the Codex OAuth fetch path.
- Keep detached runtime behavior localized to `provider/openai.js` as much as possible.
- Detached runtime mode sends a simple JSON payload with business fields only:
  - model
  - method
  - url
  - headers
  - body
- The client-side plugin preserves configured headers in the request payload that it hands to the server-side runtime host.
- The server-side runtime host is a separate OpenCode plugin that opens an HTTP port and accepts JSON RPC-style requests.
- The server-side runtime host reads provider authorization state locally and sends the request through the remote machine's native Codex OAuth path.
- The server-side runtime host returns the upstream SSE response with minimal transformation.
- Deployment target for the server-side runtime host is a long-running OpenCode instance managed by `systemd`.
