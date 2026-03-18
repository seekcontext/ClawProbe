// Model context window sizes.
// Keys are lowercased substrings to match against model identifiers.
// Listed from most-specific to least-specific so the first match wins.
export const MODEL_WINDOWS: [string, number][] = [
  // ── Anthropic ──────────────────────────────────────────────────────────
  ["claude-opus-4",         200_000],
  ["claude-sonnet-4",       200_000],  // covers sonnet-4, sonnet-4.5
  ["claude-haiku-4",        200_000],
  ["claude-3-5-sonnet",     200_000],
  ["claude-3-5-haiku",      200_000],
  ["claude-3-opus",         200_000],
  ["claude-3-sonnet",       200_000],
  ["claude-3-haiku",        200_000],
  ["claude-2",              100_000],
  ["claude-instant",        100_000],
  ["claude",                200_000],  // generic claude fallback

  // ── OpenAI ─────────────────────────────────────────────────────────────
  ["gpt-5.4-mini",          128_000],
  ["gpt-5.4",               128_000],
  ["o4-mini",               128_000],
  ["o4",                    128_000],
  ["o3-mini",               128_000],
  ["o3",                    128_000],
  ["gpt-4o-mini",           128_000],
  ["gpt-4o",                128_000],
  ["gpt-4-turbo",           128_000],
  ["gpt-4",                 128_000],
  ["gpt-3.5",                16_385],

  // ── Google ─────────────────────────────────────────────────────────────
  ["gemini-3.1-flash",    1_000_000],
  ["gemini-3.1-pro",      1_000_000],
  ["gemini-2.0-flash",    1_000_000],
  ["gemini-2.0-pro",      1_000_000],
  ["gemini-1.5-flash",    1_000_000],
  ["gemini-1.5-pro",      1_000_000],
  ["gemini",              1_000_000],  // generic gemini fallback

  // ── DeepSeek ───────────────────────────────────────────────────────────
  ["deepseek-v3.2",         131_000],  // V3.2-exp
  ["deepseek-r2",           128_000],
  ["deepseek-v3",           128_000],
  ["deepseek-r1",           128_000],
  ["deepseek",              128_000],

  // ── Moonshot / Kimi ────────────────────────────────────────────────────
  ["kimi-k2.5",             256_000],
  ["kimi-k2",               256_000],
  ["kimi-vl",               128_000],
  ["kimi",                  128_000],  // generic kimi fallback
  ["moonshot-v1-128k",      128_000],
  ["moonshot-v1-32k",        32_000],
  ["moonshot-v1-8k",          8_000],
  ["moonshot",              128_000],

  // ── Qwen / Alibaba ─────────────────────────────────────────────────────
  ["qwen-long",          10_000_000],
  ["qwen3-coder-plus",    1_000_000],
  ["qwen3-coder",           256_000],
  ["qwen-plus",           1_000_000],
  ["qwen-turbo",          1_000_000],
  ["qwen-flash",          1_000_000],
  ["qwen3-max",             256_000],
  ["qwen3",                 256_000],
  ["qwen2.5",               128_000],
  ["qwen2",                 128_000],
  ["qwen",                  128_000],

  // ── MiniMax ────────────────────────────────────────────────────────────
  ["minimax-text-01",     4_000_000],
  ["minimax-01",          4_000_000],
  ["minimax",             4_000_000],

  // ── Zhipu / GLM ────────────────────────────────────────────────────────
  ["glm-5",                 200_000],
  ["glm-4.7",               200_000],
  ["glm-4.6",               200_000],
  ["glm-4.5",               128_000],
  ["glm-4",                 128_000],
  ["glm",                   128_000],

  // ── ByteDance / Doubao ─────────────────────────────────────────────────
  ["seed-code",             256_000],
  ["seed-2.0",              256_000],
  ["seed",                  256_000],
  ["doubao-pro-128k",       128_000],
  ["doubao-pro-32k",         32_000],
  ["doubao",                128_000],

  // ── Baidu / ERNIE ──────────────────────────────────────────────────────
  ["ernie-5",               128_000],
  ["ernie-4.5",             128_000],
  ["ernie-4",               128_000],
  ["ernie-3.5",             128_000],
  ["ernie",                 128_000],

  // ── Mistral ────────────────────────────────────────────────────────────
  ["mixtral",                32_000],
  ["mistral",                32_000],
];

/**
 * Returns the context window size for a given model identifier.
 * Falls back to the contextTokens value itself if it exceeds all known windows
 * to avoid showing >100% utilization when upstream reports a larger window.
 */
export function getWindowSize(model: string | null, contextTokens = 0): number {
  if (model) {
    const lower = model.toLowerCase();
    const match = MODEL_WINDOWS.find(([key]) => lower.includes(key));
    if (match) {
      return Math.max(match[1], contextTokens);
    }
  }

  return Math.max(200_000, contextTokens);
}
