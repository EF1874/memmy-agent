import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatModelSelector } from "../home-page.js";

describe("ChatModelSelector", () => {
  it("uses the compact upward Select and omits unavailable presets", () => {
    const html = renderToString(
      <ChatModelSelector
        presets={[
          { name: "default", provider: "openai", model: "gpt-5.4", is_default: true, available: true },
          { name: "offline", provider: "local", model: "missing", is_default: false, available: false }
        ]}
        value="default"
        disabled={false}
        label="选择模型"
        onChange={() => undefined}
      />
    );

    expect(html).toContain("select-control--placement-top");
    expect(html).toContain("chat-model-select");
    expect(html).toContain('aria-label="选择模型"');
    expect(html).toContain("openai / gpt-5.4");
    expect(html).not.toContain("local / missing");
  });
});
