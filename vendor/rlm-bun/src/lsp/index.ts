import { getServerForFile } from "./server.ts";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { LspClient } from "./client.ts";

/**
 * Project markers for detecting workspace root.
 * Ordered by specificity — more specific markers first.
 */
const PROJECT_MARKERS: string[] = [
  // JS/TS
  "package.json", "tsconfig.json", "deno.json", "bun.lockb",
  // Rust
  "Cargo.toml",
  // Go
  "go.mod",
  // Python
  "pyproject.toml", "setup.py", "setup.cfg", "requirements.txt",
  // Ruby
  "Gemfile",
  // PHP
  "composer.json",
  // Java
  "pom.xml", "build.gradle",
  // C#
  "*.csproj", "*.sln",
  // Elixir
  "mix.exs",
  // Terraform
  ".terraform",
  // Fallback
  ".git",
];

/**
 * Walk up from a file path to find the nearest project root.
 */
function findNearestRoot(filePath: string, fallback?: string): string {
  let dir = dirname(resolve(filePath));
  const root = "/";

  while (dir !== root) {
    for (const marker of PROJECT_MARKERS) {
      if (marker.startsWith("*")) {
        continue;
      }
      if (existsSync(join(dir, marker))) {
        return dir;
      }
    }
    dir = dirname(dir);
  }

  return fallback || dirname(resolve(filePath));
}

export class LSP {
  static async touchFile(filePath: string, workspaceRoot?: string): Promise<LspClient> {
    const effectiveRoot = workspaceRoot || findNearestRoot(filePath);
    const client = await getServerForFile(filePath, effectiveRoot);
    const content = readFileSync(filePath, "utf-8");
    const uri = `file://${filePath}`;

    if (!client.openFiles.has(filePath)) {
      client.notify("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId: getLanguageId(filePath),
          version: 1,
          text: content
        }
      });
      client.openFiles.add(filePath);
    } else {
      client.notify("textDocument/didChange", {
        textDocument: { uri, version: Date.now() },
        contentChanges: [{ text: content }]
      });
    }

    return client;
  }

  static async goToDefinition(filePath: string, workspaceRoot: string, line: number, character: number): Promise<unknown> {
    const client = await this.touchFile(filePath, workspaceRoot);
    return client.send("textDocument/definition", {
      textDocument: { uri: `file://${filePath}` },
      position: { line: line - 1, character: character - 1 }
    });
  }

  static async findReferences(filePath: string, workspaceRoot: string, line: number, character: number): Promise<unknown> {
    const client = await this.touchFile(filePath, workspaceRoot);
    return client.send("textDocument/references", {
      textDocument: { uri: `file://${filePath}` },
      position: { line: line - 1, character: character - 1 },
      context: { includeDeclaration: true }
    });
  }
}

const LANGUAGE_ID_MAP: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescriptreact',
  '.js': 'javascript', '.jsx': 'javascriptreact',
  '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.c': 'c', '.h': 'c',
  '.cpp': 'cpp', '.cc': 'cpp', '.hpp': 'cpp',
  '.java': 'java',
  '.cs': 'csharp',
  '.rb': 'ruby',
  '.php': 'php',
  '.ex': 'elixir', '.exs': 'elixir',
  '.zig': 'zig',
  '.dart': 'dart',
  '.lua': 'lua',
  '.hs': 'haskell',
  '.ml': 'ocaml',
  '.clj': 'clojure',
  '.gleam': 'gleam',
  '.jl': 'julia',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.astro': 'astro',
  '.sh': 'shellscript', '.bash': 'shellscript', '.zsh': 'shellscript',
  '.yaml': 'yaml', '.yml': 'yaml',
  '.json': 'json',
  '.toml': 'toml',
  '.tf': 'terraform',
  '.nix': 'nix',
  '.css': 'css',
  '.html': 'html',
  '.md': 'markdown',
  '.tex': 'latex',
  '.typ': 'typst',
};

function getLanguageId(filePath: string): string {
  const ext = filePath.slice(filePath.lastIndexOf('.'));
  return LANGUAGE_ID_MAP[ext] || 'plaintext';
}

