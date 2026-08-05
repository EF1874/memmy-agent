// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentGoalState, AgentGoalStatus } from "../../api/memmy-agent-client.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { AgentGoalBar, type AgentGoalBarProps } from "../agent-goal-bar.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const GOAL_ID = "8f59f58a-7295-4c34-8e03-55e7035a5a8d";

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
    document.body.replaceChildren();
  });

  function render(props: Partial<AgentGoalBarProps> = {}): void {
    const resolved: AgentGoalBarProps = {
      chatId: "chat-a",
      goal: goal("active"),
      pending: false,
      onControl: vi.fn(),
      ...props
    };
    act(() => root.render(
      <I18nProvider language="en-US">
        <AgentGoalBar {...resolved} />
      </I18nProvider>
    ));
  }

  function buttons(): string[] {
    return [...container.querySelectorAll("button")].map((button) => button.textContent ?? "");
  }

  function click(label: string): void {
    const button = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((item) => item.textContent === label);
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

  it.each([
    ["active", ["Pause", "Budget", "Clear"]],
    ["paused", ["Resume", "Edit", "Budget", "Clear"]],
    ["blocked", ["Resume", "Edit", "Budget", "Clear"]],
    ["usage_limited", ["Resume", "Edit", "Budget", "Clear"]],
    ["budget_limited", ["Edit", "Budget", "Clear"]]
  ] as const)("renders the %s action matrix", (status, expected) => {
    render({ goal: goal(status) });
    expect(buttons()).toEqual(expected);
  });

  it("does not render a completed Goal", () => {
    render({ goal: goal("completed") });
    expect(container.querySelector(".agent-goal-bar")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("shows distinct Provider quota and Goal budget recovery guidance", () => {
    render({ goal: goal("usage_limited") });
    expect(container.textContent).toContain("Restore the Provider quota before resuming");

    render({ goal: goal("budget_limited") });
    expect(container.textContent).toContain("Increase or remove the Goal budget");
    expect(container.textContent).not.toContain("Restore the Provider quota before resuming");
  });

  it("allows active Goal budget changes and validates positive safe integers", () => {
    const onControl = vi.fn();
    render({ onControl });
    click("Budget");
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
    expect([...container.querySelectorAll<HTMLButtonElement>("button")].every((button) => button.disabled))
      .toBe(true);
  });
});
