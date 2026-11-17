# lootatlas

Where does that item spawn, and how do two rifles actually compare? lootatlas is a local forwarding client for the hosted dzpage DayZ MCP service: it answers `tools/list` locally from the captured tool definitions and forwards every call to the service, returning the answers exactly as the service sends them back.

The twelve tools cover the DayZ item database, loot spawn locations, firearm comparisons, infected stats, the community server list, update history for the Central Economy files, and helpers that explain server settings, check config files, and explain server logs. One tool, `find_tool`, is a directory read: it returns the names, descriptions, and links of the vendor's browser tools for a task and executes nothing.

## The tools

- **`search_items`** — Search the item database (about 5,000 vanilla classes) by name in any language or by class name, optionally filtered by `category` or loot `tier`, with `sort`, paging, and `lang` options. No required parameters.
- **`get_item`** — Full record of one item by `class_name` (required): weight, sizes, weapon stats, compatible magazines and attachments, loot tiers, crafting, and repair kits.
- **`where_to_find_item`** — Where an item (`item`, required) spawns on a `map`: places with the most loot buildings that can hold it, with coordinates, grid square, and loot tier zone.
- **`compare_weapons`** — Compare up to 6 firearms (`weapons`, required) by damage per shot at given `distances_m`, hits to kill with and without a `vest`, velocity, rate of fire, and magazine size.
- **`get_infected`** — Stats of an infected type (`query`, required): health per hit zone, attack damage, speed, drops, and spawn events, optionally per `map`.
- **`search_servers`** — Search the community server list for PC, PlayStation, and Xbox by name or address, `platform`, `map`, `tags`, `region`, and more. No required parameters.
- **`dayz_update_changes`** — What each DayZ update changed in the vanilla Central Economy files; without a `version` it lists updates, with an `item` it shows one class's history. No required parameters.
- **`day_night_settings`** — Turn wanted day and night lengths (`day_minutes` and `night_minutes`, both required) into `serverTimeAcceleration` values for serverDZ.cfg for a `map`.
- **`explain_server_setting`** — Explain one setting (`setting`, required) of globals.xml or cfggameplay.json: what it does, vanilla value, type, range, and a ready line for the file.
- **`validate_config_file`** — Check a server file's `content` (required) for syntax errors the server would choke on, reporting all errors with line and column.
- **`analyze_server_log`** — Analyze a server `log` (required) and explain each problem in plain words, grouping repeats and suggesting a fix.
- **`find_tool`** — Find the dzpage.com browser tool for a `task` described in plain words; with an empty task it lists all tools. No required parameters.

## Install and run

As an MCP server via npm:

```bash
npx -y @reneturcios/lootatlas mcp
```

MCP client configuration:

```json
{
  "mcpServers": {
    "lootatlas": {
      "command": "npx",
      "args": ["-y", "@reneturcios/lootatlas", "mcp"]
    }
  }
}
```

As a container:

```bash
docker run -i ghcr.io/cloudcorprecords/lootatlas
docker run --rm ghcr.io/cloudcorprecords/lootatlas get_item '{"class_name":"AKM"}'
```

## CLI

One binary serves both the command line and the MCP server. Each tool is a subcommand taking a single JSON string with that tool's arguments:

```bash
lootatlas search_items '{"query":"akm"}'
lootatlas get_item '{"class_name":"AKM"}'
lootatlas where_to_find_item '{"item":"AKM"}'
lootatlas compare_weapons '{"weapons":["AKM","M4A1"]}'
lootatlas get_infected '{"query":"soldier"}'
lootatlas search_servers '{"query":"vanilla"}'
lootatlas dayz_update_changes '{}'
lootatlas day_night_settings '{"day_minutes":120,"night_minutes":30}'
lootatlas explain_server_setting '{"setting":"LootDamageMax"}'
lootatlas validate_config_file '{"content":"<types></types>"}'
lootatlas analyze_server_log '{"log":"..."}'
lootatlas find_tool '{"task":"shorter nights"}'
lootatlas --version
```

Exit codes: `0` when the forwarded call succeeds, `1` when the upstream result is an error, and `2` for usage problems such as an unknown subcommand or a malformed JSON argument.

## Configuration

- `DZPAGE_MCP_URL` — Overrides the upstream endpoint. The default is the pinned hosted endpoint, `https://dzpage.com/mcp`. (The override variable is a reconstruction added by this rebuild.)

The upstream registry record declares no headers, so no authentication header is ever sent; the tool surface was captured keyless.

Upstream failures — a JSON-RPC error from the service, a non-2xx response, an unreadable body, or a request that fails outright — are reported to the caller as an error result whose text starts with `lootatlas error:`.

## How forwarding works

The first forwarded call opens a session: an `initialize` request (protocol version `2025-03-26`), followed by a `notifications/initialized` notification, then the `tools/call` itself. If the service answers the initialize request with an `Mcp-Session-Id` header, that value is carried on every later request, and the open session is reused for the rest of the process. Replies are accepted either as plain JSON or as server-sent events. Successful results pass through verbatim, including any `isError` flag and any extra fields the service includes.

## Development

```bash
npm install
npm run build   # tsc -> dist/ (dist/cli.js is the bin)
npm test        # tsx --test test/*.test.ts — stubbed upstream, no network
npm run dev     # run the CLI from source
```

The test suite checks the served tool list against the captured surface (all 12 tools, deep-equal, in order, with titles served verbatim and no `required` key added to the four tools that carry none), exercises the session handshake and its reuse, verifies that no `Authorization` header is ever sent under any environment, and verifies that arguments go upstream untouched and results come back untouched.

## License

MIT — see `LICENSE`. Copyright (c) 2026 Rene Turcios.
