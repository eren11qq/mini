import { describe, it, expect } from "vitest";
import { MINI_VERSION } from "./index.js";

describe("mini smoke", () => {
  it("exposes its version", () => {
    expect(MINI_VERSION).toBe("0.1.0");
  });
});
