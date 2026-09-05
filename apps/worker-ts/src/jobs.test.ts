import { describe, expect, it } from "vitest";
import { fixtureSyncJobSchema } from "./jobs.js";

describe("fixture sync job", () => {
  it("accepts only an internal account id and validated match payloads", () => {
    expect(() => fixtureSyncJobSchema.parse({ riotAccountId: "not-a-uuid", matchPayloads: [] })).toThrow();
    expect(fixtureSyncJobSchema.parse({
      riotAccountId: "2a3d86cd-2a7f-4541-8eb9-d6f5b546b3aa",
      matchPayloads: []
    }).riotAccountId).toBe("2a3d86cd-2a7f-4541-8eb9-d6f5b546b3aa");
  });
});
