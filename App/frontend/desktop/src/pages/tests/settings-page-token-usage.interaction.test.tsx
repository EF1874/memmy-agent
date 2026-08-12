// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import type { ByokTokenUsageSummary, TokenUsageDto } from "@memmy/local-api-contracts";
import { appActions } from "../../state/app-actions.js";
import { appReducer, createInitialAppState } from "../../state/app-reducer.js";
import { SettingsPageView, UsageDetailView } from "../settings-page.js";
import { mockBootstrap } from "./fixtures/bootstrap.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("SettingsPage platform scene quota details", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: createMemoryStorage()
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  it("shows the aggregate on settings and all three scene totals in usage details", () => {
    const bootstrap = {
      ...mockBootstrap,
      app: {
        ...mockBootstrap.app,
        userMode: "account" as const,
        language: "zh-CN" as const
      },
      tokenUsage: {
        ...mockBootstrap.tokenUsage,
        totalTokens: 30_000_000,
        usedTokens: 23_000_000,
        remainingTokens: 7_000_000,
        sceneUsages: [
          {
            scene: "agent_chat" as const,
            totalTokens: 5_000_000,
            usedTokens: 6_000_000,
            remainingTokens: -1_000_000
          },
          {
            scene: "memory_summary" as const,
            totalTokens: 20_000_000,
            usedTokens: 15_000_000,
            remainingTokens: 5_000_000
          },
          {
            scene: "memory_evolution" as const,
            totalTokens: 5_000_000,
            usedTokens: 2_000_000,
            remainingTokens: 3_000_000
          }
        ]
      }
    };
    const bootstrapped = appReducer(
      createInitialAppState(),
      appActions.bootstrapLoaded(bootstrap, "/settings")
    );
    const state = appReducer(bootstrapped, appActions.accountUpdated({
      nickname: "测试账户",
      email: "tester@example.com",
      phoneNumber: null,
      registeredAt: "2026-04-12T00:00:00.000Z"
    }));

    act(() => {
      root.render(
        <I18nProvider language="zh-CN">
          <SettingsPageView
            state={state}
            dispatch={vi.fn()}
            update={{
              appVersion: "1.0.4",
              phase: "idle",
              preparedUpdatePath: null,
              downloadProgress: null,
              feedback: null,
              requestPrimaryAction: vi.fn(async () => undefined)
            }}
          />
        </I18nProvider>
      );
    });

    expect(container.textContent).toContain("Agent 任务额度已用 6.0M Token");
    expect(container.textContent).toContain("共 5.0M Token");

    const detailsButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("查看用量详情"));
    expect(detailsButton).toBeDefined();
    act(() => detailsButton?.click());

    expect(container.textContent).toContain("平台赠送额度");
    expect(container.textContent).toContain("Agent 任务");
    expect(container.textContent).toContain("6M/5MToken");
    expect(container.textContent).toContain("记忆摘要");
    expect(container.textContent).toContain("15M/20MToken");
    expect(container.textContent).toContain("记忆进化");
    expect(container.textContent).toContain("2M/5MToken");

    const sceneHeading = [...container.querySelectorAll("h2")]
      .find((heading) => heading.textContent === "平台赠送额度");
    const sceneGrid = sceneHeading?.parentElement?.nextElementSibling;
    expect(sceneGrid).toBeInstanceOf(HTMLElement);
    expect(sceneGrid?.className).toContain("platformQuotaList");
  });

  it("shows BYOK usage by stable provider and model dimensions, including historical rows", () => {
    const byokUsage: ByokTokenUsageSummary = {
      inputTokens: 24,
      outputTokens: 21,
      totalTokens: 45,
      cachedInputTokens: 3,
      cacheCreationInputTokens: 0,
      updatedAt: "2026-08-11T12:00:00.000Z",
      byKind: [{
        kind: "agent_chat",
        inputTokens: 24,
        outputTokens: 21,
        totalTokens: 45,
        cachedInputTokens: 3,
        cacheCreationInputTokens: 0,
        eventCount: 3,
        updatedAt: "2026-08-11T12:00:00.000Z"
      }],
      byProvider: [],
      byModel: [
        byModel("preset-openai", "openai", "shared-model", "agent", 30),
        byModel("preset-anthropic", "anthropic", "shared-model", "agent", 10),
        byModel(null, null, null, null, 5)
      ]
    };

    act(() => {
      root.render(
        <I18nProvider language="zh-CN">
          <UsageDetailView
            showPlatform
            platformUsage={emptyPlatformUsage()}
            byokUsage={byokUsage}
            byokUsageStatus="ready"
            workspaceMode="account"
            onBack={vi.fn()}
          />
        </I18nProvider>
      );
    });

    expect(container.textContent).toContain("平台赠送额度");
    expect(container.textContent).toContain("按模型");
    const modelRows = [...container.querySelectorAll('[data-testid="byok-model-usage-row"]')];
    expect(modelRows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("shared-modelopenai · Agent 任务30Token"),
      expect.stringContaining("shared-modelanthropic · Agent 任务10Token"),
      expect.stringContaining("历史未分类升级前记录，无法可靠归属到具体模型5Token")
    ]);

    act(() => {
      root.render(
        <I18nProvider language="zh-CN">
          <UsageDetailView
            showPlatform={false}
            platformUsage={emptyPlatformUsage()}
            byokUsage={byokUsage}
            byokUsageStatus="ready"
            workspaceMode="byok"
            onBack={vi.fn()}
          />
        </I18nProvider>
      );
    });

    expect(container.textContent).not.toContain("平台赠送额度");
    expect(container.textContent).toContain("自定义 API Key 消耗");
  });
});

function byModel(
  presetId: string | null,
  provider: string | null,
  model: string | null,
  capability: "agent" | null,
  totalTokens: number
): ByokTokenUsageSummary["byModel"][number] {
  return {
    presetId,
    provider,
    model,
    capability,
    inputTokens: totalTokens,
    outputTokens: 0,
    totalTokens,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    eventCount: 1,
    updatedAt: "2026-08-11T12:00:00.000Z"
  };
}

function emptyPlatformUsage(): TokenUsageDto {
  return {
    planName: "free",
    totalTokens: 1,
    usedTokens: 1,
    remainingTokens: 0,
    expiresAt: null,
    lastSyncedAt: null,
    sceneUsages: [{
      scene: "agent_chat",
      totalTokens: 1,
      usedTokens: 1,
      remainingTokens: 0
    }]
  };
}

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value)
  };
}
