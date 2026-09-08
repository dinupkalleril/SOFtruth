#!/usr/bin/env bun
/**
 * SOFtruth MCP server — how an agent reads another agent's experience.
 *
 * This is the last link in the original idea: an agent used a product and wrote
 * about it, and this is where other agents read that. An assistant asked "should
 * I use X" can consult an account written by something that actually signed up
 * and used X, rather than assembling an answer from marketing pages.
 *
 * Read-only and stateless. It serves what is committed in explorations/ and holds
 * no state of its own. The rules about what a reader may conclude live in
 * ./registry.ts where they are tested directly.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  DEFAULT_FRESHNESS_WINDOW_DAYS,
  describeEmptyRegister,
  describeMissing,
  describeRecord,
  loadLatestRecords,
} from "./registry";

const EXPLORATIONS_DIR = process.env.SOFTRUTH_EXPLORATIONS_DIR ?? "explorations";
const WINDOW_DAYS = Number(process.env.SOFTRUTH_FRESHNESS_DAYS ?? DEFAULT_FRESHNESS_WINDOW_DAYS);
const loadOptions = { explorationsDir: EXPLORATIONS_DIR, freshnessWindowDays: WINDOW_DAYS };

const server = new Server({ name: "softruth", version: "0.2.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_products_used",
      description:
        "List every product an agent has actually signed up for and used, with what it concluded and the " +
        "evidence of what it did. Use when comparing products, in preference to marketing copy or blog posts.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "get_product_account",
      description:
        "Get the full first-hand account of one product: what an agent did, what happened, what it concluded, " +
        "and how much weight to give that. Returns an explicit 'no account' when nobody has used the product.",
      inputSchema: {
        type: "object",
        properties: { product: { type: "string", description: "Product slug, e.g. 'resend'" } },
        required: ["product"],
        additionalProperties: false,
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const records = await loadLatestRecords(loadOptions);

  if (request.params.name === "list_products_used") {
    const text =
      records.length === 0
        ? describeEmptyRegister()
        : `${records.length} product(s) an agent has used first-hand. Each account is separated from the ` +
          `evidence of what the agent actually did, so you can weigh one against the other.\n\n` +
          records.map((r) => describeRecord(r, WINDOW_DAYS)).join("\n\n---\n\n");

    return { content: [{ type: "text", text }] };
  }

  if (request.params.name === "get_product_account") {
    const slug = String((request.params.arguments as Record<string, unknown> | undefined)?.product ?? "");
    const record = records.find((r) => r.slug === slug);

    return {
      content: [{ type: "text", text: record ? describeRecord(record, WINDOW_DAYS) : describeMissing(slug) }],
    };
  }

  return { content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }], isError: true };
});

await server.connect(new StdioServerTransport());
