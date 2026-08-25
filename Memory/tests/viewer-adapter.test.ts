import { describe, expect, it } from "vitest";
import { adaptViewerResponse } from "../viewer/src/api/memmy-adapter.js";

describe("Memmy Viewer response adapter", () => {
  it("keeps trace and user-memory counts separate and exposes daily activity", () => {
    const result = adaptViewerResponse("GET", "/api/v1/overview", undefined, {
      stats: {
        byLayer: { L1: 7, L2: 3, L3: 2, Skill: 4 },
        episodes: { open: 1, closed: 5 },
      },
      summary: {
        counts: { userMemories: 6 },
        dailyActivity: [
          { date: "2026-08-24", count: 2 },
          { date: "2026-08-25", count: 5 },
        ],
      },
    });

    expect(result).toMatchObject({
      traces: 7,
      userMemories: 6,
      episodes: 6,
      worldModels: 2,
      dailyActivity: [
        { date: "2026-08-24", count: 2 },
        { date: "2026-08-25", count: 5 },
      ],
    });
  });
});
