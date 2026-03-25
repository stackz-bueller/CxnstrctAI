import { db, costEventsTable } from "@workspace/db";
import { logger } from "./logger";

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "gpt-5.2": { input: 2.50 / 1_000_000, output: 10.00 / 1_000_000 },
  "gpt-4o": { input: 2.50 / 1_000_000, output: 10.00 / 1_000_000 },
  "gpt-4o-mini": { input: 0.15 / 1_000_000, output: 0.60 / 1_000_000 },
  "gpt-4.1": { input: 2.00 / 1_000_000, output: 8.00 / 1_000_000 },
  "gpt-4.1-mini": { input: 0.40 / 1_000_000, output: 1.60 / 1_000_000 },
  "gpt-4.1-nano": { input: 0.10 / 1_000_000, output: 0.40 / 1_000_000 },
  "o3-mini": { input: 1.10 / 1_000_000, output: 4.40 / 1_000_000 },
};

export interface CostTrackingParams {
  category: "ocr_extraction" | "construction_extraction" | "spec_extraction" | "financial_extraction" | "chat" | "embedding";
  operation: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  extractionId?: number;
  projectId?: number;
  documentType?: string;
  fileName?: string;
  pageNumber?: number;
  metadata?: Record<string, unknown>;
}

function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING[model] || MODEL_PRICING["gpt-4o"]!;
  return (inputTokens * pricing.input) + (outputTokens * pricing.output);
}

export async function trackCost(params: CostTrackingParams): Promise<void> {
  try {
    const totalTokens = params.inputTokens + params.outputTokens;
    const estimatedCostUsd = estimateCost(params.model, params.inputTokens, params.outputTokens);

    await db.insert(costEventsTable).values({
      category: params.category,
      operation: params.operation,
      model: params.model,
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      totalTokens,
      estimatedCostUsd,
      extractionId: params.extractionId,
      projectId: params.projectId,
      documentType: params.documentType,
      fileName: params.fileName,
      pageNumber: params.pageNumber,
      metadata: params.metadata,
    });
  } catch (err) {
    logger.error({ err, operation: params.operation }, "Failed to track cost event");
  }
}

export function extractTokenUsage(response: any): { inputTokens: number; outputTokens: number; model: string } {
  const usage = response?.usage;
  return {
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
    model: response?.model ?? "gpt-4o",
  };
}
