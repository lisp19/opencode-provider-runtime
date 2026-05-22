# opencode-provider-runtime

This repository documents a public-facing architecture for running OpenCode with a separated provider runtime.

The implementation is organized as two standalone OpenCode plugin directories:

- `provider-client`: client-side provider runtime adapter
- `provider-server`: server-side provider runtime host

## Why this exists

OpenCode already has a strong local agent runtime. This repository explores a complementary deployment shape where the agent-facing runtime and the provider-facing runtime can live in different places.

That separation is useful when you want to:

- keep agent workflows local while moving provider execution into a dedicated service environment
- reuse a remote machine's provider authorization context
- fetch model metadata from a remote OpenCode instance instead of the local machine
- control provider routing and request shaping without changing OpenCode source code

## Architecture

The repository currently implements a two-plugin layout.

### Client-side provider runtime adapter

The client-side plugin runs in the local OpenCode process and is responsible for:

- provider base URL overrides
- provider-scoped header injection
- adapting local provider entries to a detached runtime model
- requesting remote model metadata when a provider is backed by a remote runtime

### Server-side provider runtime host

The server-side plugin runs in a separate OpenCode server process and is responsible for:

- exposing a controlled HTTP entrypoint for provider runtime operations
- reusing the server machine's provider authorization context
- executing provider-facing requests inside the remote OpenCode environment
- returning model metadata and upstream responses to the caller

## Repository Layout

- `provider-client/`
  Client-side plugin and notes for provider adaptation in the local OpenCode process.
- `provider-server/`
  Server-side plugin and deployment notes for hosting a detached provider runtime.

The key idea is:

- the OpenCode agent runtime can remain where the user works
- the model interaction layer can be hosted in a separate OpenCode server environment
- the two sides coordinate through plugin-defined runtime operations

## Scope

This repository does not modify OpenCode core. The implementation stays at the plugin layer.

## Status

The code in this repository reflects an active working implementation. The documentation intentionally focuses on architecture and setup patterns rather than personal machine layouts or one-off deployment details.
