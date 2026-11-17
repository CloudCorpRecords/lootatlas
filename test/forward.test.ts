import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { fileURLToPath } from "node:url";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  LootatlasClient,
  callTool,
  createClient,
  DEFAULT_ENDPOINT_URL,
  isKnownTool,
  parseRpcBody,
  PROTOCOL_VERSION,
  TOOL_DEFS,
  TOOL_NAMES,
  VERSION,
} from "../src/forward.js";
import { handleCallTool } from "../src/mcp.js";
import type {
  FetchFn,
  FetchResponseLike,
  ToolDef,
  ToolResult,
} from "../src/types.js";

const FIXTURE_URL = new URL(
  "../../../harness/fixtures/dzpage-tools.json",
  import.meta.url,
);
const FIXTURE_AVAILABLE = existsSync(FIXTURE_URL);
const fixture = (
  FIXTURE_AVAILABLE
    ? JSON.parse(readFileSync(FIXTURE_URL, "utf-8"))
    : { tools: [] }
) as {
  tools: ToolDef[];
};
/**
 * Publish-survival guard (Wave 29 P1 preflight, proven Wave 24 pattern):
 * the parity fixture lives in the build harness, outside the published
 * repo tree, so fixture-dependent tests skip cleanly when it is absent;
 * with the fixture present they run in full, with no skips.
 */
function skipWithoutFixture(t: {
  skip: (message: string) => void;
}): boolean {
  if (FIXTURE_AVAILABLE) return false;
  t.skip("parity fixture lives in the build harness, not the repo tree");
  return true;
}


const PRIMARY = "search_items";
const ALL_TOOLS = [
  "search_items",
  "get_item",
  "where_to_find_item",
  "compare_weapons",
  "get_infected",
  "search_servers",
  "dayz_update_changes",
  "day_night_settings",
  "explain_server_setting",
  "validate_config_file",
  "analyze_server_log",
  "find_tool",
];
const NO_REQUIRED = [
  "search_items",
  "search_servers",
  "dayz_update_changes",
  "find_tool",
];
const REQUIRED: Record<string, string[]> = {
  get_item: ["class_name"],
  where_to_find_item: ["item"],
  compare_weapons: ["weapons"],
  get_infected: ["query"],
  day_night_settings: ["day_minutes", "night_minutes"],
  explain_server_setting: ["setting"],
  validate_config_file: ["content"],
  analyze_server_log: ["log"],
};

const SAMPLE_RESULT = {
  content: [
    {
      type: "text",
      text: "{\"class_name\":\"AKM\",\"weight\":2500}",
    },
  ],
  structuredContent: { class_name: "AKM", weight: 2500 },
};

const SAMPLE_ARGS = { query: "akm", category: "Weapon" };

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

interface FakeOptions {
  callResult?: Record<string, unknown>;
  callBodyText?: string;
  callError?: Record<string, unknown>;
  callStatus?: number;
  initError?: Record<string, unknown>;
  throwOn?: "initialize" | "tools/call";
  sessionId?: string | null;
  hangOnCall?: boolean;
  sse?: boolean;
}

function makeResponse(
  status: number,
  bodyText: string,
  headers: Record<string, string> = {},
): FetchResponseLike {
  const lowered = new Map(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lowered.get(name.toLowerCase()) ?? null },
    text: async () => bodyText,
  };
}

function jsonResponse(
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
) {
  return makeResponse(status, JSON.stringify(payload), headers);
}

