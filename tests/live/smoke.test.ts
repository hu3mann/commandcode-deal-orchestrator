import { describe, expect, it } from "vitest";

const live = process.env.CCROUTE_LIVE === "1";

describe.skipIf(!live)("live smoke", () => {
  it("placeholder — enable with CCROUTE_LIVE=1 and implement budgeted calls", () => {
    expect(live).toBe(true);
  });
});
