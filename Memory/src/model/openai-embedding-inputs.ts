import { get_encoding } from "tiktoken";

const OPENAI_EMBEDDING_INPUT_TOKEN_BUDGET = 7_500;
const OPENAI_EMBEDDING_BATCH_TOKEN_BUDGET = 290_000;

export interface OpenAiEmbeddingChunk {
  originalIndex: number;
  tokens: number[];
}

export interface OpenAiEmbeddingPlan {
  batches: OpenAiEmbeddingChunk[][];
  chunks: OpenAiEmbeddingChunk[];
  originalCount: number;
}

let encoder: ReturnType<typeof get_encoding> | undefined;

export function planOpenAiEmbeddingInputs(texts: string[], model?: string): OpenAiEmbeddingPlan | null {
  if (!isKnownOpenAiEmbeddingModel(model)) return null;
  encoder ??= get_encoding("cl100k_base");
  const encoded = texts.map((text) => Array.from(encoder!.encode(text, [], [])));
  const totalTokens = encoded.reduce((sum, tokens) => sum + tokens.length, 0);
  if (totalTokens <= OPENAI_EMBEDDING_BATCH_TOKEN_BUDGET &&
    encoded.every((tokens) => tokens.length <= OPENAI_EMBEDDING_INPUT_TOKEN_BUDGET)) return null;

  const chunks = encoded.flatMap((tokens, originalIndex) => {
    if (tokens.length === 0) return [{ originalIndex, tokens }];
    const items: OpenAiEmbeddingChunk[] = [];
    for (let offset = 0; offset < tokens.length; offset += OPENAI_EMBEDDING_INPUT_TOKEN_BUDGET) {
      items.push({
        originalIndex,
        tokens: tokens.slice(offset, offset + OPENAI_EMBEDDING_INPUT_TOKEN_BUDGET)
      });
    }
    return items;
  });
  return {
    batches: batchChunks(chunks),
    chunks,
    originalCount: texts.length
  };
}

export function aggregateOpenAiEmbeddingVectors(plan: OpenAiEmbeddingPlan, vectors: number[][]): number[][] {
  if (vectors.length !== plan.chunks.length) {
    throw new Error(`openai_compatible returned ${vectors.length} embeddings for ${plan.chunks.length} chunks`);
  }
  return Array.from({ length: plan.originalCount }, (_item, originalIndex) => {
    const entries = plan.chunks
      .map((chunk, index) => ({ chunk, vector: vectors[index]! }))
      .filter((entry) => entry.chunk.originalIndex === originalIndex);
    if (entries.length === 1) return entries[0]!.vector;
    const dimensions = entries[0]?.vector.length ?? 0;
    if (dimensions === 0 || entries.some((entry) => entry.vector.length !== dimensions)) {
      throw new Error("openai_compatible returned incompatible embedding dimensions for chunked input");
    }
    const totalWeight = entries.reduce((sum, entry) => sum + Math.max(1, entry.chunk.tokens.length), 0);
    const mean = Array.from({ length: dimensions }, (_value, dimension) =>
      entries.reduce((sum, entry) =>
        sum + entry.vector[dimension]! * Math.max(1, entry.chunk.tokens.length), 0) / totalWeight
    );
    const norm = Math.hypot(...mean);
    return norm > 0 ? mean.map((value) => value / norm) : mean;
  });
}

function isKnownOpenAiEmbeddingModel(model?: string): boolean {
  return /(?:^|[/.:])text-embedding-(?:3-(?:small|large)|ada-002)(?:$|[/.:])/i.test(model?.trim() ?? "");
}

function batchChunks(chunks: OpenAiEmbeddingChunk[]): OpenAiEmbeddingChunk[][] {
  const batches: OpenAiEmbeddingChunk[][] = [];
  let current: OpenAiEmbeddingChunk[] = [];
  let currentTokens = 0;
  for (const chunk of chunks) {
    if (current.length > 0 && currentTokens + chunk.tokens.length > OPENAI_EMBEDDING_BATCH_TOKEN_BUDGET) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(chunk);
    currentTokens += chunk.tokens.length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
