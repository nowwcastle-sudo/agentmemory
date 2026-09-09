import { describe, expect, it } from "vitest";
import type { ISdk, ApiRequest, ApiResponse } from "../src/iii-compat.js";
import { TriggerAction, registerWorker } from "../src/iii-compat.js";

// One module stands between this codebase and whatever the installed iii-sdk
// calls things. 0.23.x renamed ISdk to IIIClient and dropped ApiRequest,
// ApiResponse, HttpRequest, HttpResponse and Logger from its public API, so
// without this shim the upgrade would touch 147 ISdk sites across 70 files and
// 143 ApiRequest sites across 2. These tests pin the names the rest of the
// codebase imports, not the SDK's own shape -- that is the whole point: the
// SDK may rename again, and only this file should have to notice.
describe("iii-compat", () => {
  it("re-exports the runtime values the codebase uses", () => {
    expect(typeof registerWorker).toBe("function");
    expect(TriggerAction).toBeDefined();
  });

  it("keeps ApiRequest assignable from a plain HTTP request shape", () => {
    const req: ApiRequest<{ q: string }> = {
      body: { q: "hello" },
      headers: { "content-type": "application/json" },
      query_params: { limit: "10" },
      method: "POST",
    };
    expect(req.body?.q).toBe("hello");
    expect(req.query_params?.["limit"]).toBe("10");
  });

  it("keeps ApiResponse assignable from a status and body pair", () => {
    const res: ApiResponse<{ ok: boolean }> = {
      status_code: 200,
      body: { ok: true },
    };
    expect(res.status_code).toBe(200);
    expect(res.body?.ok).toBe(true);
  });

  // The four methods every registration site in src/ calls. If a future SDK
  // drops one of these, this fails to compile here rather than in 70 files.
  it("types a client carrying the methods the codebase calls", () => {
    const called: Array<keyof ISdk> = [
      "registerFunction",
      "registerTrigger",
      "trigger",
      "shutdown",
    ];
    expect(called).toHaveLength(4);
  });
});
