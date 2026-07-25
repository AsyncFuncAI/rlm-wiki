import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function versionScore(version: string): number[] {
  return version
    .replace(/^v/, "")
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
}

function compareNodeVersionDesc(a: string, b: string): number {
  const av = versionScore(a);
  const bv = versionScore(b);
  for (let i = 0; i < Math.max(av.length, bv.length); i += 1) {
    const delta = (bv[i] || 0) - (av[i] || 0);
    if (delta !== 0) return delta;
  }
  return b.localeCompare(a);
}

function addIfNodeBin(dirs: string[], dir: string | undefined): void {
  if (!dir) return;
  if (existsSync(join(dir, "node"))) dirs.push(dir);
}

function codexNodeBinDirs(env: NodeJS.ProcessEnv): string[] {
  const dirs: string[] = [];
  const explicit = env.RLM_WIKI_CODEX_NODE_BIN || env.RLM_CODEX_NODE_BIN;
  if (explicit) {
    addIfNodeBin(dirs, explicit.endsWith("/bin") ? explicit : join(explicit, "bin"));
  }

  const home = env.HOME;
  if (!home) return unique(dirs);

  const nvmVersions = join(env.NVM_DIR || join(home, ".nvm"), "versions", "node");
  if (existsSync(nvmVersions)) {
    for (const version of readdirSync(nvmVersions).sort(compareNodeVersionDesc)) {
      addIfNodeBin(dirs, join(nvmVersions, version, "bin"));
    }
  }

  addIfNodeBin(dirs, join(home, ".volta", "bin"));

  const fnmVersions = join(home, ".fnm", "node-versions");
  if (existsSync(fnmVersions)) {
    for (const version of readdirSync(fnmVersions).sort(compareNodeVersionDesc)) {
      addIfNodeBin(dirs, join(fnmVersions, version, "installation", "bin"));
    }
  }
  const localShareFnmVersions = join(home, ".local", "share", "fnm", "node-versions");
  if (existsSync(localShareFnmVersions)) {
    for (const version of readdirSync(localShareFnmVersions).sort(compareNodeVersionDesc)) {
      addIfNodeBin(dirs, join(localShareFnmVersions, version, "installation", "bin"));
    }
  }

  return unique(dirs);
}

export function codexCliEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const path = env.PATH || "";
  const prepend = codexNodeBinDirs(env);
  const pathParts = path.split(":").filter(Boolean);
  const codexIndex = pathParts.findIndex((dir) => existsSync(join(dir, "codex")));
  const pathWithNode = codexIndex >= 0
    ? unique([
      ...pathParts.slice(0, codexIndex + 1),
      ...prepend,
      ...pathParts.slice(codexIndex + 1),
    ])
    : unique([...prepend, ...pathParts]);
  return {
    ...env,
    NO_COLOR: "1",
    PATH: pathWithNode.join(":"),
  };
}
