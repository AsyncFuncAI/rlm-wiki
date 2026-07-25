import { spawn, execSync } from "node:child_process";
import { LspClient } from "./client.ts";

interface LanguageServerEntry {
  cmd: string[];
  npmPkg: string | null;
}

/**
 * Language server registry.
 * cmd: command + args to start the server
 * npmPkg: npm package for auto-install (null = system install required)
 */
const LANGUAGE_MAP: Record<string, LanguageServerEntry> = {
  // ── Web / JS ──────────────────────────────────────────
  ".js": { cmd: ["typescript-language-server", "--stdio"], npmPkg: "typescript-language-server" },
  ".ts": { cmd: ["typescript-language-server", "--stdio"], npmPkg: "typescript-language-server" },
  ".jsx": { cmd: ["typescript-language-server", "--stdio"], npmPkg: "typescript-language-server" },
  ".tsx": { cmd: ["typescript-language-server", "--stdio"], npmPkg: "typescript-language-server" },
  ".mjs": { cmd: ["typescript-language-server", "--stdio"], npmPkg: "typescript-language-server" },
  ".cjs": { cmd: ["typescript-language-server", "--stdio"], npmPkg: "typescript-language-server" },
  ".vue": { cmd: ["vue-language-server", "--stdio"], npmPkg: "@vue/language-server" },
  ".svelte": { cmd: ["svelteserver", "--stdio"], npmPkg: "svelte-language-server" },
  ".astro": { cmd: ["astro-ls", "--stdio"], npmPkg: "@astrojs/language-server" },
  ".css": { cmd: ["css-languageserver", "--stdio"], npmPkg: "vscode-css-languageserver-bin" },
  ".html": { cmd: ["html-languageserver", "--stdio"], npmPkg: "vscode-html-languageserver-bin" },
  ".json": { cmd: ["vscode-json-languageserver", "--stdio"], npmPkg: "vscode-json-languageserver" },

  // ── Systems / Compiled ────────────────────────────────
  ".rs": { cmd: ["rust-analyzer"], npmPkg: null },
  ".go": { cmd: ["gopls"], npmPkg: null },
  ".c": { cmd: ["clangd"], npmPkg: null },
  ".cpp": { cmd: ["clangd"], npmPkg: null },
  ".cc": { cmd: ["clangd"], npmPkg: null },
  ".h": { cmd: ["clangd"], npmPkg: null },
  ".hpp": { cmd: ["clangd"], npmPkg: null },
  ".zig": { cmd: ["zls"], npmPkg: null },
  ".dart": { cmd: ["dart", "language-server"], npmPkg: null },

  // ── Backend / Scripting ───────────────────────────────
  ".py": { cmd: ["pyright-langserver", "--stdio"], npmPkg: "pyright" },
  ".rb": { cmd: ["solargraph", "stdio"], npmPkg: null },
  ".php": { cmd: ["intelephense", "--stdio"], npmPkg: "intelephense" },
  ".java": { cmd: ["jdtls"], npmPkg: null },
  ".cs": { cmd: ["csharp-ls"], npmPkg: null },
  ".ex": { cmd: ["elixir-ls"], npmPkg: null },
  ".exs": { cmd: ["elixir-ls"], npmPkg: null },
  ".clj": { cmd: ["clojure-lsp"], npmPkg: null },
  ".hs": { cmd: ["haskell-language-server-wrapper", "--lsp"], npmPkg: null },
  ".ml": { cmd: ["ocamllsp"], npmPkg: null },
  ".gleam": { cmd: ["gleam", "lsp"], npmPkg: null },
  ".jl": { cmd: ["julia", "--project=@.", "-e", "using LanguageServer; runserver()"], npmPkg: null },
  ".lua": { cmd: ["lua-language-server"], npmPkg: null },

  // ── Infra / Config ────────────────────────────────────
  ".tf": { cmd: ["terraform-ls", "serve"], npmPkg: null },
  ".sh": { cmd: ["bash-language-server", "start"], npmPkg: "bash-language-server" },
  ".bash": { cmd: ["bash-language-server", "start"], npmPkg: "bash-language-server" },
  ".zsh": { cmd: ["bash-language-server", "start"], npmPkg: "bash-language-server" },
  ".yaml": { cmd: ["yaml-language-server", "--stdio"], npmPkg: "yaml-language-server" },
  ".yml": { cmd: ["yaml-language-server", "--stdio"], npmPkg: "yaml-language-server" },
  ".toml": { cmd: ["taplo", "lsp", "stdio"], npmPkg: null },
  ".nix": { cmd: ["nil"], npmPkg: null },
  ".dockerfile": { cmd: ["docker-langserver", "--stdio"], npmPkg: "dockerfile-language-server-nodejs" },

  // ── Markup / Other ────────────────────────────────────
  ".md": { cmd: ["marksman"], npmPkg: null },
  ".tex": { cmd: ["texlab"], npmPkg: null },
  ".typ": { cmd: ["typst-lsp"], npmPkg: null },
};

