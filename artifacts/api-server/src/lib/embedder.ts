import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const _require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const EMBED_DIM = 384;
const MAX_LEN = 128;
const MODEL_DIR = path.join(__dirname, "..", "models");

// ── Minimal BERT WordPiece tokenizer ────────────────────────────────────────
interface TokenizerData {
  model: { vocab: Record<string, number> };
}

let vocab: Record<string, number> | null = null;
let idToToken: string[] | null = null;

function loadVocab() {
  if (vocab) return;
  const raw = readFileSync(path.join(MODEL_DIR, "tokenizer.json"), "utf8");
  const data: TokenizerData = JSON.parse(raw);
  vocab = data.model.vocab;
  idToToken = Object.keys(vocab).sort((a, b) => vocab![a] - vocab![b]);
}

function wordPiece(word: string): number[] {
  const v = vocab!;
  if (word in v) return [v[word]];
  const ids: number[] = [];
  let start = 0;
  while (start < word.length) {
    let end = word.length;
    let found = -1;
    while (start < end) {
      const sub = (start === 0 ? "" : "##") + word.slice(start, end);
      if (sub in v) { found = v[sub]; break; }
      end--;
    }
    if (found === -1) return [v["[UNK]"] ?? 100];
    ids.push(found);
    start = end;
  }
  return ids;
}

function basicTokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, (ch) => ` ${ch} `)
    .split(/\s+/)
    .filter(Boolean);
}

function tokenize(text: string): { inputIds: bigint[]; attentionMask: bigint[]; tokenTypeIds: bigint[] } {
  loadVocab();
  const v = vocab!;
  const CLS = BigInt(v["[CLS]"] ?? 101);
  const SEP = BigInt(v["[SEP]"] ?? 102);
  const PAD = BigInt(v["[PAD]"] ?? 0);

  const wordTokens = basicTokenize(text);
  const rawIds: number[] = [];
  for (const word of wordTokens) {
    rawIds.push(...wordPiece(word));
    if (rawIds.length >= MAX_LEN - 2) break;
  }
  const truncated = rawIds.slice(0, MAX_LEN - 2).map(BigInt);
  const seq = [CLS, ...truncated, SEP];
  const padLen = MAX_LEN - seq.length;
  const inputIds = [...seq, ...Array(padLen).fill(PAD)];
  const attentionMask = [...Array(seq.length).fill(1n), ...Array(padLen).fill(0n)];
  const tokenTypeIds = Array(MAX_LEN).fill(0n);

  return {
    inputIds: inputIds as bigint[],
    attentionMask: attentionMask as bigint[],
    tokenTypeIds: tokenTypeIds as bigint[],
  };
}

// ── ONNX inference ───────────────────────────────────────────────────────────
type OrtModule = typeof import("onnxruntime-node");
type InferenceSession = import("onnxruntime-node").InferenceSession;

let ort: OrtModule | null = null;
let session: InferenceSession | null = null;
let sessionPromise: Promise<InferenceSession> | null = null;

async function getSession(): Promise<InferenceSession> {
  if (session) return session;
  if (sessionPromise) return sessionPromise;

  sessionPromise = (async () => {
    if (!ort) ort = _require("onnxruntime-node") as OrtModule;
    const modelPath = path.join(MODEL_DIR, "model.onnx");
    const s = await ort.InferenceSession.create(modelPath, {
      executionProviders: ["cpu"],
      graphOptimizationLevel: "all",
    });
    session = s;
    return s;
  })();
  return sessionPromise;
}

function meanPool(hidden: Float32Array, mask: bigint[], seqLen: number): number[] {
  const dim = EMBED_DIM;
  const pool = new Float32Array(dim);
  let count = 0;
  for (let t = 0; t < seqLen; t++) {
    if (mask[t] === 0n) continue;
    count++;
    for (let d = 0; d < dim; d++) pool[d] += hidden[t * dim + d];
  }
  if (count === 0) return Array.from(pool);
  for (let d = 0; d < dim; d++) pool[d] /= count;
  let norm = 0;
  for (let d = 0; d < dim; d++) norm += pool[d] * pool[d];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let d = 0; d < dim; d++) pool[d] /= norm;
  return Array.from(pool);
}

const EMBED_BATCH_SIZE = 16;

export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const sess = await getSession();
  const ortLocal = ort!;

  const results: number[][] = [];

  for (let batchStart = 0; batchStart < texts.length; batchStart += EMBED_BATCH_SIZE) {
    const batchTexts = texts.slice(batchStart, batchStart + EMBED_BATCH_SIZE);
    const batchSize = batchTexts.length;

    const allInputIds = new BigInt64Array(batchSize * MAX_LEN);
    const allAttentionMask = new BigInt64Array(batchSize * MAX_LEN);
    const allTokenTypeIds = new BigInt64Array(batchSize * MAX_LEN);
    const masks: bigint[][] = [];

    for (let i = 0; i < batchTexts.length; i++) {
      const { inputIds, attentionMask, tokenTypeIds } = tokenize(batchTexts[i].slice(0, 1000));
      const offset = i * MAX_LEN;
      for (let j = 0; j < MAX_LEN; j++) {
        allInputIds[offset + j] = inputIds[j];
        allAttentionMask[offset + j] = attentionMask[j];
        allTokenTypeIds[offset + j] = tokenTypeIds[j];
      }
      masks.push(attentionMask);
    }

    const feed = {
      input_ids: new ortLocal.Tensor("int64", allInputIds, [batchSize, MAX_LEN]),
      attention_mask: new ortLocal.Tensor("int64", allAttentionMask, [batchSize, MAX_LEN]),
      token_type_ids: new ortLocal.Tensor("int64", allTokenTypeIds, [batchSize, MAX_LEN]),
    };
    const out = await sess.run(feed);
    const hidden = out["last_hidden_state"].data as Float32Array;

    for (let i = 0; i < batchSize; i++) {
      const seqOffset = i * MAX_LEN * EMBED_DIM;
      const seqHidden = hidden.subarray(seqOffset, seqOffset + MAX_LEN * EMBED_DIM);
      results.push(meanPool(seqHidden, masks[i], MAX_LEN));
    }
  }

  return results;
}
