import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAnalyticsContextForTests, setAnalyticsUserMode } from "../analytics-context.js";
import {
  flushDesktopCloudAnalytics,
  getDesktopAnalyticsClientId,
  resetDesktopCloudAnalyticsForTests,
  resolveDesktopAnalyticsBaseUrl,
  setDesktopAnalyticsClientId,
  trackCloudAnalyticsEvent
} from "../cloud-analytics.js";

describe("cloud-analytics", () => {
  const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));

  beforeEach(() => {
    vi.stubEnv("MEMMY_CLOUD_SERVICE", "https://cloud.example.com/");
    vi.stubEnv("MEMMY_APP_EDITION", "cn");
    resetAnalyticsContextForTests();
    resetDesktopCloudAnalyticsForTests({ fetchImpl: fetchMock as unknown as typeof fetch });
    fetchMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetAnalyticsContextForTests();
    resetDesktopCloudAnalyticsForTests();
  });

  it("strips trailing slashes from MEMMY_CLOUD_SERVICE", () => {
    expect(resolveDesktopAnalyticsBaseUrl("https://cloud.example.com///")).toBe(
      "https://cloud.example.com"
    );
    expect(resolveDesktopAnalyticsBaseUrl("")).toBeNull();
  });

  it("queues events until session client_id is set, then posts once", async () => {
    setAnalyticsUserMode("account");
    trackCloudAnalyticsEvent("welcome_viewed", { step: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getDesktopAnalyticsClientId()).toBeNull();

    setDesktopAnalyticsClientId("cid-from-gtag");
    await flushDesktopCloudAnalytics();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://cloud.example.com/api/analytics/events");
    expect(init?.method).toBe("POST");
    const body = JSON.parse(String(init?.body)) as {
      clientId: string;
      events: Array<{ eventName: string; params: Record<string, unknown> }>;
    };
    expect(body.clientId).toBe("cid-from-gtag");
    expect(body.events).toHaveLength(1);
    expect(body.events[0]?.eventName).toBe("welcome_viewed");
    expect(body.events[0]?.params).toMatchObject({
      step: 1,
      user_mode: "account",
      source: "memmy-desktop",
      app_env: "dev",
      app_edition: "cn",
      engagement_time_msec: 100
    });
    expect(body.events[0]?.params.timestamp_micros).toEqual(expect.any(Number));
  });

  it("does not use a client_id until setDesktopAnalyticsClientId runs", async () => {
    trackCloudAnalyticsEvent("page_view", { page_path: "/welcome" });
    await flushDesktopCloudAnalytics();
    expect(fetchMock).not.toHaveBeenCalled();

    setDesktopAnalyticsClientId("  fresh-id  ");
    await flushDesktopCloudAnalytics();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { clientId: string };
    expect(body.clientId).toBe("fresh-id");
  });

  it("drops queued events when cloud base URL is unset", async () => {
    vi.stubEnv("MEMMY_CLOUD_SERVICE", "");
    trackCloudAnalyticsEvent("page_view", { page_path: "/main" });
    setDesktopAnalyticsClientId("cid-1");
    await flushDesktopCloudAnalytics();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
