import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const example = readFileSync(".env.example", "utf-8");

describe(".env.example feature flags", () => {
  it("uses the boolean value accepted by the slots gate", () => {
    expect(example).toContain("AGENTMEMORY_SLOTS=true");
    expect(example).not.toContain("AGENTMEMORY_SLOTS=memory");
  });
});