function makeUpstream(options: FakeOptions = {}): {
  fetchFn: FetchFn;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
    calls.push({ url, headers: init?.headers ?? {}, body });
    const method = body.method as string;
    if (options.throwOn === method) throw new Error("socket hang up");
    if (method === "initialize") {
      if (options.initError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.initError,
        });
      }
      const headers: Record<string, string> = {};
      const sessionId =
        options.sessionId === undefined ? "sess-dz1" : options.sessionId;
      if (sessionId !== null) headers["mcp-session-id"] = sessionId;
      return jsonResponse(
        200,
        {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            serverInfo: { name: "dzpage", version: "1.6.0" },
          },
        },
        headers,
      );
    }
    if (method === "notifications/initialized") {
      return makeResponse(202, "");
    }
    if (method === "tools/call") {
      if (options.hangOnCall) {
        return new Promise<FetchResponseLike>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            if (signal.aborted) {
              reject(new Error("aborted"));
              return;
            }
            signal.addEventListener("abort", () => reject(new Error("aborted")));
          }
        });
      }
      if (options.callBodyText !== undefined) {
        return makeResponse(options.callStatus ?? 200, options.callBodyText);
      }
      if (options.callError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.callError,
        });
      }
      const result = options.callResult ?? SAMPLE_RESULT;
      const payload = { jsonrpc: "2.0", id: body.id, result };
      if (options.sse) {
        return makeResponse(
          200,
          `event: message\ndata: ${JSON.stringify(payload)}\n\n`,
        );
      }
      return jsonResponse(options.callStatus ?? 200, payload);
    }
    return jsonResponse(200, {});
  };
  return { fetchFn, calls };
}

function stubClient(options: FakeOptions = {}, extra: Record<string, unknown> = {}) {
  const upstream = makeUpstream(options);
  const c = new LootatlasClient({
    fetchFn: upstream.fetchFn,
    env: {},
    ...extra,
  });
  return { client: c, calls: upstream.calls };
}

function textOf(result: ToolResult): string {
  const content = result.content as Array<{ type: string; text: string }>;
  return content[0].text;
}

function methods(calls: Captured[]): string[] {
  return calls.map((c) => c.body.method as string);
}

function schemaOf(tool: ToolDef): Record<string, any> {
  return tool.inputSchema as Record<string, any>;
}

function hasAuthHeader(call: Captured): boolean {
  return Object.keys(call.headers).some(
    (k) => k.toLowerCase() === "authorization",
  );
}

