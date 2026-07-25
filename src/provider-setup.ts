import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { jcodeBinary } from "./jcode-errors.ts";

export interface ProviderSetupInfo {
  provider: string;
  loginProvider: string;
  label: string;
  buttonLabel: string;
  message: string;
  detail: string;
}

const PROVIDER_SETUP: Record<string, Omit<ProviderSetupInfo, "provider">> = {
  gemini: {
    loginProvider: "gemini",
    label: "Gemini",
    buttonLabel: "Connect Gemini",
    message: "Gemini needs a one-time connection before this model can run.",
    detail: "A setup window will open so you can approve the local Gemini login.",
  },
  openrouter: {
    loginProvider: "openrouter",
    label: "OpenRouter",
    buttonLabel: "Connect OpenRouter",
    message: "OpenRouter needs a one-time connection before this model can run.",
    detail: "A setup window will open so you can connect OpenRouter.",
  },
  deepseek: {
    loginProvider: "deepseek",
    label: "DeepSeek",
    buttonLabel: "Connect DeepSeek",
    message: "DeepSeek needs a one-time connection before this model can run.",
    detail: "A setup window will open so you can connect DeepSeek.",
  },
  minimax: {
    loginProvider: "minimax",
    label: "MiniMax",
    buttonLabel: "Connect MiniMax",
    message: "MiniMax needs a one-time connection before this model can run.",
    detail: "A setup window will open so you can connect MiniMax.",
  },
  anthropic: {
    loginProvider: "claude",
    label: "Claude",
    buttonLabel: "Connect Claude",
    message: "Claude needs a one-time connection before this model can run.",
    detail: "A setup window will open so you can connect Claude.",
  },
  codex: {
    loginProvider: "openai",
    label: "OpenAI",
    buttonLabel: "Connect OpenAI",
    message: "OpenAI needs a one-time connection before this model can run.",
    detail: "A setup window will open so you can connect OpenAI.",
  },
};

export function providerSetupInfo(provider: string): ProviderSetupInfo | null {
  const key = normalizeSetupProvider(provider);
  const info = PROVIDER_SETUP[key];
  return info ? { provider: key, ...info } : null;
}

export async function startProviderSetup(provider: string): Promise<{ ok: true; setup: ProviderSetupInfo; mode: string }> {
  const setup = providerSetupInfo(provider);
  if (!setup) throw new Error("This provider does not have an in-app setup flow yet.");

  if (platform() !== "darwin") {
    throw new Error(`${setup.label} setup needs an interactive terminal on this system.`);
  }

  const dir = mkdtempSync(join(tmpdir(), "rlm-wiki-provider-setup-"));
  const scriptPath = join(dir, `connect-${setup.provider}.zsh`);
  writeFileSync(scriptPath, setupScript(setup), "utf8");
  chmodSync(scriptPath, 0o700);

  const terminalCommand = `zsh ${shellQuote(scriptPath)}`;
  const appleScript = [
    'tell application "Terminal"',
    "activate",
    `do script ${appleScriptString(terminalCommand)}`,
    "end tell",
  ].join("\n");

  const proc = Bun.spawn(["/usr/bin/osascript", "-e", appleScript], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || "Could not open the provider setup window.");
  }

  return { ok: true, setup, mode: "terminal" };
}

function setupScript(setup: ProviderSetupInfo): string {
  return `#!/bin/zsh
clear
echo "Connect ${setup.label}"
echo
echo "This window handles the one-time provider authorization."
echo "When it finishes, return to the app and retry your request."
echo
login_output=$(${shellQuote(jcodeBinary())} login --provider ${shellQuote(setup.loginProvider)} 2>&1)
setup_exit_code=$?
print -r -- "$login_output"
echo
if [ "$setup_exit_code" -eq 0 ]; then
  echo "${setup.label} is connected. You can close this window and return to the app."
else
  echo "${setup.label} did not connect."
  if print -r -- "$login_output" | grep -qi "rate_limit"; then
    echo "The provider rate-limited the token exchange. Wait a few minutes, then click ${setup.buttonLabel} again."
  else
    echo "Return to the app and click ${setup.buttonLabel} to try again."
  fi
fi
echo
read -k 1 "?Press any key to close this window."
exit "$setup_exit_code"
`;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function normalizeSetupProvider(provider: string): string {
  const key = provider.trim().toLowerCase();
  if (key === "claude") return "anthropic";
  if (key === "openai") return "codex";
  return key;
}
