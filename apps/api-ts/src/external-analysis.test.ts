import { describe, expect, it } from "vitest";
import { validateExternalResult } from "./external-analysis.js";

describe("external analysis adapter boundary", () => {
  it("accepts provider-labelled replay evidence with limitations", () => {
    expect(validateExternalResult({
      provider: "opgg", source: "uploaded-replay", generatedAt: "2026-09-07T00:00:00.000Z",
      gameVersion: "13.00", metrics: { reactionMs: 220 }, evidenceRefs: ["opgg:upload-1:round-3"],
      limitations: ["Third-party parser; not Riot Match API evidence."]
    }).provider).toBe("opgg");
  });

  it("rejects unbounded public-profile results as player evidence", () => {
    expect(() => validateExternalResult({
      provider: "opgg", source: "public-profile", generatedAt: "2026-09-07T00:00:00.000Z",
      metrics: {}, evidenceRefs: ["profile:1"], limitations: ["Public profile"]
    })).toThrow("authenticated player evidence");
  });
});
