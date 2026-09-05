import { describe, expect, it } from "vitest";
import { AnalyticsReader } from "./analytics-reader.js";

describe("AnalyticsReader", () => {
  it("does not expose a PUUID-based query", () => {
    expect(Object.getOwnPropertyNames(AnalyticsReader.prototype)).not.toContain("getByPuuid");
  });
});
