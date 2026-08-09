// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentGoalState, AgentGoalStatus } from "../../api/memmy-agent-client.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import {
  formatMessage,
  messageCatalogs,
  type MessageKey,
  type MessageValues,
  type ResolvedLanguage
} from "../../i18n/messages.js";
import {
  AgentGoalBar,
  displayedGoalTimeSeconds,
  formatCompactGoalTokenCount,
  formatGoalDuration,
  type AgentGoalBarProps
} from "../agent-goal-bar.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const GOAL_ID = "8f59f58a-7295-4c34-8e03-55e7035a5a8d";
const stylesSourcePath = resolve(__dirname, "..", "..", "styles.css");

function goal(status: AgentGoalStatus, overrides: Partial<AgentGoalState> = {}): AgentGoalState {
  return {
    goal_id: GOAL_ID,
    status,
    objective: "Implement and verify persistent Goal mode",
    token_budget: 20_000,
    tokens_used: 1_250,
    time_used_seconds: 42,
    created_at: "2026-08-04T08:00:00.000Z",
    updated_at: "2026-08-04T08:00:42.000Z",
    ...overrides
  };
}

describe("AgentGoalBar", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function render(props: Partial<AgentGoalBarProps> = {}, language = "en-US"): void {
    const resolved: AgentGoalBarProps = {
      chatId: "chat-a",
      goal: goal("active"),
      clock: null,
      pending: false,
      onControl: vi.fn(),
      ...props
    };
    act(() => root.render(
      <I18nProvider language={language}>
        <AgentGoalBar {...resolved} />
      </I18nProvider>
    ));
  }

  function translate(language: ResolvedLanguage) {
    return (key: MessageKey, values?: MessageValues) =>
      formatMessage(messageCatalogs[language][key], values);
  }

  function actionLabels(): string[] {
    return [...container.querySelectorAll<HTMLButtonElement>(".agent-goal-bar__icon-button")]
      .map((button) => button.getAttribute("aria-label") ?? "");
  }

  function click(label: string): void {
    const button = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((item) => item.getAttribute("aria-label") === label || item.textContent === label);
    expect(button, `button ${label}`).toBeTruthy();
    act(() => button!.click());
  }

  function inputValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    act(() => {
      const prototype = element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  function mockMarqueeWidths(viewportWidth: number, textWidth: number): void {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("agent-goal-bar__objective-viewport") ? viewportWidth : 0;
    });
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("agent-goal-bar__objective-text") ? textWidth : 0;
    });
  }

  it.each([
    ["active", ["Pause", "Budget", "Clear"]],
    ["paused", ["Resume", "Edit", "Budget", "Clear"]],
    ["blocked", ["Resume", "Edit", "Budget", "Clear"]],
    ["usage_limited", ["Resume", "Edit", "Budget", "Clear"]],
    ["budget_limited", ["Edit", "Budget", "Clear"]]
  ] as const)("renders the %s icon action matrix", (status, expected) => {
    render({ goal: goal(status) });
    expect(actionLabels()).toEqual(expected);
    expect([...container.querySelectorAll(".agent-goal-bar__icon-button")]
      .every((button) => button.textContent === "")).toBe(true);
  });

  it("renders the persistent controls in one ordered row", () => {
    render();
    const row = container.querySelector(".agent-goal-bar__row")!;
    expect([...row.children].map((element) => element.className)).toEqual([
      "agent-goal-bar__status agent-goal-bar__status--active",
      "agent-goal-bar__objective-viewport",
      "agent-goal-bar__usage",
      "agent-goal-bar__actions"
    ]);
    expect(container.querySelector(".agent-goal-bar__hint")).toBeNull();
    expect(container.querySelector(".agent-goal-bar__link")).toBeNull();
    expect(container.querySelector(".agent-goal-bar__objective--collapsed")).toBeNull();
  });

  it("dispatches the unchanged direct control requests from icon buttons", () => {
    const onControl = vi.fn();
    render({ onControl });
    click("Pause");
    click("Clear");
    expect(onControl.mock.calls).toEqual([
      [{ chatId: "chat-a", goalId: GOAL_ID, action: "pause" }],
      [{ chatId: "chat-a", goalId: GOAL_ID, action: "clear" }]
    ]);
  });

  it("does not render a completed Goal", () => {
    render({ goal: goal("completed") });
    expect(container.querySelector(".agent-goal-bar")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("normalizes multiline objective display without changing the edit value", () => {
    const objective = "  First line\n\nSecond\tline  ";
    render({ goal: goal("paused", { objective }) });
    expect(container.querySelector(".agent-goal-bar__objective-text")?.textContent)
      .toBe("First line Second line");

    click("Edit");
    expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Objective"]')?.value)
      .toBe(objective);
  });

  it("measures real objective overflow and exposes the marquee distance and duration", () => {
    mockMarqueeWidths(100, 240);
    render();

    const viewport = container.querySelector<HTMLElement>(".agent-goal-bar__objective-viewport")!;
    const text = container.querySelector<HTMLElement>(".agent-goal-bar__objective-text")!;
    expect(text.dataset.overflow).toBe("true");
    expect(text.style.getPropertyValue("--agent-goal-marquee-distance")).toBe("140px");
    expect(text.style.getPropertyValue("--agent-goal-marquee-duration")).toBe("5s");
    expect(viewport.tabIndex).toBe(0);
  });

  it("does not enable marquee animation when the objective fits", () => {
    mockMarqueeWidths(180, 180);
    render();

    const viewport = container.querySelector<HTMLElement>(".agent-goal-bar__objective-viewport")!;
    const text = container.querySelector<HTMLElement>(".agent-goal-bar__objective-text")!;
    expect(text.dataset.overflow).toBeUndefined();
    expect(viewport.tabIndex).toBe(-1);
  });

  it("adds the live Turn elapsed time to the persisted Goal total", () => {
    const activeGoal = goal("active", { time_used_seconds: 42 });
    const clock = { goalId: GOAL_ID, turnId: "turn-1", startedAt: 1_754_352_000, baseSeconds: 42 };

    expect(displayedGoalTimeSeconds(activeGoal, clock, 1_754_352_003_900)).toBe(45);
    expect(displayedGoalTimeSeconds(
      goal("active", { time_used_seconds: 47 }),
      clock,
      1_754_352_003_900
    )).toBe(47);
    expect(displayedGoalTimeSeconds(activeGoal, null, 1_754_352_003_900)).toBe(42);
  });

  it.each([
    ["en-US", 0, "0s"],
    ["en-US", 59, "59s"],
    ["en-US", 60, "1m 0s"],
    ["en-US", 3_599, "59m 59s"],
    ["en-US", 3_600, "1h 0m 0s"],
    ["en-US", 3_661, "1h 1m 1s"],
    ["zh-CN", 531, "8 分 51 秒"],
    ["zh-CN", 3_661, "1 小时 1 分 1 秒"]
  ] as const)("formats %s Goal duration %s as %s", (language, totalSeconds, expected) => {
    expect(formatGoalDuration(totalSeconds, translate(language))).toBe(expected);
    render({ goal: goal("paused", { time_used_seconds: totalSeconds }) }, language);
    expect(container.querySelector(".agent-goal-bar__time")?.textContent).toBe(expected);
  });

  it("refreshes the displayed Goal time once per second across a unit boundary", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-08-05T00:00:00.000Z"));
    render({
      goal: goal("active", { time_used_seconds: 58 }),
      clock: {
        goalId: GOAL_ID,
        turnId: "turn-1",
        startedAt: Date.now() / 1000,
        baseSeconds: 58
      }
    });
    expect(container.querySelector(".agent-goal-bar__usage-full")?.textContent).toContain("58s");

    act(() => vi.advanceTimersByTime(3_000));
    expect(container.querySelector(".agent-goal-bar__usage-full")?.textContent).toContain("1m 1s");
  });

  it("uses compact localized token values without losing the full accessible usage", () => {
    expect(formatCompactGoalTokenCount(1_250, "en-US")).toBe("1.3K");
    expect(formatCompactGoalTokenCount(20_000, "en-US")).toBe("20K");
    render({ goal: goal("active", { token_budget: null }) });
    expect(container.querySelector(".agent-goal-bar__usage-compact")?.textContent).toContain("1.3K/∞");
    expect(container.querySelector(".agent-goal-bar__usage")?.getAttribute("aria-label"))
      .toContain("1250 / No limit tokens");
  });

  it("moves distinct recovery guidance into the status tooltip", () => {
    render({ goal: goal("usage_limited") });
    expect(container.textContent).not.toContain("Restore the Provider quota before resuming");
    const status = container.querySelector<HTMLElement>(".agent-goal-bar__status")!;
    act(() => status.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    expect(document.querySelector("#app-tooltip-singleton")?.textContent)
      .toContain("Restore the Provider quota before resuming");

    render({ goal: goal("budget_limited") });
    const nextStatus = container.querySelector<HTMLElement>(".agent-goal-bar__status")!;
    act(() => nextStatus.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    expect(document.querySelector("#app-tooltip-singleton")?.textContent)
      .toContain("Increase or remove the Goal budget");
    expect(container.querySelector(".agent-goal-bar__hint")).toBeNull();
  });

  it("allows active Goal budget changes and validates positive safe integers", () => {
    const onControl = vi.fn();
    render({ onControl });
    click("Budget");
    expect(container.querySelector(".agent-goal-bar__form")).toBeTruthy();
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Budget"]')!;
    inputValue(input, "0");
    click("Save");
    expect(container.querySelector('[role="alert"]')?.textContent)
      .toContain("positive safe integer");
    expect(onControl).not.toHaveBeenCalled();

    inputValue(input, "25000");
    click("Save");
    expect(onControl).toHaveBeenCalledWith({
      chatId: "chat-a",
      goalId: GOAL_ID,
      action: "set_budget",
      tokenBudget: 25_000
    });
  });

  it("removes a Goal budget with the unchanged null control request", () => {
    const onControl = vi.fn();
    render({ onControl });
    click("Budget");
    click("Remove limit");
    expect(onControl).toHaveBeenCalledWith({
      chatId: "chat-a",
      goalId: GOAL_ID,
      action: "set_budget",
      tokenBudget: null
    });
  });

  it("validates objective edits and submits normalized text", () => {
    const onControl = vi.fn();
    render({ goal: goal("paused"), onControl });
    click("Edit");
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Objective"]')!;
    inputValue(textarea, "   ");
    click("Save");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("non-empty");
    expect(onControl).not.toHaveBeenCalled();

    inputValue(textarea, "  Updated objective  ");
    click("Save");
    expect(onControl).toHaveBeenCalledWith({
      chatId: "chat-a",
      goalId: GOAL_ID,
      action: "edit",
      objective: "Updated objective"
    });
  });

  it("binds a form to the chat and Goal identity that opened it and discards stale drafts", () => {
    const onControl = vi.fn();
    render({ goal: goal("paused"), onControl });
    click("Edit");
    expect(container.querySelector("textarea")).toBeTruthy();

    render({
      chatId: "chat-b",
      goal: goal("paused", { goal_id: "1d7e1916-5871-4d57-a477-e3b2f443fa31" }),
      onControl
    });
    expect(container.querySelector("textarea")).toBeNull();
    expect(onControl).not.toHaveBeenCalled();
  });

  it("disables every Goal mutation while the chat has one pending request", () => {
    render({ pending: true });
    expect([...container.querySelectorAll<HTMLButtonElement>(".agent-goal-bar__icon-button")]
      .every((button) => button.disabled)).toBe(true);
  });

  it("locks the single-line, fluid objective, compact, popover, and reduced-motion style boundaries", () => {
    const styles = readFileSync(stylesSourcePath, "utf8");
    const goalStyles = styles.slice(styles.indexOf(".agent-goal-bar {"));
    expect(goalStyles).toContain("flex-wrap: nowrap;");
    expect(goalStyles).toContain("flex: 1 1 16rem;");
    expect(goalStyles).not.toContain("max-width: 16rem;");
    expect(goalStyles).toContain('text-overflow: ellipsis;');
    expect(goalStyles).toContain('@container (max-width: 560px)');
    expect(goalStyles).toContain("flex-basis: 7rem;");
    expect(goalStyles).toContain('@media (prefers-reduced-motion: reduce)');
    expect(goalStyles).toContain("bottom: calc(100% + 0.5rem);");
    expect(goalStyles).not.toContain(".agent-goal-bar__objective--collapsed");
    expect(goalStyles).not.toContain(".agent-goal-bar__hint");
    expect(goalStyles).not.toContain(".agent-goal-bar__link");
  });
});
