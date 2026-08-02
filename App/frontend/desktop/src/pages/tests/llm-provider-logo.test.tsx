import { describe, expect, it } from "vitest";
import { llmProviderLogoUrl } from "../llm-provider-logo.js";

describe("llmProviderLogoUrl", () => {
  it("maps only desktop-supported providers and their frontend aliases", () => {
    for (const provider of [
      "openai",
      "anthropic",
      "gemini",
      "deepseek",
      "zhipu",
      "qwen",
      "moonshot",
      "minimax",
      "baidu",
      "doubao",
      "memmy_account"
    ]) {
      expect(llmProviderLogoUrl(provider)).toMatch(/^data:image\/svg\+xml/);
    }

    expect(llmProviderLogoUrl("google")).toBe(llmProviderLogoUrl("gemini"));
    expect(llmProviderLogoUrl("kimi")).toBe(llmProviderLogoUrl("moonshot"));
    expect(llmProviderLogoUrl("openrouter")).toBeNull();
  });
});
