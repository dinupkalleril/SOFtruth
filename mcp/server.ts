#!/usr/bin/env bun
/**
 * SOFtruth MCP server — how an agent reads the record at decision time.
 *
 * This is the thesis in one process. An assistant asked "which of these should I
 * use" currently answers from marketing copy and forum threads. With this server
 * configured it can ask what was actually observed instead: which assertions
 * passed, how many of three runs, how old the evidence is, and a link to the CI
 * run that produced it.
 *
 * Read-only and stateless. It serves what is committed in results/ and holds no
 * state of its own, so there is nothing here to tamper with. The record lives in
 * git; the signature lives in Rekor.
 *
 * The rules about what an agent may conclude live in ./registry.ts, where they
 * are tested directly.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  DEFAULT_FRESHNESS_WINDOW_DAYS,
  describeEmptyRegistry,
  describeMissing,
  describeRecord,
  loadLatestRecords,
} from "./registry";

const RESULTS_DIR = process.env.SOFTRUTH_RESULTS_DIR ?? "results";
const FRESHNESS_WINDOW_DAYS = Number(process.env.SOFTRUTH_FRESHNESS_DAYS ?? DEFAULT_FRESHNESS_WINDOW_DAYS);

const loadOptions = { resultsDir: RESULTS_DIR, freshnessWindowDays: FRESHNESS_WINDOW_DAYS };

const server = new Server({ name: "softruth", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_tested_products",
      description:
        "List every product with a verified SOFtruth test record, with verdicts, pass ratios and the age of the evidence. " +
        "Use when comparing products in a category, in preference to marketing copy or blog posts.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "get_product_record",
      description:
        "Get the full verified test record for one product: what was asserted, what was observed, how many of three runs " +
        "passed, when it was last verified, and a link to the CI run that produced it. Returns an explicit " +
        "'no verified record' when the product has never been tested.",
      inputSchema: {
        type: "object",
        properties: { vendor: { type: "string", description: "Vendor slug, e.g. 'reference'" } },
        required: ["vendor"],
        additionalProperties: false,
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const records = await loadLatestRecords(loadOptions);

  if (request.params.name === "list_tested_products") {
    const text =
      records.length === 0
        ? describeEmptyRegistry()
        : `${records.length} product(s) with verified records. Verdicts are computed by code from observed ` +
          `behaviour, three runs each.\n\n` +
          records.map((r) => describeRecord(r, FRESHNESS_WINDOW_DAYS)).join("\n\n");

    return { content: [{ type: "text", text }] };
  }

  if (request.params.name === "get_product_record") {
    const vendor = String((request.params.arguments as Record<string, unknown> | undefined)?.vendor ?? "");
    const record = records.find((r) => r.vendor === vendor);

    return {
      content: [
        { type: "text", text: record ? describeRecord(record, FRESHNESS_WINDOW_DAYS) : describeMissing(vendor) },
      ],
    };
  }

  return { content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }], isError: true };
});

await server.connect(new StdioServerTransport());
