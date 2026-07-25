export interface JCodeFailureDetails {
  message: string;
  code?: string;
  provider?: string;
  command?: string;
  sourcePath?: string;
}

export function jcodeBinary(): string {
  return process.env.RLM_WIKI_JCODE_BIN?.trim() || process.env.JCODE_BIN?.trim() || "jcode";
}

export function jcodeLoginCommand(provider: string, bin = jcodeBinary()): string {
  return `${shellQuote(bin)} login --provider ${provider}`;
}

export function formatJCodeFailure(opts: {
  exitCode: number;
  stderr: string;
  stdout: string;
  providerArg?: string;
  bin?: string;
}): JCodeFailureDetails {
  const raw = [opts.stderr.trim(), opts.stdout.trim()].filter(Boolean).join("\n").trim();
  const auth = classifyJCodeAuthFailure(raw, opts.providerArg, opts.bin);
  if (auth) return auth;

  return {
    message: [
      `The local agent exited with code ${opts.exitCode}.`,
      raw,
    ].filter(Boolean).join("\n"),
  };
}

function classifyJCodeAuthFailure(raw: string, providerArg?: string, bin = jcodeBinary()): JCodeFailureDetails | null {
  const blocked = raw.match(/Found existing\s+(.+?)\s+credentials from\s+(.+?)\s+at\s+(.+?)\s+but jcode will not read them without confirmation\./i);
  const loginHint = raw.match(/jcode\s+login\s+--provider\s+([a-z0-9_-]+)/i);
  if (blocked) {
    const provider = normalizeProviderId(loginHint?.[1] || providerArg || blocked[1]);
    const command = jcodeLoginCommand(provider, bin);
    const providerLabel = displayProvider(provider, blocked[1]);
    const sourceName = blocked[2].trim();
    const sourcePath = blocked[3].trim();
    return {
      code: "JCODE_AUTH_CONFIRMATION_REQUIRED",
      provider,
      command,
      sourcePath,
      message: [
        `${providerLabel} needs a one-time connection before this run can continue.`,
        `We found an existing ${sourceName} login on this computer, but the app needs your approval before using it.`,
        "",
        "Fix:",
        `1. Click Connect ${providerLabel} in the model picker or setup prompt.`,
        "2. Complete the approval window, then retry this request.",
        "",
        "Nothing in the repo was changed by the failed run.",
      ].join("\n"),
    };
  }

  if (loginHint && /auth|login|credential|not configured|authenticate/i.test(raw)) {
    const provider = normalizeProviderId(loginHint[1]);
    const command = jcodeLoginCommand(provider, bin);
    return {
      code: "JCODE_AUTH_REQUIRED",
      provider,
      command,
      message: [
        `${displayProvider(provider)} needs a one-time connection before this run can continue.`,
        "",
        "Fix:",
        `1. Click Connect ${displayProvider(provider)} in the model picker or setup prompt.`,
        "2. Complete the login window, then retry this request.",
      ].join("\n"),
    };
  }

  return null;
}

function normalizeProviderId(value: string): string {
  const lower = value.trim().toLowerCase();
  if (lower.includes("gemini")) return "gemini";
  if (lower.includes("claude") || lower.includes("anthropic")) return "claude";
  if (lower.includes("openai") || lower.includes("codex")) return "openai";
  if (lower.includes("openrouter")) return "openrouter";
  if (lower.includes("minimax")) return "minimax";
  if (lower.includes("deepseek")) return "deepseek";
  return lower.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "auto";
}

function displayProvider(provider: string, fallback?: string): string {
  if (provider === "gemini") return "Gemini";
  if (provider === "claude") return "Claude";
  if (provider === "openai") return "OpenAI";
  if (provider === "openrouter") return "OpenRouter";
  if (provider === "minimax") return "MiniMax";
  if (provider === "deepseek") return "DeepSeek";
  return fallback?.trim() || provider;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
