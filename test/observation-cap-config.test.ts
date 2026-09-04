import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("observation cap configuration", () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env["MAX_OBS_PER_SESSION"];
  });

  afterEach(() => {
    if (original === undefined) delete process.env["MAX_OBS_PER_SESSION"];
    else process.env["MAX_OBS_PER_SESSION"] = original;
  });

  it("defaults to unlimited continuous capture", () => {
    process.env["MAX_OBS_PER_SESSION"] = "";
    expect(loadConfig().maxObservationsPerSession).toBe(0);
  });

  it("preserves an explicit positive safety cap", () => {
    process.env["MAX_OBS_PER_SESSION"] = "750";
    expect(loadConfig().maxObservationsPerSession).toBe(750);
  });
});
