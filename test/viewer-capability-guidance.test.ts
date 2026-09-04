import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const viewer = readFileSync("src/viewer/index.html", "utf-8");

describe("viewer capability guidance", () => {
  it("uses the actual lesson-save input names", () => {
    expect(viewer).toContain(
      "memory_lesson_save { content, context, confidence }",
    );
    expect(viewer).not.toContain(
      "memory_lesson_save { rule, reason, confidence }",
    );
  });

  it("does not claim hooks create actions when no hook calls action-create", () => {
    expect(viewer).not.toContain("Hooks auto-extract from long session bodies");
    expect(viewer).not.toContain('"priority":"high"');
    expect(viewer).toContain('"priority":10');
    expect(viewer).toContain(
      "Agents create actions explicitly with the MCP tool or REST API",
    );
  });

  it("shows actionIds as the required crystallize input", () => {
    expect(viewer).toContain(
      "memory_crystallize { actionIds, project, sessionId }",
    );
    expect(viewer).not.toContain("memory_crystallize { sessionId }");
  });
});