// Also match Dockerfile without extension
const FILENAME_MAP: Record<string, LanguageServerEntry | undefined> = {
  "Dockerfile": LANGUAGE_MAP[".dockerfile"],
};

const servers: Map<string, LspClient> = new Map();

/**
 * Get or create an LSP client for a file.
 * Auto-installs npm-available servers on first use.
 */
export async function getServerForFile(filePath: string, workspaceRoot: string): Promise<LspClient> {
  const ext = filePath.slice(filePath.lastIndexOf("."));
  const basename = filePath.slice(filePath.lastIndexOf("/") + 1);
  const entry = LANGUAGE_MAP[ext] || FILENAME_MAP[basename];

  if (!entry) {
    const supported = [...new Set(Object.keys(LANGUAGE_MAP))].sort().join(", ");
    throw new Error(`No LSP server for "${ext}". Supported: ${supported}`);
  }

  const serverKey = `${workspaceRoot}:${ext}`;
  if (servers.has(serverKey)) return servers.get(serverKey)!;

  let proc;
  try {
    console.log(`[LSP] Starting ${entry.cmd.join(" ")} for ${workspaceRoot}`);
    proc = spawn("bunx", entry.cmd, {
      cwd: workspaceRoot,
      stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT" && entry.npmPkg) {
      console.log(`[LSP] Auto-installing ${entry.npmPkg}...`);
      try {
        execSync(`bun add -d ${entry.npmPkg}`, {
          cwd: workspaceRoot,
          stdio: "pipe",
          timeout: 60_000,
        });
      } catch (installErr) {
        throw new Error(`Failed to auto-install ${entry.npmPkg}: ${(installErr as Error).message}`);
      }
      proc = spawn("bunx", entry.cmd, {
        cwd: workspaceRoot,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } else {
      const hint = entry.npmPkg
        ? `Try: bun add -d ${entry.npmPkg}`
        : `Install ${entry.cmd[0]} manually for your platform`;
      throw new Error(`LSP server not found: ${entry.cmd[0]}. ${hint}`);
    }
  }

  proc.on("error", async (err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT" && entry.npmPkg) {
      console.log(`[LSP] Auto-installing ${entry.npmPkg}...`);
      try {
        execSync(`bun add -d ${entry.npmPkg}`, {
          cwd: workspaceRoot,
          stdio: "pipe",
          timeout: 60_000,
        });
        console.log(`[LSP] Installed ${entry.npmPkg}. Restart to use LSP.`);
      } catch (installErr) {
        console.error(`[LSP] Failed to install ${entry.npmPkg}: ${(installErr as Error).message}`);
      }
    }
  });

  proc.stderr?.on('data', () => { }); // Silence stderr

  const client = new LspClient(proc);

  await client.send("initialize", {
    processId: null,
    rootUri: `file://${workspaceRoot}`,
    capabilities: {}
  });

  client.notify("initialized", {});

  servers.set(serverKey, client);
  return client;
}