describe("registration integrity (captured surface)", () => {
  it("serves exactly the fixture's 12 tools, deep-equal, in order", (t) => {
    if (skipWithoutFixture(t)) return;
    assert.equal(fixture.tools.length, 12);
    assert.deepEqual(TOOL_DEFS, fixture.tools);
  });

  it("serves the 12 tool names in fixture order", () => {
    assert.deepEqual(TOOL_NAMES, ALL_TOOLS);
  });

  it("carries exactly the fixture's keys on every tool (title included)", () => {
    for (const tool of TOOL_DEFS) {
      assert.deepEqual(Object.keys(tool).sort(), [
        "description",
        "inputSchema",
        "name",
        "title",
      ]);
    }
  });

  it("carries the fixture's titles verbatim", (t) => {
    if (skipWithoutFixture(t)) return;
    for (let i = 0; i < TOOL_DEFS.length; i++) {
      assert.equal(TOOL_DEFS[i].title, fixture.tools[i].title);
    }
    assert.equal(TOOL_DEFS[0].title, "Search DayZ items");
    assert.equal(TOOL_DEFS[11].title, "Find the right DZPage tool");
  });

  it("carries the fixture's descriptions verbatim", (t) => {
    if (skipWithoutFixture(t)) return;
    for (let i = 0; i < TOOL_DEFS.length; i++) {
      assert.equal(TOOL_DEFS[i].description, fixture.tools[i].description);
    }
  });

  it("the four tools with NO required key carry none, exactly as captured", () => {
    for (const name of NO_REQUIRED) {
      const tool = TOOL_DEFS.find((t) => t.name === name)!;
      assert.equal("required" in schemaOf(tool), false, name);
    }
  });

  it("the eight remaining tools carry exactly their captured required lists", () => {
    for (const [name, required] of Object.entries(REQUIRED)) {
      const tool = TOOL_DEFS.find((t) => t.name === name)!;
      assert.deepEqual(schemaOf(tool).required, required, name);
    }
    assert.equal(Object.keys(REQUIRED).length + NO_REQUIRED.length, 12);
  });

  it("carries object type and the captured $schema on every inputSchema, and no additionalProperties marker", () => {
    for (const tool of TOOL_DEFS) {
      assert.equal(schemaOf(tool).type, "object");
      assert.equal(
        schemaOf(tool)["$schema"],
        "https://json-schema.org/draft/2020-12/schema",
      );
      assert.equal("additionalProperties" in schemaOf(tool), false);
    }
  });

  it("carries every fixture property, in order, for every tool", (t) => {
    if (skipWithoutFixture(t)) return;
    for (let i = 0; i < TOOL_DEFS.length; i++) {
      assert.deepEqual(
        Object.keys(schemaOf(TOOL_DEFS[i]).properties),
        Object.keys(schemaOf(fixture.tools[i]).properties),
      );
    }
    assert.deepEqual(Object.keys(schemaOf(TOOL_DEFS[0]).properties), [
      "query", "category", "tier", "sort", "include_mods", "page", "limit", "lang",
    ]);
    assert.deepEqual(Object.keys(schemaOf(TOOL_DEFS[1]).properties), ["class_name", "lang"]);
    assert.deepEqual(Object.keys(schemaOf(TOOL_DEFS[2]).properties), ["item", "map", "limit", "lang"]);
    assert.deepEqual(Object.keys(schemaOf(TOOL_DEFS[3]).properties), ["weapons", "distances_m", "vest", "lang"]);
    assert.deepEqual(Object.keys(schemaOf(TOOL_DEFS[4]).properties), ["query", "map", "lang"]);
    assert.deepEqual(Object.keys(schemaOf(TOOL_DEFS[5]).properties), [
      "query", "platform", "map", "tags", "region", "perspective", "only_online",
      "min_players", "free_slots", "no_password", "sort", "page", "lang",
    ]);
    assert.deepEqual(Object.keys(schemaOf(TOOL_DEFS[6]).properties), ["version", "item", "map", "lang"]);
    assert.deepEqual(Object.keys(schemaOf(TOOL_DEFS[7]).properties), ["map", "day_minutes", "night_minutes", "date", "lang"]);
    assert.deepEqual(Object.keys(schemaOf(TOOL_DEFS[8]).properties), ["setting", "map", "lang"]);
    assert.deepEqual(Object.keys(schemaOf(TOOL_DEFS[9]).properties), ["content", "file_name", "lang"]);
    assert.deepEqual(Object.keys(schemaOf(TOOL_DEFS[10]).properties), ["log", "file_name", "lang"]);
    assert.deepEqual(Object.keys(schemaOf(TOOL_DEFS[11]).properties), ["task", "lang"]);
  });

  it("carries the captured property shapes across the surface", () => {
    const si = schemaOf(TOOL_DEFS[0]).properties;
    assert.equal(si.query.type, "string");
    assert.equal(si.query.maxLength, 100);
    assert.equal(si.query.description, "Name or class name, e.g. 'akm', 'Verband', 'bandage'");
    assert.equal(si.tier.description, "Only items that spawn in this loot tier");
    assert.deepEqual(si.tier.enum, ["Tier1", "Tier2", "Tier3", "Tier4", "Unique"]);
    assert.equal(si.include_mods.type, "boolean");
    assert.equal(si.include_mods.default, false);
    assert.equal(si.page.type, "integer");
    assert.equal(si.limit.default, 20);
    const gi = schemaOf(TOOL_DEFS[1]).properties;
    assert.equal(gi.class_name.description, "DayZ class name, e.g. AKM or Mag_AKM_30Rnd");
    assert.equal(gi.class_name.minLength, 1);
    const cw = schemaOf(TOOL_DEFS[3]).properties;
    assert.equal(cw.weapons.type, "array");
    assert.equal(cw.weapons.maxItems, 6);
    assert.equal(
      cw.weapons.description,
      "Weapon class names, e.g. ['AKM', 'M4A1']. Append ':<ammo class>' to pick non-default ammo, e.g. 'AKM:Ammo_762x39Tracer'",
    );
    assert.deepEqual(cw.distances_m.default, [10, 100, 300]);
    const ss = schemaOf(TOOL_DEFS[5]).properties;
    assert.equal(ss.only_online.default, true);
    assert.equal(
      ss.sort.description,
      "players, best (votes), free (slots), newest or name; consoles support best, newest and name",
    );
    const dn = schemaOf(TOOL_DEFS[7]).properties;
    assert.equal(dn.day_minutes.type, "number");
    assert.equal(dn.night_minutes.maximum, 1440);
    assert.equal(dn.date.pattern, "^(0?[1-9]|1[0-2])-(0?[1-9]|[12]\\d|3[01])$");
    const ft = schemaOf(TOOL_DEFS[11]).properties;
    assert.equal(ft.task.default, "");
    assert.equal(ft.task.description, "What the user wants to do, in any of the site languages");
    assert.equal(schemaOf(TOOL_DEFS[9]).properties.content.maxLength, 500000);
    assert.equal(schemaOf(TOOL_DEFS[10]).properties.log.minLength, 1);
  });

  it("isKnownTool recognises all 12 built tools and rejects others", () => {
    for (const name of ALL_TOOLS) assert.equal(isKnownTool(name), true);
    assert.equal(isKnownTool("run_tool"), false);
    assert.equal(isKnownTool("search"), false);
    assert.equal(isKnownTool(""), false);
  });
});

