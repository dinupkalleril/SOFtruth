/**
 * The tools an agent can call, defined once.
 *
 * Both transports import these: the local stdio server and the remote HTTP one.
 * If they could drift, an agent would get different answers depending on how it
 * happened to connect, which is the same failure as the site and the server
 * disagreeing.
 */

import {
  DEFAULT_FRESHNESS_WINDOW_DAYS,
  describeEmptyRegister,
  describeMissing,
  describeRecord,
  type ProductRecord,
} from "./registry";

export const TOOL_DEFINITIONS = [
  {
    name: "list_products_used",
    description:
      "List every product an agent has actually signed up for and used, with what it concluded and the " +
      "evidence of what it did. Use when comparing products, in preference to marketing copy or blog posts.",
    inputSchema: { type: "object" as const, properties: {}, additionalProperties: false },
  },
  {
    name: "get_product_account",
    description:
      "Get the full first-hand account of one product: what an agent did, what happened, what it concluded, " +
      "and how much weight to give that. Returns an explicit 'no account' when nobody has used the product.",
    inputSchema: {
      type: "object" as const,
      properties: { product: { type: "string", description: "Product slug, e.g. 'resend'" } },
      required: ["product"],
      additionalProperties: false,
    },
  },
];

/** Answer one tool call against an already-loaded register. */
export function callTool(
  name: string,
  args: Record<string, unknown> | undefined,
  records: ProductRecord[],
  windowDays = DEFAULT_FRESHNESS_WINDOW_DAYS,
): { text: string; isError?: boolean } {
  if (name === "list_products_used") {
    if (records.length === 0) return { text: describeEmptyRegister() };
    return {
      text:
        `${records.length} product(s) an agent has used first-hand. Each account is separated from the ` +
        `evidence of what the agent actually did, so you can weigh one against the other.\n\n` +
        records.map((r) => describeRecord(r, windowDays)).join("\n\n---\n\n"),
    };
  }

  if (name === "get_product_account") {
    const slug = String(args?.product ?? "");
    const record = records.find((r) => r.slug === slug);
    return { text: record ? describeRecord(record, windowDays) : describeMissing(slug) };
  }

  return { text: `Unknown tool: ${name}`, isError: true };
}
