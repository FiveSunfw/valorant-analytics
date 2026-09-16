import { describe, expect, it } from "vitest";
import { calculatePlayerMetrics } from "./metrics.js";

describe("calculatePlayerMetrics", () => {
  it("calculates the fixture metrics deterministically", () => {
    expect(calculatePlayerMetrics({
      score: 600, roundsPlayed: 3, kills: 2, deaths: 1, totalDamage: 200,
      headshots: 2, bodyshots: 2, legshots: 0, firstDeaths: 1, firstKills: 1, assists: 1, roundsWithKast: 2
    })).toEqual({ adr: 66.67, acs: 200, kd: 2, headshotRate: 50, firstDeathRate: 33.33, firstKillRate: 33.33, kast: 66.67 });
  });
});