describe("session establishment and reuse", () => {
  it("runs initialize, notifications/initialized, then tools/call in order", async () => {
    const { client: c, calls } = stubClient();
    const out = await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.equal(out.isError, undefined);
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    assert.ok(calls.every((call) => call.url === DEFAULT_ENDPOINT_URL));
    assert.equal(DEFAULT_ENDPOINT_URL, "https://dzpage.com/mcp");
    for (const call of calls) {
      assert.equal(call.headers["Content-Type"], "application/json");
      assert.equal(call.headers["Accept"], "application/json, text/event-stream");
    }
    assert.equal(calls[0].headers["Mcp-Session-Id"], undefined);
    assert.equal(calls[1].headers["Mcp-Session-Id"], "sess-dz1");
    assert.equal(calls[2].headers["Mcp-Session-Id"], "sess-dz1");
  });

  it("sends clientInfo name lootatlas and the pinned protocol version on initialize", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(PRIMARY, SAMPLE_ARGS);
    const initParams = calls[0].body.params as Record<string, unknown>;
    assert.equal(initParams.protocolVersion, PROTOCOL_VERSION);
    assert.equal(PROTOCOL_VERSION, "2025-03-26");
    assert.deepEqual(initParams.capabilities, {});
    assert.deepEqual(initParams.clientInfo, { name: "lootatlas", version: VERSION });
  });

  it("establishes the session lazily once and reuses it on later calls", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(PRIMARY, SAMPLE_ARGS);
    await c.callTool("find_tool", {});
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
      "tools/call",
    ]);
    assert.equal(calls[3].headers["Mcp-Session-Id"], "sess-dz1");
    assert.notEqual(calls[2].body.id, calls[3].body.id);
  });

  it("sends no session header when the upstream issues none", async () => {
    const { client: c, calls } = stubClient({ sessionId: null });
    const out = await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.equal(out.isError, undefined);
    assert.ok(calls.every((call) => call.headers["Mcp-Session-Id"] === undefined));
  });

  it("honours the DZPAGE_MCP_URL env override", async () => {
    const upstream = makeUpstream();
    const c = new LootatlasClient({
      fetchFn: upstream.fetchFn,
      env: { DZPAGE_MCP_URL: "https://staging.example.com/mcp" },
    });
    await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.ok(
      upstream.calls.every((call) => call.url === "https://staging.example.com/mcp"),
    );
  });

  it("honours an explicit url override over the default endpoint", async () => {
    const upstream = makeUpstream();
    const c = createClient({
      fetchFn: upstream.fetchFn,
      env: {},
      url: "https://alt.example.com/mcp",
    });
    await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.ok(upstream.calls.every((call) => call.url === "https://alt.example.com/mcp"));
  });

  it("prefers an explicit url override over the env override", async () => {
    const upstream = makeUpstream();
    const c = createClient({
      fetchFn: upstream.fetchFn,
      env: { DZPAGE_MCP_URL: "https://env.example.com/mcp" },
      url: "https://explicit.example.com/mcp",
    });
    await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.ok(
      upstream.calls.every((call) => call.url === "https://explicit.example.com/mcp"),
    );
  });

  it("falls back to the pinned endpoint when the env override is blank", async () => {
    const upstream = makeUpstream();
    const c = new LootatlasClient({
      fetchFn: upstream.fetchFn,
      env: { DZPAGE_MCP_URL: "   " },
    });
    await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.ok(upstream.calls.every((call) => call.url === DEFAULT_ENDPOINT_URL));
  });
});

