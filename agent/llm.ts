/**
 * The agent's reasoning, behind one small interface so the provider is a choice
 * rather than a dependency.
 *
 * Any model that can use tools can drive this. Which one did the driving is
 * recorded in every account, the way a review carries a byline, because two
 * models will not write the same account of the same product and a reader
 * deserves to know whose experience they are reading. Running the same product
 * through two providers is a feature, not a conflict: disagreement between them
 * is information about the product.
 */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

/** A tool the agent can call. Shape is provider-agnostic; adapters translate. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
}

/** One request from the agent to use a tool. */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** What the agent said this turn. */
export interface BrainTurn {
  /** Anything it said in prose. Usually empty when it is calling tools. */
  text: string;
  toolCalls: ToolCall[];
}

/**
 * A conversation the brain can continue.
 *
 * Kept deliberately simple: the agent loop appends turns and tool results, and
 * each adapter converts this into its provider's own message format. The loop
 * never touches a provider SDK type.
 */
export type Turn =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: ToolCall[] }
  | { role: "tool_results"; results: Array<{ id: string; output: string }> };

export interface Brain {
  /** Model identifier, recorded in the account as its byline. */
  readonly model: string;
  think(system: string, turns: Turn[], tools: ToolSpec[]): Promise<BrainTurn>;
}

/* ------------------------------------------------------------------ Anthropic */

export class AnthropicBrain implements Brain {
  private readonly client: Anthropic;

  constructor(
    readonly model = "claude-sonnet-5",
    apiKey = process.env.ANTHROPIC_API_KEY,
  ) {
    if (!apiKey) throw new Error("AnthropicBrain needs ANTHROPIC_API_KEY");
    this.client = new Anthropic({ apiKey });
  }

  async think(system: string, turns: Turn[], tools: ToolSpec[]): Promise<BrainTurn> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 2_000,
      system,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters as Anthropic.Tool.InputSchema,
      })),
      messages: turns.map(toAnthropicMessage),
    });

    return {
      text: response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n"),
      toolCalls: response.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
        .map((b) => ({ id: b.id, name: b.name, input: b.input as Record<string, unknown> })),
    };
  }
}

function toAnthropicMessage(turn: Turn): Anthropic.MessageParam {
  if (turn.role === "user") return { role: "user", content: turn.text };

  if (turn.role === "tool_results") {
    return {
      role: "user",
      content: turn.results.map((r) => ({
        type: "tool_result" as const,
        tool_use_id: r.id,
        content: r.output,
      })),
    };
  }

  const content: Anthropic.ContentBlockParam[] = [];
  if (turn.text) content.push({ type: "text", text: turn.text });
  for (const call of turn.toolCalls) {
    content.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });
  }
  return { role: "assistant", content };
}

/* --------------------------------------------------------------------- OpenAI */

export class OpenAIBrain implements Brain {
  private readonly client: OpenAI;

  constructor(
    readonly model = "gpt-5",
    apiKey = process.env.OPENAI_API_KEY,
  ) {
    if (!apiKey) throw new Error("OpenAIBrain needs OPENAI_API_KEY");
    this.client = new OpenAI({ apiKey });
  }

  async think(system: string, turns: Turn[], tools: ToolSpec[]): Promise<BrainTurn> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      max_completion_tokens: 2_000,
      messages: [
        { role: "system", content: system },
        ...turns.flatMap(toOpenAIMessages),
      ],
      tools: tools.map((t) => ({
        type: "function" as const,
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
    });

    const choice = response.choices[0]?.message;

    return {
      text: choice?.content ?? "",
      toolCalls: (choice?.tool_calls ?? []).flatMap((call) => {
        if (call.type !== "function") return [];
        return [
          {
            id: call.id,
            name: call.function.name,
            // A model can emit malformed JSON arguments. Surfacing that as an
            // empty input lets the tool report a useful error to the agent
            // rather than crashing the session.
            input: safeParse(call.function.arguments),
          },
        ];
      }),
    };
  }
}

function toOpenAIMessages(turn: Turn): OpenAI.Chat.ChatCompletionMessageParam[] {
  if (turn.role === "user") return [{ role: "user", content: turn.text }];

  if (turn.role === "tool_results") {
    return turn.results.map((r) => ({ role: "tool" as const, tool_call_id: r.id, content: r.output }));
  }

  return [
    {
      role: "assistant",
      content: turn.text || null,
      tool_calls: turn.toolCalls.map((c) => ({
        id: c.id,
        type: "function" as const,
        function: { name: c.name, arguments: JSON.stringify(c.input) },
      })),
    },
  ];
}

function safeParse(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/* ---------------------------------------------------------------- selection */

/**
 * Pick a brain from the environment.
 *
 * SOFTRUTH_AGENT_PROVIDER decides; otherwise whichever key is present wins, with
 * Anthropic first only because it is the default in the docs. There is no
 * fallback chain on failure: if the chosen provider cannot run, the session
 * should fail loudly rather than quietly produce an account from a different
 * model than the one about to be recorded as its author.
 */
export function selectBrain(): Brain {
  const provider = process.env.SOFTRUTH_AGENT_PROVIDER?.toLowerCase();
  const model = process.env.SOFTRUTH_AGENT_MODEL;

  if (provider === "openai") return new OpenAIBrain(model ?? "gpt-5");
  if (provider === "anthropic") return new AnthropicBrain(model ?? "claude-sonnet-5");

  if (process.env.ANTHROPIC_API_KEY) return new AnthropicBrain(model ?? "claude-sonnet-5");
  if (process.env.OPENAI_API_KEY) return new OpenAIBrain(model ?? "gpt-5");

  throw new Error(
    "No LLM credentials. Set ANTHROPIC_API_KEY or OPENAI_API_KEY, " +
      "or name one explicitly with SOFTRUTH_AGENT_PROVIDER.",
  );
}
