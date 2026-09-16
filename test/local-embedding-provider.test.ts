import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Embedding work runs in a worker thread, so a mock installed here never
// reaches it. Each unit is therefore exercised where its code actually runs:
// loadTransformers and the worker body in-thread, the provider against a fake
// Worker. Nothing in this file loads the real model.

const previousTransformersCache = process.env.TRANSFORMERS_CACHE;
const previousHfHome = process.env.HF_HOME;

function restoreEnvironmentVariable(
  name: string,
  previousValue: string | undefined,
): void {
  if (previousValue === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previousValue;
  }
}

beforeEach(() => {
  delete process.env.TRANSFORMERS_CACHE;
  delete process.env.HF_HOME;
});

afterEach(async () => {
  restoreEnvironmentVariable("TRANSFORMERS_CACHE", previousTransformersCache);
  restoreEnvironmentVariable("HF_HOME", previousHfHome);
  const { clearTransformersImportError } = await import(
    "./fixtures/transformers-import-error.js"
  );
  clearTransformersImportError();
  vi.doUnmock("@huggingface/transformers");
  vi.doUnmock("node:worker_threads");
  vi.resetModules();
});

describe("loadTransformers (package unavailable)", () => {
  it("throws clean install hint when @huggingface/transformers is missing", async () => {
    vi.doMock("@huggingface/transformers");
    vi.resetModules();
    const { loadTransformers } = await import(
      "../src/providers/embedding/_transformers.js"
    );
    await expect(loadTransformers()).rejects.toThrow(
      "Install @huggingface/transformers for local embeddings",
    );
  });

  it("preserves missing transitive dependency errors", async () => {
    const transitiveError = Object.assign(
      new Error(
        "Cannot find package 'sharp' imported from @huggingface/transformers",
      ),
      { code: "ERR_MODULE_NOT_FOUND" },
    );
    vi.doMock("@huggingface/transformers");
    vi.resetModules();
    const { setTransformersImportError } = await import(
      "./fixtures/transformers-import-error.js"
    );
    setTransformersImportError(transitiveError);
    const { loadTransformers } = await import(
      "../src/providers/embedding/_transformers.js"
    );
    await expect(loadTransformers()).rejects.toBe(transitiveError);
  });
});

describe("Transformers cache initialization", () => {
  async function loadTransformersWithMock(module: Record<string, unknown>) {
    vi.doMock("@huggingface/transformers", () => module);
    vi.resetModules();
    const { loadTransformers } = await import(
      "../src/providers/embedding/_transformers.js"
    );
    return loadTransformers();
  }

  it("prefers TRANSFORMERS_CACHE over HF_HOME", async () => {
    process.env.TRANSFORMERS_CACHE = "D:\\runtime\\instance-25\\models\\transformers";
    process.env.HF_HOME = "D:\\runtime\\hf-home";
    const env = { cacheDir: "" };

    await loadTransformersWithMock({ env });

    expect(env.cacheDir).toBe(process.env.TRANSFORMERS_CACHE);
  });

  it("uses HF_HOME when TRANSFORMERS_CACHE is absent", async () => {
    process.env.HF_HOME = "D:\\runtime\\hf-home";
    const env = { cacheDir: "" };

    await loadTransformersWithMock({ env });

    expect(env.cacheDir).toBe(process.env.HF_HOME);
  });

  it("falls back to the portable user cache when both variables are absent", async () => {
    const env = { cacheDir: "" };

    await loadTransformersWithMock({ env });

    expect(env.cacheDir).toBe(
      join(homedir(), ".cache", "huggingface", "transformers"),
    );
  });

  it("keeps the module usable when cacheDir is not writable", async () => {
    const pipeline = vi.fn();
    const setCacheDir = vi.fn(() => {
      throw new TypeError("cacheDir is read-only");
    });
    const env = {};
    Object.defineProperty(env, "cacheDir", { set: setCacheDir });

    const transformers = await loadTransformersWithMock({ env, pipeline });

    expect(setCacheDir).toHaveBeenCalledOnce();
    expect(transformers.pipeline).toBe(pipeline);
  });
});

