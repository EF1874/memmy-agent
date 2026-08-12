// @vitest-environment happy-dom

import type { ModelConfigView } from "@memmy/local-api-contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelProviderConfig } from "../../api/config-client.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { ModelWorkspaceSection } from "../model-workspace-section.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("ModelWorkspaceSection BYOK connection deletion", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    window.sessionStorage.clear();
    window.history.replaceState(null, "", "/settings#model-config");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  it("disables deletion when only one BYOK connection remains", () => {
    renderWorkspace(createSeedConfig(1));

    const deleteButton = getDeleteButtons()[0]!;
    expect(deleteButton.disabled).toBe(true);

    act(() => deleteButton.click());

    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("keeps deletion available when another BYOK connection remains", () => {
    renderWorkspace(createSeedConfig(2));

    const deleteButtons = getDeleteButtons();
    expect(deleteButtons).toHaveLength(2);
    expect(deleteButtons.every((button) => !button.disabled)).toBe(true);

    act(() => deleteButtons[0]!.click());

    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain("删除配置？");
  });

  function renderWorkspace(seedConfig: ModelProviderConfig) {
    act(() => {
      root.render(
        <I18nProvider language="zh-CN">
          <ModelWorkspaceSection mode="byok" seedConfig={seedConfig} />
        </I18nProvider>
      );
    });
  }

  function getDeleteButtons(): HTMLButtonElement[] {
    return [...container.querySelectorAll<HTMLButtonElement>('button[aria-label="删除 openai 配置"]')];
  }
});

function createSeedConfig(connectionCount: 1 | 2): ModelProviderConfig {
  const endpoints = Array.from({ length: connectionCount }, (_value, index) => ({
    endpointId: `endpoint-${index + 1}`,
    apiBase: `https://api-${index + 1}.example.com/v1`,
    protocol: "openai-chat-completions" as const,
    hasApiKey: true,
    apiKeyMasked: "••••test",
    apiKey: ""
  }));
  const models = endpoints.map((endpoint, index) => ({
    presetId: `preset-${index + 1}`,
    provider: "openai" as const,
    endpointId: endpoint.endpointId,
    protocol: endpoint.protocol,
    model: `model-${index + 1}`,
    source: "byok" as const,
    capabilities: ["agent" as const],
    available: true
  }));
  const catalog: ModelConfigView = {
    configRevision: "revision-delete-guard",
    providers: [{
      provider: "openai",
      configured: true,
      hasApiKey: true,
      apiKeyMasked: "••••test",
      apiKey: "",
      endpoints,
      accountManaged: false,
      editable: true,
      models
    }],
    modelAssignments: {
      byok: {
        agent: { candidates: models.map((model) => model.presetId), default: models[0]!.presetId },
        memorySummary: null,
        memoryEvolution: null,
        embedding: null,
        asr: null,
        imageGeneration: null
      },
      account: {
        agent: { candidates: [], default: null },
        memorySummary: null,
        memoryEvolution: null,
        embedding: null,
        asr: null,
        imageGeneration: null
      }
    },
    effectiveCandidates: { byok: models, account: [] },
    configured: true,
    updatedAt: "2026-08-12T00:00:00.000Z"
  };

  return {
    catalog,
    provider: "openai",
    endpoint: endpoints[0]!.apiBase,
    model: models[0]!.model,
    apiKey: "",
    apiKeyMasked: "••••test",
    configured: true
  };
}
