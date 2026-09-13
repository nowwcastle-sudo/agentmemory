import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { EmbeddingProvider } from "../../types.js";

interface WorkerResponse {
  id: number;
  buffers?: ArrayBuffer[];
  error?: string;
}

interface PendingRequest {
  resolve: (vectors: Float32Array[]) => void;
  reject: (error: Error) => void;
}

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly name = "local";
  readonly dimensions = 384;
  private worker: Worker | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();

  async embed(text: string): Promise<Float32Array> {
    const [result] = await this.embedBatch([text]);
    return result;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const worker = this.getWorker();
    const id = this.nextRequestId++;

    worker.ref();
    return new Promise<Float32Array[]>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        worker.postMessage({ id, texts });
      } catch (error) {
        this.pending.delete(id);
        if (this.pending.size === 0) worker.unref();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private getWorker(): Worker {
    if (this.worker) return this.worker;

    const bundledUrl = new URL("./local-worker.mjs", import.meta.url);
    const sourceUrl = new URL("../../../dist/local-worker.mjs", import.meta.url);
    const workerUrl = existsSync(fileURLToPath(bundledUrl))
      ? bundledUrl
      : sourceUrl;
    const worker = new Worker(workerUrl, { execArgv: [] });

    worker.on("message", (response: WorkerResponse) => {
      const request = this.pending.get(response.id);
      if (!request) return;

      this.pending.delete(response.id);
      if (response.error) {
        request.reject(new Error(response.error));
      } else if (response.buffers) {
        request.resolve(
          response.buffers.map((buffer) => new Float32Array(buffer)),
        );
      } else {
        request.reject(new Error("Local embedding worker returned no vectors"));
      }

      if (this.pending.size === 0) worker.unref();
    });
    worker.on("error", (error) => {
      if (this.worker === worker) this.failWorker(error);
    });
    worker.on("exit", (code) => {
      if (this.worker !== worker) return;
      if (code !== 0 || this.pending.size > 0) {
        this.failWorker(new Error(`Local embedding worker exited with code ${code}`));
      } else {
        this.worker = null;
      }
    });
    worker.unref();
    this.worker = worker;
    return worker;
  }

  private failWorker(error: Error): void {
    this.worker = null;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
}