describe("no Authorization header is ever sent (record declares no headers)", () => {
  it("sends no Authorization header with an empty environment", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.equal(calls.length, 3);
    assert.ok(calls.every((call) => !hasAuthHeader(call)));
    assert.ok(calls.every((call) => call.headers["Authorization"] === undefined));
  });

  it("sends no Authorization header even when key-like env vars are set", async () => {
    const upstream = makeUpstream();
    const c = new LootatlasClient({
      fetchFn: upstream.fetchFn,
      env: {
        DZPAGE_API_KEY: "should-never-be-sent",
        API_KEY: "also-ignored",
        AUTHORIZATION: "Bearer planted",
      },
    });
    await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.equal(upstream.calls.length, 3);
    assert.ok(upstream.calls.every((call) => !hasAuthHeader(call)));
  });

  it("never sends an X-API-Key header either", async () => {
    const upstream = makeUpstream();
    const c = new LootatlasClient({
      fetchFn: upstream.fetchFn,
      env: { DZPAGE_API_KEY: "should-never-be-sent" },
    });
    await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.ok(upstream.calls.every((call) => call.headers["X-API-Key"] === undefined));
  });

  it("sends only Content-Type, Accept and (when issued) Mcp-Session-Id headers", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.deepEqual(Object.keys(calls[0].headers).sort(), ["Accept", "Content-Type"]);
    assert.deepEqual(Object.keys(calls[2].headers).sort(), [
      "Accept",
      "Content-Type",
      "Mcp-Session-Id",
    ]);
  });
});

describe("tools/call forwarding", () => {
  it("forwards a search_items call verbatim", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(PRIMARY, SAMPLE_ARGS);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, PRIMARY);
    assert.deepEqual(params.arguments, SAMPLE_ARGS);
  });

  it("forwards every one of the 12 tools under its own name with arguments untouched", async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["search_items", { query: "akm", tier: "Tier3", limit: 5 }],
      ["get_item", { class_name: "AKM" }],
      ["where_to_find_item", { item: "AKM", map: "livonia" }],
      ["compare_weapons", { weapons: ["AKM", "M4A1"], distances_m: [10, 100] }],
      ["get_infected", { query: "soldier" }],
      ["search_servers", { platform: "ps", tags: ["pvp", "vanilla"] }],
      ["dayz_update_changes", { version: "1.29" }],
      ["day_night_settings", { day_minutes: 120, night_minutes: 30 }],
      ["explain_server_setting", { setting: "LootDamageMax" }],
      ["validate_config_file", { content: "<types></types>", file_name: "types.xml" }],
      ["analyze_server_log", { log: "SCRIPT ERROR somewhere" }],
      ["find_tool", { task: "shorter nights" }],
    ];
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    for (const [name, args] of cases) {
      await c.callTool(name, args);
    }
    const callParams = upstream.calls
      .filter((call) => call.body.method === "tools/call")
      .map((call) => call.body.params as Record<string, unknown>);
    assert.equal(callParams.length, 12);
    assert.deepEqual(callParams.map((p) => p.name), cases.map(([n]) => n));
    for (let i = 0; i < cases.length; i++) {
      assert.deepEqual(callParams[i].arguments, cases[i][1], cases[i][0]);
    }
  });

  it("passes the upstream result through verbatim, including structuredContent and extra fields", async () => {
    const upstreamResult = {
      ...SAMPLE_RESULT,
      vendorExtra: { nested: [1, 2, 3] },
    };
    const { client: c } = stubClient({ callResult: upstreamResult });
    const out = await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.deepEqual(out, upstreamResult);
    assert.deepEqual(
      (out as Record<string, unknown>).structuredContent,
      { class_name: "AKM", weight: 2500 },
    );
  });

  it("passes the default upstream result through verbatim", async () => {
    const { client: c } = stubClient();
    const out = await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.deepEqual(out, SAMPLE_RESULT);
  });

  it("passes an upstream isError result through untouched", async () => {
    const upstreamResult = {
      content: [{ type: "text", text: "no such item" }],
      isError: true,
    };
    const { client: c } = stubClient({ callResult: upstreamResult });
    const out = await c.callTool("get_item", { class_name: "Nope" });
    assert.deepEqual(out, upstreamResult);
  });

  it("reads an SSE-framed tools/call response", async () => {
    const { client: c } = stubClient({ sse: true });
    const out = await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.equal(out.isError, undefined);
    assert.deepEqual(out, SAMPLE_RESULT);
  });

  it("the one-shot callTool helper forwards under the right tool name", async () => {
    const upstream = makeUpstream();
    const out = await callTool(
      "find_tool",
      { task: "more loot" },
      { fetchFn: upstream.fetchFn, env: {} },
    );
    assert.equal(out.isError, undefined);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, "find_tool");
    assert.deepEqual(params.arguments, { task: "more loot" });
  });
});

