# BUILD REPORT — lootatlas

Clean-room rebuild of `dzpage/dayz` v1.6.0 (remote-only MCP server at
`https://dzpage.com/mcp`), built 2026-10-28 as a forwarding client.
Package: `@reneturcios/lootatlas` 0.1.0, registry name
`io.github.CloudCorpRecords/lootatlas`.

## Surface built

Full surface: **12 of 12 captured tools built**, none omitted.

| Tool | Required fields as served |
|------|---------------------------|
| `search_items` | NO `required` key in the capture — served verbatim, none invented |
| `get_item` | `class_name` |
| `where_to_find_item` | `item` |
| `compare_weapons` | `weapons` |
| `get_infected` | `query` |
| `search_servers` | NO `required` key in the capture — served verbatim, none invented |
| `dayz_update_changes` | NO `required` key in the capture — served verbatim, none invented |
| `day_night_settings` | `day_minutes`, `night_minutes` |
| `explain_server_setting` | `setting` |
| `validate_config_file` | `content` |
| `analyze_server_log` | `log` |
| `find_tool` | NO `required` key in the capture — served verbatim, none invented |

Each served tool carries exactly the keys `name`, `title`,
`description`, `inputSchema`, exactly as captured: the capture
carries `title` keys on every tool and a `$schema` key inside every
`inputSchema`, and both are served verbatim. `find_tool` is built
like every other tool: per the spec's recorded distinction it is a
kept directory read of the vendor's website tools (names,
descriptions and links; it executes nothing and has no execution
sibling on this server). The tool literals were generated
programmatically from `harness/fixtures/dzpage-tools.json` by the
script at `/tmp/b49-lootatlas-scratch/gen.py` (parse +
re-serialise; the emitted `TOOL_DEFS` block was verified to
byte-match the block in `src/forward.ts` when stripped, and the
generator's own round-trip assertion confirmed the literals parse
back to the fixture's tool objects) — never retyped — and the
registration-integrity test suite plus the parity harness confirmed
the served literals deep-equal the fixture's 12 tool objects, in
order. Tools are registered via the MCP SDK low-level Server API
(`ListToolsRequestSchema` / `CallToolRequestSchema` handlers), not
McpServer+zod.

## Fixture conflicts

**None.** The spec and the fixture agree on all 12 tools' names,
titles, descriptions, required fields (including the four tools
with no `required` key: `search_items`, `search_servers`,
`dayz_update_changes`, `find_tool`) and property shapes. Where the
spec summarised and the fixture carried full detail (for example
the `$schema` key inside each `inputSchema`), the fixture was
followed verbatim, as instructed.

## Labelled reconstructions (from the spec's Wire section)

- Upstream endpoint pinned: `https://dzpage.com/mcp`.
- Env override `DZPAGE_MCP_URL` — labelled reconstruction.
- The registry record declares NO headers on the remote: no auth
  header is ever sent. Tests assert that no `Authorization` header
  is sent under any environment — including with key-like env vars
  (`DZPAGE_API_KEY`, `API_KEY`, `AUTHORIZATION`) set — and that no
  `X-API-Key` header is ever sent; upstream requests carry only
  `Content-Type`, `Accept` and, when issued, `Mcp-Session-Id`.
- Error rendering `lootatlas error:` text for upstream failures —
  labelled reconstruction. An upstream JSON-RPC error surfaces as
  isError text `lootatlas error: <upstream message>`; a transport
  failure surfaces as isError text `lootatlas error: <failure
  description>`.
- Upstream results pass through verbatim, including `content`,
  `structuredContent`, `isError` and any extra fields. tools/call
  is forwarded as streamable-HTTP JSON-RPC: initialize
  (protocolVersion `2025-03-26`) → notifications/initialized →
  tools/call, honouring `Mcp-Session-Id` when issued; plain-JSON
  and SSE replies are both parsed. The forwarding core takes an
  injectable fetch; tests stub the upstream — no live network
  calls in tests.

## Deviations

None.

## Lockfile

- Route: generated clean from birth in the build dir with no
  `node_modules` and no pre-existing lockfile:
  `npm install --package-lock-only --ignore-scripts --offline`
  (Route 3).
- Parses as JSON; `name` == `@reneturcios/lootatlas`.
- Package entries: **128**.
- sha256: `2f88aa72ab2d5a35df9ed6c8f12fc3af4241f9edf8c8a66b4ee5c3a418ba40c0`
  (re-verified unchanged after the subsequent offline `npm ci`).

## server.json

- Description exactly: "DayZ game data: item database, loot spawns, weapon comparisons, server search and config checks." —
  **96 characters** (verified programmatically, ≤100).
- npm package entry carries `"version": "0.1.0"`; the OCI entry
  (`ghcr.io/cloudcorprecords/lootatlas:0.1.0`) carries **no**
  `version` field. Both entries carry packageArguments
  `[{type: positional, value: mcp}]` and transport stdio.
  Dockerfile (node:20-alpine, both stages) carries the label
  `io.modelcontextprotocol.server.name="io.github.CloudCorpRecords/lootatlas"`.
  Container workflow `IMAGE` is `ghcr.io/cloudcorprecords/lootatlas`
  and its smoke test asserts the server name `lootatlas`.

## Verification (all run 2026-10-28)

1. `npx tsc --noEmit` → exit 0.
2. `npm run build` → exit 0; real `dist/` produced (cli, forward,
   index, mcp, types — .js, .d.ts, .js.map each).
3. `node dist/cli.js --version` → `0.1.0`.
4. `npm test` → **58 tests, 58 pass, 0 fail** (registration-integrity
   suite deep-equals the served tools/list against the fixture's 12
   tools, including title and required-key exactness assertions —
   the four no-required tools carry NO `required` key — plus
   session handling/reuse, env override, the no-Authorization-header
   assertions under any environment, verbatim per-tool argument
   forwarding for all 12 tools and result pass-through including
   structuredContent, extra fields and upstream isError, SSE
   parsing, both error renderings, MCP-layer validation, and CLI
   behaviour including a subcommand check for every tool and a
   forwarding test against a local stub server).
5. Parity: `python3 /home/hatch/workspace/mcp-rebuild-100/harness/parity.py --original /home/hatch/workspace/mcp-rebuild-100/harness/fixtures/dzpage-tools.json --rebuild "stdio:node /home/hatch/workspace/mcp-rebuild-100/builds/lootatlas/dist/cli.js mcp" --out /home/hatch/workspace/mcp-rebuild-100/builds/lootatlas/parity-out` → **verdict PASS, parity 100.0**
   (12/12 identical, 0 missing, 0 extra, no schema diffs). Output in
   `parity-out/`.
