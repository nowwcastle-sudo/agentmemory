import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const viewer = readFileSync("src/viewer/index.html", "utf8");

function namedFunction(name: string): string | null {
  const asyncStart = viewer.indexOf(`async function ${name}(`);
  const syncStart = viewer.indexOf(`function ${name}(`);
  const start = asyncStart >= 0 ? asyncStart : syncStart;
  if (start < 0) return null;
  const body = viewer.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < viewer.length; index++) {
    if (viewer[index] === "{") depth++;
    if (viewer[index] === "}") depth--;
    if (depth === 0) return viewer.slice(start, index + 1);
  }
  return null;
}

describe("viewer dashboard refresh", () => {
  it("keeps known values when part of a refresh fails", () => {
    const source = namedFunction("mergeDashboardResults");
    expect(source).not.toBeNull();
    if (!source) return;
    const merge = Function(`return (${source})`)() as (
      dashboard: Record<string, unknown>,
      results: unknown[],
    ) => void;
    const dashboard = {
      health: { status: "healthy" },
      sessions: [{ id: "known-session" }],
      memories: [{ id: "old-memory" }],
      graphStats: { totalNodes: 5 },
      recentAudit: [{ id: "known-audit" }],
      semantic: [{ id: "known-semantic" }],
      procedural: [{ id: "known-procedure" }],
      relations: [{ id: "known-relation" }],
      lessons: [{ id: "known-lesson" }],
      crystals: [{ id: "known-crystal" }],
    };
    const results = Array.from({ length: 10 }, () => null);
    results[2] = { memories: [{ id: "new-memory" }] };
    results[8] = { lessons: [] };

    merge(dashboard, results);

    expect(dashboard.health).toEqual({ status: "healthy" });
    expect(dashboard.sessions).toEqual([{ id: "known-session" }]);
    expect(dashboard.memories).toEqual([{ id: "new-memory" }]);
    expect(dashboard.lessons).toEqual([]);
    expect(dashboard.crystals).toEqual([{ id: "known-crystal" }]);
  });

  it("keeps the rendered dashboard visible and coalesces overlapping refreshes", async () => {
    const loadSource = namedFunction("loadDashboard");
    const refreshSource = namedFunction("refreshDashboard");
    expect(loadSource).not.toBeNull();
    expect(refreshSource).not.toBeNull();
    if (!loadSource || !refreshSource) return;
    let release!: (value: null) => void;
    const pending = new Promise<null>((resolve) => { release = resolve; });
    const panel = { innerHTML: "known-dashboard" };
    const state = {
      dashboard: {
        loaded: true,
        health: { status: "healthy" },
        sessions: [{ id: "known-session" }],
        memories: [],
        graphStats: {},
        recentAudit: [],
        semantic: [],
        procedural: [],
        relations: [],
        lessons: [],
        crystals: [],
      },
    };
    const api = vi.fn(() => pending);
    const apiGet = vi.fn(() => pending);
    const renderDashboard = vi.fn();
    const mergeSource = namedFunction("mergeDashboardResults") ??
      "function mergeDashboardResults() {}";
    const runtime = Function("deps", `
      var dashboardLoading = false;
      var document = deps.document;
      var state = deps.state;
      var api = deps.api;
      var apiGet = deps.apiGet;
      var renderDashboard = deps.renderDashboard;
      ${mergeSource}
      ${loadSource}
      ${refreshSource}
      return { refreshDashboard: refreshDashboard };
    `)({
      document: { getElementById: () => panel },
      state,
      api,
      apiGet,
      renderDashboard,
    }) as { refreshDashboard(): Promise<void> | void };

    const first = runtime.refreshDashboard();
    const second = runtime.refreshDashboard();

    expect(panel.innerHTML).toBe("known-dashboard");
    expect(api).toHaveBeenCalledTimes(1);
    expect(apiGet).toHaveBeenCalledTimes(9);
    release(null);
    await Promise.all([first, second]);
  });

  it("does not refresh from a hidden tab", () => {
    // A dashboard left open in a background tab polled ten endpoints, several
    // of them whole lists, every 10 s while its live socket was down
    // (2026-09-24). Nobody sees a hidden tab; the next tick after it is shown
    // refreshes it.
    const polling = namedFunction("startPolling");
    const auto = namedFunction("startDashboardAutoRefresh");
    expect(polling).not.toBeNull();
    expect(auto).not.toBeNull();
    if (!polling || !auto) return;
    // Each timer is started on its own so the auto refresh is not short-cut
    // by an active polling timer.
    const ticksOf = (hidden: boolean, start: "startPolling" | "startDashboardAutoRefresh") => {
      const ticks: Array<() => void> = [];
      const refreshDashboard = vi.fn();
      Function("deps", `
        var document = deps.document;
        var state = { activeTab: "dashboard", ws: null };
        var pollTimer = null, dashboardTimer = null;
        var POLL_INTERVAL_MS = 10000, WS_REPROBE_EVERY_TICKS = 6;
        var setInterval = deps.setInterval;
        var setWsStatus = function () {};
        var refreshDashboard = deps.refreshDashboard;
        ${polling}
        ${auto}
        ${start}();
      `)({
        document: { hidden },
        setInterval: (fn: () => void) => (ticks.push(fn), ticks.length),
        refreshDashboard,
      });
      for (const tick of ticks) tick();
      return refreshDashboard.mock.calls.length;
    };
    for (const start of ["startPolling", "startDashboardAutoRefresh"] as const) {
      expect(ticksOf(true, start)).toBe(0);
      expect(ticksOf(false, start)).toBe(1);
    }
  });

  it("routes polling and live events through the non-invalidating refresh", () => {
    const polling = namedFunction("startPolling");
    const live = namedFunction("routeWsMessage");
    expect(polling).not.toBeNull();
    expect(live).not.toBeNull();
    expect(polling).toContain("refreshDashboard();");
    expect(live).toContain("refreshDashboard();");
    expect(polling).not.toContain("state.dashboard.loaded = false");
    expect(live).not.toContain("state.dashboard.loaded = false");
  });
});
