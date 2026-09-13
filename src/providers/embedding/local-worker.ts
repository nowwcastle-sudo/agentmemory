import { parentPort } from "node:worker_threads";
import { loadTransformers } from "./_transformers.js";

type FeatureExtractor = (
  texts: string[],
  options: { pooling: string; normalize: boolean },
) => Promise<{ tolist: () => number[][] }>;

interface EmbeddingRequest {
  id: number;
  texts: string[];
}

const port = parentPort;
if (!port) throw new Error("Local embedding worker requires a parent port");

let extractorPromise: Promise<FeatureExtractor> | null = null;
let queue = Promise.resolve();

function getExtractor(): Promise<FeatureExtractor> {
  if (!extractorPromise) {
    extractorPromise = loadTransformers().then(
      async (transformers) =>
        (await transformers.pipeline(
          "feature-extraction",
          "Xenova/all-MiniLM-L6-v2",
          { dtype: "q8" },
        )) as FeatureExtractor,
    ).catch((error) => {
      extractorPromise = null;
      throw error;
    });
  }
  return extractorPromise;
}

async function processRequest(request: EmbeddingRequest): Promise<void> {
  try {
    const extractor = await getExtractor();
    const output = await extractor(request.texts, {
      pooling: "mean",
      normalize: true,
    });
    const buffers = output.tolist().map((values) => {
      const vector = Float32Array.from(values);
      return vector.buffer as ArrayBuffer;
    });
    port.postMessage({ id: request.id, buffers }, buffers);
  } catch (error) {
    port.postMessage({
      id: request.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

port.on("message", (request: EmbeddingRequest) => {
  queue = queue.then(() => processRequest(request));
});
