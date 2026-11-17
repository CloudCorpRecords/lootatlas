# Changelog

## 0.1.0 (2026-10-28)

- First release: a forwarding client for the hosted dzpage DayZ MCP server. All 12 captured tools are answered locally for tools/list, and every tools/call is forwarded upstream over a streamable-HTTP JSON-RPC session (initialize, notifications/initialized, tools/call, honouring the Mcp-Session-Id header when the upstream issues one).
- Tools: `search_items`, `get_item`, `where_to_find_item`, `compare_weapons`, `get_infected`, `search_servers`, `dayz_update_changes`, `day_night_settings`, `explain_server_setting`, `validate_config_file`, `analyze_server_log`, `find_tool`. The capture carries `title` keys on every tool, served verbatim; `search_items`, `search_servers`, `dayz_update_changes` and `find_tool` carry no `required` key in the capture and none is served.
- Upstream results pass through verbatim, including the isError flag; upstream failures surface as `lootatlas error:` text results.
- One bin serves the CLI (one subcommand per tool, plus `--version`) and the stdio MCP server (`mcp` subcommand). The upstream endpoint can be overridden via `DZPAGE_MCP_URL`. The upstream record declares no headers, so no auth header is ever sent.
