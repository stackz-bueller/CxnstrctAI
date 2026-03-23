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
type InferenceSession = InstanceType<OrtModule["InferenceSession"]>;

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

export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const sess = await getSession();
  const ortLocal = ort!;

  const results: number[][] = [];
  for (const text of texts) {
    const { inputIds, attentionMask, tokenTypeIds } = tokenize(text.slice(0, 1000));
    const len = inputIds.length;

    const feed = {
      input_ids: new ortLocal.Tensor("int64", BigInt64Array.from(inputIds), [1, len]),
      attention_mask: new ortLocal.Tensor("int64", BigInt64Array.from(attentionMask), [1, len]),
      token_type_ids: new ortLocal.Tensor("int64", BigInt64Array.from(tokenTypeIds), [1, len]),
    };
    const out = await sess.run(feed);
    const hidden = out["last_hidden_state"].data as Float32Array;
    results.push(meanPool(hidden, attentionMask, len));
  }
  return results;
}