describe("local embedding worker", () => {
  interface FakeParentPort extends EventEmitter {
    postMessage: ReturnType<typeof vi.fn>;
  }

  async function startWorkerWithMock(module: Record<string, unknown>) {
    const port = new EventEmitter() as FakeParentPort;
    port.postMessage = vi.fn();
    vi.doMock("@huggingface/transformers", () => module);
    vi.doMock("node:worker_threads", () => ({ parentPort: port }));
    vi.resetModules();
    await import("../src/providers/embedding/local-worker.js");
    return port;
  }

  it("calls pipeline with dtype: q8, passes extractor opts, posts float32 buffers", async () => {
    const extractor = vi.fn(async (texts: string[]) => ({
      tolist: () => texts.map(() => [0.1, 0.2, 0.3]),
    }));
    const pipeline = vi.fn(() => Promise.resolve(extractor));
    const port = await startWorkerWithMock({ pipeline });

    port.emit("message", { id: 7, texts: ["hello"] });
    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalled());

    expect(pipeline).toHaveBeenCalledWith(
      "feature-extraction",
      "Xenova/all-MiniLM-L6-v2",
      { dtype: "q8" },
    );
    expect(extractor).toHaveBeenCalledWith(["hello"], {
      pooling: "mean",
      normalize: true,
    });

    const [message] = port.postMessage.mock.calls[0];
    expect(message.id).toBe(7);
    expect(new Float32Array(message.buffers[0])).toEqual(
      new Float32Array([0.1, 0.2, 0.3]),
    );
  });

  it("reports the failure message instead of throwing out of the worker", async () => {
    const pipeline = vi.fn(() => Promise.reject(new Error("pipeline is down")));
    const port = await startWorkerWithMock({ pipeline });

    port.emit("message", { id: 3, texts: ["hello"] });
    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalled());

    expect(port.postMessage.mock.calls[0][0]).toEqual({
      id: 3,
      error: "pipeline is down",
    });
  });
});

describe("LocalEmbeddingProvider", () => {
  class FakeWorker extends EventEmitter {
    ref = vi.fn();
    unref = vi.fn();
    postMessage = vi.fn((request: { id: number; texts: string[] }) => {
      queueMicrotask(() =>
        this.emit("message", {
          id: request.id,
          buffers: request.texts.map(
            (_text, index) => Float32Array.from([index, index + 0.5]).buffer,
          ),
        }),
      );
    });
  }

  class FailingWorker extends EventEmitter {
    ref = vi.fn();
    unref = vi.fn();
    postMessage = vi.fn((request: { id: number }) => {
      queueMicrotask(() =>
        this.emit("message", { id: request.id, error: "worker said no" }),
      );
    });
  }

  async function loadProviderWith(WorkerImpl: unknown) {
    vi.doMock("node:worker_threads", () => ({ Worker: WorkerImpl }));
    vi.resetModules();
    const { LocalEmbeddingProvider } = await import(
      "../src/providers/embedding/local.js"
    );
    return new LocalEmbeddingProvider();
  }

  it("embed maps the worker's buffer to a Float32Array", async () => {
    const provider = await loadProviderWith(FakeWorker);

    const vec = await provider.embed("hello");

    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec).toEqual(new Float32Array([0, 0.5]));
  });

  it("embedBatch returns one Float32Array per input text", async () => {
    const provider = await loadProviderWith(FakeWorker);

    const vecs = await provider.embedBatch(["a", "b", "c"]);

    expect(vecs).toHaveLength(3);
    for (const v of vecs) expect(v).toBeInstanceOf(Float32Array);
    expect(vecs[2]).toEqual(new Float32Array([2, 2.5]));
  });

  it("rejects with the error the worker reported", async () => {
    const provider = await loadProviderWith(FailingWorker);

    await expect(provider.embed("hello")).rejects.toThrow("worker said no");
  });
});