describe("upstream failures surface as lootatlas error text", () => {
  it("maps a JSON-RPC error to `lootatlas error: <message>`", async () => {
    const { client: c } = stubClient({
      callError: { code: -32000, message: "item lookup failed upstream" },
    });
    const out = await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "lootatlas error: item lookup failed upstream");
  });

  it("maps an initialize JSON-RPC error to lootatlas error text", async () => {
    const { client: c } = stubClient({
      initError: { code: -32600, message: "bad initialize" },
    });
    const out = await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "lootatlas error: bad initialize");
  });

  it("maps an unparseable upstream response to a malformed-response error", async () => {
    const { client: c } = stubClient({ callBodyText: "<html>oops</html>" });
    const out = await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "lootatlas error: malformed response");
  });

  it("maps a response with no result object to a malformed-response error", async () => {
    const { client: c } = stubClient({
      callBodyText: '{"jsonrpc":"2.0","id":3,"result":null}',
    });
    const out = await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "lootatlas error: malformed response");
  });

  it("maps a non-2xx upstream status to lootatlas error text", async () => {
    const { client: c } = stubClient({ callBodyText: "internal error", callStatus: 500 });
    const out = await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "lootatlas error: HTTP 500");
  });

  it("maps a throwing fetch to lootatlas error text", async () => {
    const { client: c } = stubClient({ throwOn: "tools/call" });
    const out = await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^lootatlas error: /);
  });

  it("maps a throwing initialize fetch to lootatlas error text", async () => {
    const { client: c } = stubClient({ throwOn: "initialize" });
    const out = await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "lootatlas error: socket hang up");
  });

  it("maps a timed-out call to lootatlas error text", async () => {
    const { client: c } = stubClient({ hangOnCall: true }, { timeoutMs: 20 });
    const out = await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^lootatlas error: /);
  });
});

describe("parseRpcBody", () => {
  it("parses plain JSON and picks the message with the matching id", () => {
    const body = '{"jsonrpc":"2.0","id":7,"result":{"ok":true}}';
    assert.deepEqual(parseRpcBody(body, 7), {
      jsonrpc: "2.0",
      id: 7,
      result: { ok: true },
    });
  });

  it("parses SSE data lines", () => {
    const body =
      'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n';
    assert.deepEqual(parseRpcBody(body, 2), {
      jsonrpc: "2.0",
      id: 2,
      result: { ok: true },
    });
  });

  it("picks the matching id among several SSE messages", () => {
    const body =
      'data: {"jsonrpc":"2.0","id":1,"result":{"n":1}}\n\n' +
      'data: {"jsonrpc":"2.0","id":2,"result":{"n":2}}\n\n';
    assert.deepEqual(parseRpcBody(body, 2), {
      jsonrpc: "2.0",
      id: 2,
      result: { n: 2 },
    });
  });

  it("ignores the SSE [DONE] sentinel", () => {
    const body =
      'data: {"jsonrpc":"2.0","id":4,"result":{"ok":true}}\ndata: [DONE]\n';
    assert.deepEqual(parseRpcBody(body, 4), {
      jsonrpc: "2.0",
      id: 4,
      result: { ok: true },
    });
  });

  it("returns null for empty and unparseable bodies", () => {
    assert.equal(parseRpcBody(""), null);
    assert.equal(parseRpcBody("not json at all"), null);
    assert.equal(parseRpcBody("[1,2,3]"), null);
  });
});

