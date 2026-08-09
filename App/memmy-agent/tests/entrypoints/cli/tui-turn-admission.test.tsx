import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../../../src/entrypoints/cli/tui.tsx", import.meta.url),
  "utf8",
);

describe("Ink TUI Turn admission", () => {
  it("maps Enter to queue and Tab to steer", () => {
    expect(source).toContain('submit(inputRef.current, "queue");');
    expect(source).toContain('submit(inputRef.current, "steer");');
    expect(source).toContain("turnAdmission,");
  });

  it("keeps the composer active while the Session is busy", () => {
    expect(source).not.toContain("if (busy) return;");
    expect(source).toContain("Enter: queue next turn · Tab: add to current turn");
    expect(source).toMatch(/<ComposerInput\s+active\s/);
  });

  it("keeps busy until both the Session queue and inbound bus are empty", () => {
    expect(source).toContain("!loop.isSessionBusy(sessionId)");
    expect(source).toContain("(bus?.inboundSize ?? 0) === 0");
    expect(source).toContain("await settleWithTimeout([runPromise, outboundPromise], 1_500);");
  });
});
