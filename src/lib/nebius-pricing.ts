// Published Token Factory prices (USD per 1M tokens), read from the public catalog
// https://tokenfactory.nebius.com/api/public/models_info on 2026-10-20.
// Used only to turn the token counts Token Factory reports into an estimated cost per run.

export const PRICES_RETRIEVED = "2026-10-20";
export const PRICES_SOURCE = "https://tokenfactory.nebius.com/api/public/models_info";

const PRICES: Record<string, { input: number; output: number }> = {
  "nvidia/nemotron-3_5-lightning": { input: 0.06, output: 0.24 },
  "nvidia/nvidia-nemotron-3-nano-30b-a3b": { input: 0.06, output: 0.24 },
  "nvidia/nemotron-3-super-120b-a12b": { input: 0.3, output: 0.9 },
  "nvidia/nemotron-3.5-super-vl": { input: 0.3, output: 0.9 },
  "nvidia/nemotron-3-ultra-550b-a55b": { input: 1, output: 3 },
};

export function priceOf(model: string): { input: number; output: number } | null {
  return PRICES[model.toLowerCase()] ?? null;
}

/** Estimated USD cost of one call from its measured token counts; null for an unknown model. */
export function estimateCostUsd(model: string, promptTokens?: number, completionTokens?: number): number | null {
  const p = priceOf(model);
  if (!p || (promptTokens == null && completionTokens == null)) return null;
  const usd = ((promptTokens ?? 0) * p.input + (completionTokens ?? 0) * p.output) / 1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}