describe("MCP layer validation", () => {
  it("rejects an unknown tool with MethodNotFound before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, "not_a_tool", {}),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.MethodNotFound,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("rejects the omitted-sibling name run_tool with MethodNotFound", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, "run_tool", {}),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.MethodNotFound,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("rejects array arguments with InvalidParams before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, PRIMARY, ["nope"]),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.InvalidParams,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("rejects string arguments with InvalidParams before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, PRIMARY, "query=akm"),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.InvalidParams,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("forwards a valid search_items call through the MCP layer unchanged", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, PRIMARY, SAMPLE_ARGS);
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.deepEqual(params.arguments, SAMPLE_ARGS);
  });

  it("treats omitted arguments as an empty object", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, "find_tool", undefined);
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.deepEqual(params.arguments, {});
  });
});

describe("CLI", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

  function runCli(args: string[]) {
    return spawnSync(process.execPath, ["--import", "tsx", cliPath, ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 30000,
    });
  }

  it("--version prints 0.1.0 and exits 0", () => {
    const res = runCli(["--version"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "0.1.0");
    assert.equal(res.stdout.trim(), VERSION);
  });

  it("-v prints 0.1.0 and exits 0", () => {
    const res = runCli(["-v"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "0.1.0");
  });

  it("an unknown command prints usage on stderr and exits 2", () => {
    const res = runCli(["not-a-tool"]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage:/);
    assert.match(res.stderr, /search_items/);
    assert.match(res.stderr, /find_tool/);
  });

  it("the usage text lists all 12 tool subcommands", () => {
    const res = runCli(["not-a-tool"]);
    assert.equal(res.status, 2);
    for (const name of ALL_TOOLS) {
      assert.ok(res.stderr.includes(name), `usage missing ${name}`);
    }
  });

  it("a non-JSON argument exits 2", () => {
    const res = runCli([PRIMARY, "not json"]);
    assert.equal(res.status, 2);
  });

  it("a JSON array argument exits 2", () => {
    const res = runCli([PRIMARY, "[]"]);
    assert.equal(res.status, 2);
  });

  it("extra arguments after mcp exit 2", () => {
    const res = runCli(["mcp", "extra"]);
    assert.equal(res.status, 2);
  });

  it("every tool name is accepted as a CLI subcommand (reaches argument parsing)", () => {
    for (const name of ALL_TOOLS) {
      const res = runCli([name, "not json"]);
      assert.equal(res.status, 2, name);
      assert.match(res.stderr, /argument must be a JSON object string/, name);
    }
  });

  it("a tool subcommand forwards to the upstream and prints the result", async () => {
    const server = createHttpServer((req, res) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => {
        const body = JSON.parse(data || "{}") as Record<string, unknown>;
        if (body.method === "initialize") {
          res.writeHead(200, { "Content-Type": "application/json", "mcp-session-id": "sess-cli" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, serverInfo: { name: "dzpage", version: "1.6.0" } } }));
        } else if (body.method === "notifications/initialized") {
          res.writeHead(202);
          res.end("");
        } else if (body.method === "tools/call") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: SAMPLE_RESULT }));
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("{}");
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as { port: number };
    try {
      const out = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", cliPath, "get_item", JSON.stringify({ class_name: "AKM" })], {
          cwd: root,
          env: { ...process.env, DZPAGE_MCP_URL: `http://127.0.0.1:${addr.port}/mcp` },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout, stderr }));
      });
      assert.equal(out.code, 0, out.stderr);
      assert.match(out.stdout, /AKM/);
    } finally {
      server.close();
    }
  });
});
