import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../src/logger.js";
import {
  publishStreamItems,
  resetStreamPublisherForTests,
} from "../src/functions/stream-publish.js";

/**
 * The engine this fork runs on (iii 0.23.1) has no stream::set / stream::send
 * in the default namespace; the SDK (0.11.2) still calls them. Every
 * projection therefore logged "Non-fatal stream publish failure … error:
 * [object Object]" (2026-09-11, problem 20): the rejection is a plain
 * {code, message} object, and nothing stopped the next call from trying
 * again. One line saying the engine has no streams, then silence.
 */
const notFound = () =>
  Promise.reject({ code: "function_not_found", message: "Function stream::set not found in namespace default." });

const item = (id: string) => ({
  function_id: "stream::set",
  payload: { stream_name: "mem-live", group_id: "viewer", item_id: id, data: {} },
});

describe("publishStreamItems", () => {
  afterEach(() => {
    resetStreamPublisherForTests();
    vi.restoreAllMocks();
  });

  it("stops calling the engine after it answers function_not_found, and says so once", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const sdk = { trigger: vi.fn(notFound) };

    await publishStreamItems(sdk as never, [item("a"), item("b")], { where: "projection", observationId: "obs_1" });
    await publishStreamItems(sdk as never, [item("c")], { where: "projection", observationId: "obs_2" });

    expect(sdk.trigger).toHaveBeenCalledTimes(2);
    expect(info.mock.calls.filter(([m]) => String(m).includes("no stream functions"))).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("names the failure when the engine rejects for another reason", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const sdk = { trigger: vi.fn(() => Promise.reject({ code: "invocation_failed", message: "boom" })) };

    await publishStreamItems(sdk as never, [item("a")], { where: "compress", observationId: "obs_1" });
    await publishStreamItems(sdk as never, [item("b")], { where: "compress", observationId: "obs_2" });

    expect(sdk.trigger).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(2);
    const detail = JSON.stringify(warn.mock.calls[0]?.[1]);
    expect(detail).toContain("boom");
    expect(detail).not.toContain("[object Object]");
  });

  it("publishes every item when the engine accepts them", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const sdk = { trigger: vi.fn(async () => ({ ok: true })) };

    await publishStreamItems(sdk as never, [item("a"), item("b")], { where: "observe", observationId: "obs_1" });

    expect(sdk.trigger).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
  });
});
