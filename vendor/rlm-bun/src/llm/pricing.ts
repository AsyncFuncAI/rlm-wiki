import { z } from "zod";

/**
 * LLM pricing per 1M tokens (USD).
 * Updated: 2025-06.
 *
 * Prices are { input, output } per 1 million tokens.
 * If a model isn't listed, we fall back to the provider default.
 */

interface PricingEntry {
    input: number;
    output: number;
}

const PRICING: Record<string, PricingEntry> = {
    // ── Gemini ────────────────────────────────────────────────
    "gemini-3.1-pro-preview": { input: 1.25, output: 10.00 },
    "gemini-3-pro-preview": { input: 1.25, output: 10.00 },
    "gemini-2.5-pro-preview": { input: 1.25, output: 10.00 },
    "gemini-2.5-pro": { input: 1.25, output: 10.00 },
    "gemini-3.1-flash-preview": { input: 0.30, output: 2.50 },
    "gemini-2.5-flash-preview": { input: 0.15, output: 0.60 },
    "gemini-2.5-flash": { input: 0.15, output: 0.60 },
    "gemini-2.0-flash": { input: 0.10, output: 0.40 },

    // ── Anthropic ─────────────────────────────────────────────
    "claude-opus-4-6": { input: 5.00, output: 25.00 },
    "claude-opus-4-7": { input: 3.00, output: 15.00 },
    "claude-sonnet-4-20250514": { input: 3.00, output: 15.00 },
    "claude-opus-4-20250514": { input: 15.00, output: 75.00 },
    "claude-3-5-sonnet-20241022": { input: 3.00, output: 15.00 },
    "claude-3-5-haiku-20241022": { input: 0.80, output: 4.00 },
    "claude-3-haiku-20240307": { input: 0.25, output: 1.25 },

    // ── OpenAI ────────────────────────────────────────────────
    "gpt-5.2": { input: 2.00, output: 8.00 },
    "gpt-5.1": { input: 2.00, output: 8.00 },
    "gpt-4.1": { input: 2.00, output: 8.00 },
    "gpt-4.1-mini": { input: 0.40, output: 1.60 },
    "gpt-4.1-nano": { input: 0.10, output: 0.40 },
    "gpt-4o": { input: 2.50, output: 10.00 },
    "gpt-4o-mini": { input: 0.15, output: 0.60 },
    "o3": { input: 10.00, output: 40.00 },
    "o3-mini": { input: 1.10, output: 4.40 },
    "o4-mini": { input: 1.10, output: 4.40 },
};

/** Provider-level defaults for unknown models */
const PROVIDER_DEFAULTS: Record<string, PricingEntry> = {
    gemini: { input: 0.30, output: 2.50 },
    anthropic: { input: 3.00, output: 15.00 },
    openai: { input: 2.00, output: 8.00 },
};

/** Zod schema for token usage input */
const TokenUsageSchema = z.object({
    promptTokens: z.number(),
    completionTokens: z.number(),
});
type TokenUsage = z.infer<typeof TokenUsageSchema>;

export interface CostResult {
    inputCost: number;
    outputCost: number;
    totalCost: number;
}

/**
 * Calculate USD cost from token usage.
 */
export function calculateCost(usage: TokenUsage, model: string, provider?: string): CostResult {
    const validated = TokenUsageSchema.parse(usage);
    const pricing = PRICING[model]
        || (provider && PROVIDER_DEFAULTS[provider])
        || PROVIDER_DEFAULTS.openai;

    const inputCost = (validated.promptTokens / 1_000_000) * pricing.input;
    const outputCost = (validated.completionTokens / 1_000_000) * pricing.output;

    return {
        inputCost: Math.round(inputCost * 10000) / 10000,
        outputCost: Math.round(outputCost * 10000) / 10000,
        totalCost: Math.round((inputCost + outputCost) * 10000) / 10000,
    };
}

/**
 * Format cost as a human-readable USD string.
 */
export function formatCost(cost: number): string {
    if (cost < 0.01) return `$${cost.toFixed(4)}`;
    return `$${cost.toFixed(2)}`;
}


