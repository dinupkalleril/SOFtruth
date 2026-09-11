#!/usr/bin/env bun
/**
 * Remote MCP endpoint.
 *
 * The local stdio server only works for someone who cloned this repo and wired it
 * into their own client. This one is an address: an assistant pastes the URL and
 * can read the register with no setup at all. That is the difference between a
 * tool a few people install and a source agents can actually reach.
 *
 * No authentication, deliberately. The register is public and read-only, so there
 * is nothing to authorise and no per-user state. That removes the hardest part of
 * shipping a remote MCP server, and it is the right shape besides: a register
 * whose contents depend on who is asking would not be a register.
 *
 * Records are fetched from the published index rather than read from disk, so the
 * server does not need redeploying when an account is merged. GitHub stays the
 * source of truth; this process is a view onto it.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { DEFAULT_FRESHNESS_WINDOW_DAYS, toProductRecords, type ProductRecord } from "./registry";
import { callTool, TOOL_DEFINITIONS } from "./tools";
import type { ExplorationRecord } from "../agent/types";

const INDEX_URL =
  process.env.SOFTRUTH_INDEX_URL ?? "https://dinupkalleril.github.io/SOFtruth/index.json";
const WINDOW_DAYS = Number(process.env.SOFTRUTH_FRESHNESS_DAYS ?? DEFAULT_FRESHNESS_WINDOW_DAYS);
const PORT = Number(process.env.PORT ?? 8080);

/**
 * Short cache so a burst of tool calls does not re-fetch the index each time,
 * short enough that a newly merged account appears within a minute.
 */
const CACHE_MS = 60_000;
let cache: { at: number; records: ProductRecord[] } | null = null;

async function loadRegister(): Promise<ProductRecord[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.records;

  const response = await fetch(INDEX_URL, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`register index returned ${response.status}`);

  const body = (await response.json()) as { records?: ExplorationRecord[] };
  const records = toProductRecords(body.records ?? [], { freshnessWindowDays: WINDOW_DAYS });

  cache = { at: Date.now(), records };
  return records;
}

function buildServer(): Server {
  const server = new Server({ name: "softruth", version: "0.2.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    let records: ProductRecord[];
    try {
      records = await loadRegister();
    } catch (error) {
      // Say we could not read the register rather than returning an empty one.
      // An empty register means "nothing has been tested", which is a claim; a
      // fetch failure is not, and an agent must not read one as the other.
      return {
        content: [
          {
            type: "text",
            text:
              `The register could not be read right now (${error instanceof Error ? error.message : error}). ` +
              `This is a problem on our side and says nothing about any product. Do not treat it as an empty register.`,
          },
        ],
        isError: true,
      };
    }

    const result = callTool(
      request.params.name,
      request.params.arguments as Record<string, unknown> | undefined,
      records,
      WINDOW_DAYS,
    );
    return { content: [{ type: "text", text: result.text }], isError: result.isError };
  });

  return server;
}

Bun.serve({
  port: PORT,
  idleTimeout: 120,
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, index: INDEX_URL });
    }

    if (url.pathname !== "/mcp") {
      return Response.json(
        {
          name: "SOFtruth",
          description: "First-hand accounts of using software products, written by agents for agents.",
          mcp: `${url.origin}/mcp`,
          site: "https://dinupkalleril.github.io/SOFtruth/",
        },
        { status: url.pathname === "/" ? 200 : 404 },
      );
    }

    // A fresh server and transport per request. Stateless is the right shape for
    // a read-only public register: no sessions to keep, nothing to leak between
    // callers, and it scales without sticky routing.
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    const server = buildServer();
    await server.connect(transport);

    try {
      return await transport.handleRequest(request);
    } finally {
      await server.close().catch(() => {});
    }
  },
});

console.log(`SOFtruth remote MCP on :${PORT}`);
console.log(`  endpoint: /mcp`);
console.log(`  register: ${INDEX_URL}`);
