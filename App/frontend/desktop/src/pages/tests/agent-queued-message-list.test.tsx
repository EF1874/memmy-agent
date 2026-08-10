// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentQueuedMessage } from "../../state/agent-chat-slice.js";
import { AgentQueuedMessageList } from "../agent-queued-message-list.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function queued(
  clientRequestId: string,
  content: string,
  status: AgentQueuedMessage["status"] = "queued",
  media: AgentQueuedMessage["media"] = [],
  source: AgentQueuedMessage["source"] = { kind: "gui", channel: "websocket" },
): AgentQueuedMessage {
  return { clientRequestId, content, status, media, queuedAt: Date.now(), source };
}

describe("AgentQueuedMessageList", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onRemove = vi.fn();

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  function render(items: AgentQueuedMessage[]): void {
    act(() => root.render(
      <AgentQueuedMessageList
        items={items}
        label="Queued questions"
        removeLabel="Remove"
        attachmentOnlyLabel={(count) => `${count} attachments`}
        sourceLabels={{
          gui: "From GUI",
          tui: "From TUI",
          im: (channel) => `From ${channel}`,
          unknownIm: "From IM"
        }}
        onRemove={onRemove}
      />
    ));
  }

  it("renders no empty panel and one remove action per queued row", () => {
    render([]);
    expect(container.querySelector(".agent-queue-panel")).toBeNull();

    render([
      queued("one", "第一条"),
      queued("two", "第二条", "removing", [], { kind: "tui", channel: "websocket" }),
      queued(
        "three",
        "",
        "queued",
        [{ url: "file://a", kind: "file" }, { url: "file://b", kind: "file" }],
        { kind: "im", channel: "slack" }
      )
    ]);
    const rows = [...container.querySelectorAll<HTMLLIElement>(".agent-queue-item")];
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.querySelectorAll("button").length)).toEqual([1, 1, 1]);
    expect(rows[2]?.querySelector(".agent-queue-item__text")?.textContent).toBe("2 attachments");
    expect(rows[1]?.querySelector("button")?.disabled).toBe(true);
    expect(rows[0]?.querySelector("button")?.getAttribute("aria-label")).toBe("Remove");
    const sources = rows.map((row) => row.querySelector<HTMLElement>(".agent-queue-item__source"));
    expect(sources.map((source) => source?.getAttribute("aria-label")))
      .toEqual(["From GUI", "From TUI", "From Slack"]);
    expect(sources.map((source) => source?.tabIndex)).toEqual([-1, -1, -1]);
    expect(rows[0]?.querySelector(".lucide-monitor")).not.toBeNull();
    expect(rows[1]?.querySelector(".lucide-square-terminal")).not.toBeNull();
    expect(rows[2]?.querySelector("img")?.getAttribute("src")).toContain("slack");

    act(() => rows[0]?.querySelector("button")?.click());
    expect(onRemove).toHaveBeenCalledWith("one");
  });

  it("falls back to MessageCircle for unknown or failed IM logos", () => {
    render([
      queued("unknown", "unknown", "queued", [], { kind: "im", channel: "unknown" }),
      queued("failed", "failed", "queued", [], { kind: "im", channel: "slack" })
    ]);
    const rows = [...container.querySelectorAll<HTMLLIElement>(".agent-queue-item")];
    expect(rows[0]?.querySelector(".lucide-message-circle")).not.toBeNull();
    expect(rows[0]?.querySelector(".agent-queue-item__source")?.getAttribute("aria-label")).toBe("From IM");
    const image = rows[1]?.querySelector<HTMLImageElement>("img");
    expect(image).not.toBeNull();
    act(() => image?.dispatchEvent(new Event("error")));
    expect(rows[1]?.querySelector(".lucide-message-circle")).not.toBeNull();
  });

  it("normalizes multiline display text and exposes a tooltip only for real overflow", () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("agent-queue-item__text") ? 100 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
      if (!this.classList.contains("agent-queue-item__text")) return 0;
      return (this.textContent?.length ?? 0) > 12 ? 240 : 80;
    });

    render([
      queued("short", "  short\ntext "),
      queued("long", "  this is a very\nlong queued question  ")
    ]);
    const texts = [...container.querySelectorAll<HTMLElement>(".agent-queue-item__text")];
    expect(texts.map((element) => element.textContent)).toEqual([
      "short text",
      "this is a very long queued question"
    ]);
    expect(texts[0]?.tabIndex).toBe(-1);
    expect(texts[0]?.getAttribute("aria-label")).toBeNull();
    expect(texts[1]?.tabIndex).toBe(0);
    expect(texts[1]?.getAttribute("aria-label")).toBe("this is a very long queued question");

    act(() => texts[1]?.focus());
    const tooltip = document.querySelector<HTMLElement>("#app-tooltip-singleton");
    expect(tooltip?.textContent).toBe("this is a very long queued question");
    expect(tooltip?.classList.contains("app-tooltip--hidden")).toBe(false);

    const source = container.querySelector<HTMLElement>(".agent-queue-item__source");
    act(() => source?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    expect(tooltip?.textContent).toBe("From GUI");
  });

  it("keeps FIFO DOM order and scrolls its own list when an item is appended", () => {
    render([queued("one", "one")]);
    const list = container.querySelector<HTMLOListElement>(".agent-queue-list")!;
    Object.defineProperties(list, {
      scrollHeight: { configurable: true, value: 400 },
      scrollTop: { configurable: true, value: 0, writable: true }
    });

    render([queued("one", "one"), queued("two", "two"), queued("three", "three")]);

    expect([...container.querySelectorAll(".agent-queue-item__text")].map((item) => item.textContent))
      .toEqual(["one", "two", "three"]);
    expect(list.scrollTop).toBe(400);
  });
});
