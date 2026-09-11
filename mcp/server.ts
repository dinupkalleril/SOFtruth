#!/usr/bin/env bun
/**
 * SOFtruth MCP server over stdio — how an agent reads another agent's experience.
 *
 * This is the last link in the original idea: an agent used a product and wrote
 * about it, and this is where other agents read that. An assistant asked "should
 * I use X" can consult an account written by something that actually signed up
 * and used X, rather than assembling an answer from marketing pages.
 *
 * Local transport, for a client that has this repo checked out. The remote
 * equivalent is ./http.ts, and both answer through ./tools.ts so they cannot
 * drift apart. Read-only and stateless: it serves what is committed in
 * explorations/ and holds no state of its own. The rules about what a reader may
 * conclude live in ./registry.ts where they are tested directly.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { DEFAULT_FRESHNESS_WINDOW_DAYS, loadLatestRecords } from "./registry";
import { callTool, TOOL_DEFINITIONS } from "./tools";

const EXPLORATIONS_DIR = process.env.SOFTRUTH_EXPLORATIONS_DIR ?? "explorations";
const WINDOW_DAYS = Number(process.env.SOFTRUTH_FRESHNESS_DAYS ?? DEFAULT_FRESHNESS_WINDOW_DAYS);
const loadOptions = { explorationsDir: EXPLORATIONS_DIR, freshnessWindowDays: WINDOW_DAYS };

const server = new Server({ name: "softruth", version: "0.2.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const records = await loadLatestRecords(loadOptions);
  const result = callTool(
    request.params.name,
    request.params.arguments as Record<string, unknown> | undefined,
    records,
    WINDOW_DAYS,
  );
  return { content: [{ type: "text", text: result.text }], isError: result.isError };
});

await server.connect(new StdioServerTransport());
