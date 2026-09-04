import { describe, it, expect, vi, afterEach } from "vitest";

afterEach(async () => {
  const { clearTransformersImportError } = await import(
    "./fixtures/transformers-import-error.js"
  );
  clearTransformersImportError();
  vi.doUnmock("@huggingface/transformers");
  vi.resetModules();
});

describe("ClipEmbeddingProvider (package unavailable)", () => {
  it("throws clean install hint when @huggingface/transformers is missing", async () => {
    vi.doMock("@huggingface/transformers");
    vi.resetModules();
    const { ClipEmbeddingProvider: Fresh } = await import(
      "../src/providers/embedding/clip.js"
    );
    await expect(new Fresh().embed("hello")).rejects.toThrow(
      "Install @huggingface/transformers for CLIP embeddings",
    );
  });
});

describe("ClipEmbeddingProvider (with loaded pipeline)", () => {
  function mockSuccessModule() {
    let lastBatchSize = 1;
    const projectedTextVector = Array.from({ length: 512 }, (_, index) =>
      index === 0 ? 3 : index === 1 ? 4 : 0
    );
    const projectedImageVector = Array.from({ length: 512 }, (_, index) =>
      index === 0 ? 3 : index === 1 ? 4 : 0
    );
    const tokenizerResult = { input_ids: [[1, 2, 3]], attention_mask: [[1, 1, 1]] };
    const textModel = vi.fn(async () => ({
      text_embeds: {
        tolist: () => Array.from({ length: lastBatchSize }, () => projectedTextVector),
      },
    }));
    const tokenizer = vi.fn((texts: string[]) => {
      lastBatchSize = texts.length;
      return tokenizerResult;
    });
    const fromPretrainedText = vi.fn(async () => textModel);
    const fromPretrainedTokenizer = vi.fn(async () => tokenizer);
    const imageExtractor = vi.fn(async () => ({
      tolist: () => [projectedImageVector],
      data: new Float32Array(projectedImageVector),
    }));
    const fromBlob = vi.fn(async () => ({}));
    const pipeline = vi.fn((task: string) => {
      if (task === "image-feature-extraction") return Promise.resolve(imageExtractor);
      if (task === "feature-extraction") {
        return Promise.reject(new Error("Missing required input: pixel_values"));
      }
      return Promise.reject(new Error(`unmocked task: ${task}`));
    });
    vi.doMock("@huggingface/transformers", () => ({
      pipeline,
      AutoTokenizer: { from_pretrained: fromPretrainedTokenizer },
      CLIPTextModelWithProjection: { from_pretrained: fromPretrainedText },
      RawImage: { fromBlob },
    }));
    vi.resetModules();
    return {
      pipeline,
      textModel,
      tokenizer,
      tokenizerResult,
      fromPretrainedText,
      fromPretrainedTokenizer,
      imageExtractor,
      fromBlob,
    };
  }

  it("uses the projected CLIP text tower instead of the pixel-requiring generic pipeline", async () => {
    const { pipeline, fromPretrainedText, fromPretrainedTokenizer } = mockSuccessModule();
    const { ClipEmbeddingProvider: Fresh } = await import(
      "../src/providers/embedding/clip.js"
    );
    const vec = await new Fresh().embed("dashboard user interface");

    expect(fromPretrainedTokenizer).toHaveBeenCalledWith(
      "Xenova/clip-vit-base-patch32",
    );
    expect(fromPretrainedText).toHaveBeenCalledWith(
      "Xenova/clip-vit-base-patch32",
      { dtype: "q8" },
    );
    expect(pipeline).not.toHaveBeenCalledWith(
      "feature-extraction",
      expect.anything(),
      expect.anything(),
    );
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec).toHaveLength(512);
    expect(Math.sqrt(vec.reduce((sum, value) => sum + value * value, 0))).toBeCloseTo(1, 6);
  });

  it("passes the exact tokenizer result to the model and returns 512 dimensions per input", async () => {
    const { textModel, tokenizer, tokenizerResult } = mockSuccessModule();
    const { ClipEmbeddingProvider: Fresh } = await import(
      "../src/providers/embedding/clip.js"
    );
    const vecs = await new Fresh().embedBatch(["a", "b"]);

    expect(tokenizer).toHaveBeenCalledWith(["a", "b"], {
      padding: true,
      truncation: true,
    });
    expect(textModel).toHaveBeenCalledWith(tokenizerResult);
    expect(vecs).toHaveLength(2);
    for (const v of vecs) {
      expect(v).toBeInstanceOf(Float32Array);
      expect(v).toHaveLength(512);
    }
  });

  it("embedImage loads image pipeline with dtype: q8 and decodes data: URL", async () => {
    const { pipeline, fromBlob } = mockSuccessModule();
    const { ClipEmbeddingProvider: Fresh } = await import(
      "../src/providers/embedding/clip.js"
    );
    const vec = await new Fresh().embedImage("data:image/png;base64,AAAA");

    expect(pipeline).toHaveBeenCalledWith(
      "image-feature-extraction",
      "Xenova/clip-vit-base-patch32",
      { dtype: "q8" },
    );
    expect(fromBlob).toHaveBeenCalled();
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec).toHaveLength(512);
  });

  it("accepts custom model ID via constructor", async () => {
    const { fromPretrainedText, fromPretrainedTokenizer } = mockSuccessModule();
    const { ClipEmbeddingProvider: Fresh } = await import(
      "../src/providers/embedding/clip.js"
    );
    await new Fresh("Xenova/clip-vit-large-patch14").embed("hello");

    expect(fromPretrainedTokenizer).toHaveBeenCalledWith(
      "Xenova/clip-vit-large-patch14",
    );
    expect(fromPretrainedText).toHaveBeenCalledWith(
      "Xenova/clip-vit-large-patch14",
      { dtype: "q8" },
    );
  });

  it("caches the text tower across calls", async () => {
    const { fromPretrainedText, fromPretrainedTokenizer } = mockSuccessModule();
    const { ClipEmbeddingProvider: Fresh } = await import(
      "../src/providers/embedding/clip.js"
    );
    const provider = new Fresh();
    await provider.embed("hello");
    await provider.embed("world");
    await provider.embedBatch(["a", "b"]);

    expect(fromPretrainedTokenizer).toHaveBeenCalledTimes(1);
    expect(fromPretrainedText).toHaveBeenCalledTimes(1);
  });

  it("keeps projected text and image vectors normalized in exactly 512 dimensions", async () => {
    mockSuccessModule();
    const { ClipEmbeddingProvider: Fresh } = await import(
      "../src/providers/embedding/clip.js"
    );
    const provider = new Fresh();
    const text = await provider.embed("a red square");
    const image = await provider.embedImage("data:image/png;base64,AAAA");

    expect(text).toHaveLength(512);
    expect(image).toHaveLength(512);
    const norm = (value: Float32Array) =>
      Math.sqrt(value.reduce((sum, item) => sum + item * item, 0));
    expect(norm(text)).toBeCloseTo(1, 6);
    expect(norm(image)).toBeCloseTo(1, 6);
  });

  it("propagates module-evaluation failures with their original identity", async () => {
    const boom = Object.assign(new Error("wasm backend unavailable"), {
      code: "ERR_DLOPEN_FAILED",
    });
    vi.doMock("@huggingface/transformers");
    vi.resetModules();
    const { setTransformersImportError } = await import(
      "./fixtures/transformers-import-error.js"
    );
    setTransformersImportError(boom);
    const { ClipEmbeddingProvider: Fresh } = await import(
      "../src/providers/embedding/clip.js"
    );

    await expect(new Fresh().embed("hello")).rejects.toBe(boom);
  });
});
