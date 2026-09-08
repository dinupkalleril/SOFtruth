import { afterEach, describe, expect, test } from "bun:test";
import { AnthropicBrain, OpenAIBrain, selectBrain } from "./llm";

const saved = { ...process.env };
afterEach(() => {
  for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "SOFTRUTH_AGENT_PROVIDER", "SOFTRUTH_AGENT_MODEL"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function clear() {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.SOFTRUTH_AGENT_PROVIDER;
  delete process.env.SOFTRUTH_AGENT_MODEL;
}

describe("selectBrain", () => {
  test("uses whichever key is present when no provider is named", () => {
    clear();
    process.env.OPENAI_API_KEY = "sk-test";
    expect(selectBrain()).toBeInstanceOf(OpenAIBrain);
  });

  test("an explicit provider wins over key presence", () => {
    // Otherwise having both keys makes the choice implicit, and the account
    // would carry a byline the operator did not intend.
    clear();
    process.env.ANTHROPIC_API_KEY = "sk-ant";
    process.env.OPENAI_API_KEY = "sk-oai";
    process.env.SOFTRUTH_AGENT_PROVIDER = "openai";
    expect(selectBrain()).toBeInstanceOf(OpenAIBrain);
  });

  test("refuses to run with no credentials rather than failing later", () => {
    clear();
    expect(() => selectBrain()).toThrow(/No LLM credentials/);
  });

  test("an explicitly named provider with no key fails loudly, never silently falls back", () => {
    // A fallback would produce an account from a different model than the one
    // about to be recorded as its author.
    clear();
    process.env.ANTHROPIC_API_KEY = "sk-ant";
    process.env.SOFTRUTH_AGENT_PROVIDER = "openai";
    expect(() => selectBrain()).toThrow(/OPENAI_API_KEY/);
  });

  test("model can be overridden and is what gets recorded as the byline", () => {
    clear();
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.SOFTRUTH_AGENT_MODEL = "gpt-5-mini";
    expect(selectBrain().model).toBe("gpt-5-mini");
  });

  test("each brain refuses construction without its own key", () => {
    expect(() => new AnthropicBrain("m", undefined)).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => new OpenAIBrain("m", undefined)).toThrow(/OPENAI_API_KEY/);
  });
});
