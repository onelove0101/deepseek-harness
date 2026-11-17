---
description: "OAuth connector registry that authorizes third-party services and mounts their MCP servers."
kind: "package-reference"
---

# @deepseek-ai/dsh-connections

English

## Summary

`dsh-connections` lists built-in OAuth connectors, runs browser authorization, stores grants under `connections/<id>`, mirrors bearer tokens to credential refs for MCP templates, and registers streamable-http MCP servers through `ctx.mcpManager`. The first built-in connector is Google Sheets (`google-sheets`), targeting `https://sheetsmcp.googleapis.com/mcp/v1`.

Configure a Google OAuth client id on the plugin (`googleOAuthClientId`; optional `googleOAuthClientSecret` for confidential clients). The Web profile mounts this plugin after `mcp-manager` with `credentials`, `authorization`, and `mcpManager` injected.

## Remote API

- `list()` / `get(id)` — connector phase and optional `authorizeUrl` while connecting
- `connect(id, callbackOrigin)` — start Google OAuth (PKCE) using loopback `/connections/oauth/callback`
- `disconnect(id)` — delete grants, unset bearer ref, unregister MCP
- `watch(signal)` — stream of connector lists for Settings

## Model Experience

None, as connector management is Settings-only and MCP tools surface through the mounted server.

#### KV Cache effect

No direct model context; mounted MCP tools follow the MCP manager contract.

## Known Limitations and Deferred Work

- **Bearer-only MCP auth** — Google Sheets MCP is registered with a static Bearer header from the OAuth access token. Production Google MCP endpoints may require MCP-native OAuth later; the OAuth grant and MCP registration framework still ships so transport can evolve without redoing Settings.
