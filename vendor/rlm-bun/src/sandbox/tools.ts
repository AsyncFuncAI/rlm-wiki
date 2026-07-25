import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "path";
import { createHash, randomUUID } from "crypto";
import { tmpdir } from "os";
import { inspectAbsolutePath, type FileInspection } from "./inspect.ts";
import { scanGlobPaths } from "./glob.ts";

export interface GrepMatch {
  file: string;
  line: number;
  text: string;
}

export interface GitLogEntry {
  hash: string;
  author: string;
  date: string;
  message: string;
}

export interface GrepOpts {
  glob?: string;
  maxResults?: number;
}

export interface BashOpts {
  timeout?: number;
  maxOutput?: number;
}

export interface EditFileOpts {
  replaceAll?: boolean;
  startLine?: number;
}

export interface FileSymbol {
  kind: "class" | "function" | "method" | "variable" | "section";
  name: string;
  startLine: number;
  endLine: number;
  indent: number;
  signature: string;
  parent?: string;
}

export interface ReadFileRangeResult {
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  content: string;
}

export interface EditFileRangeResult {
  path: string;
  startLine: number;
  endLine: number;
  removedLines: number;
  insertedLines: number;
}

export interface ApplyPatchOpts {
  check?: boolean;
  reverse?: boolean;
  whitespace?: "nowarn" | "warn" | "fix" | "error";
}

export interface ApplyPatchResult extends ShellResult {
  applied: boolean;
}

export interface RunnerCandidate {
  kind: "python" | "node" | "go" | "rust" | "ruby" | "generic";
  command: string;
  reason: string;
}

export interface RunAgentOpts {
  timeout?: number;
  maxOutput?: number;
  onOutput?: (event: { stream: "stdout" | "stderr"; chunk: string }) => void;
}

export interface DelegateAgentRequest {
  repo?: string;
  agent?: AgentName;
  taskContract: string;
  allowedFiles?: string[];
  forbiddenFiles?: string[];
  testCommand?: string;
  timeout?: number;
  maxOutput?: number;
  maxTurns?: number;
  maxCost?: number;
  requireDiffOnly?: boolean;
  onOutput?: (event: { stream: "stdout" | "stderr"; chunk: string }) => void;
}

export interface DelegateScopeCheck {
  passed: boolean;
  isClean?: boolean;
  changedFiles: string[];
  violations: string[];
  issues?: string[];
  allowedFiles: string[];
  forbiddenFiles: string[];
}

export interface DelegateAgentResult {
  agent: AgentName;
  isolated: true;
  appliedToMainWorktree: false;
  readyForReview: boolean;
  taskContract: string;
  changedFiles: string[];
  status: string;
  diff: string;
  agentResult: ShellResult;
  testResult?: ShellResult;
  scopeCheck: DelegateScopeCheck;
  notes: string[];
  seededDirtyState?: boolean;
  diffBytes?: number;
}

export interface ExperimentStep {
  name?: string;
  command: string;
  timeout?: number;
  maxOutput?: number;
  expectExitCode?: number;
  mustContain?: string | string[];
  mustNotContain?: string | string[];
}

export interface ExperimentRequest {
  hypothesis?: string;
  plan?: string;
  command?: string;
  steps?: ExperimentStep[];
  timeout?: number;
  maxOutput?: number;
  stopOnFailure?: boolean;
}

export interface RememberRequest {
  action?: "record" | "recall" | "list" | "forget";
  scope?: string;
  claim?: string;
  evidence?: unknown;
  confidence?: number;
  tags?: string[];
  query?: string;
  limit?: number;
  ttlDays?: number;
  id?: string;
}

export interface ForgeToolRequest {
  action?: "draft" | "create" | "list" | "read" | "run" | "delete";
  name?: string;
  goal?: string;
  constraints?: string[] | string;
  code?: string;
  codeLines?: string[];
  codeBase64?: string;
  overwrite?: boolean;
  args?: string[];
  timeout?: number;
  maxOutput?: number;
}

export type AgentName = "claude" | "gemini-cli" | "codex" | "opencode" | "copilot" | "cursor-agent";

export interface RepoTools {
  readFile: (filePath: string) => string;
  readFileRange: (filePath: string, startLine: number, endLine?: number) => ReadFileRangeResult;
  inspect: (filePath: string) => FileInspection;
  listSymbols: (filePath: string) => FileSymbol[];
  glob: (pattern: string) => string[];
  rg: (pattern: string | RegExp, opts?: GrepOpts | string) => GrepMatch[];
  grep: (pattern: string | RegExp, opts?: GrepOpts | string) => GrepMatch[];
  writeFile: (filePath: string, content: string) => { path: string; bytesWritten: number };
  editFileRange: (
    filePath: string,
    startLine: number,
    endLine: number,
    newText: string,
  ) => EditFileRangeResult;
  editFile: (
    filePath: string,
    oldString: string,
    newString: string,
    opts?: EditFileOpts | string,
  ) => { path: string; replacements: number; startLine: number };
  gitLog: (n?: number) => GitLogEntry[];
  gitDiff: (a: string, b?: string) => string;
  gitBlame: (filePath: string) => string;
  gitStatus: () => string;
  gitDiffWorking: (filePath?: string) => string;
  applyPatch: (patch: string, opts?: ApplyPatchOpts | string) => ApplyPatchResult;
  listFiles: () => string[];
  detectRunners: () => RunnerCandidate[];
  bash: (command: string, opts?: BashOpts | string) => Promise<string>;
  experiment: (hypothesisOrRequest: string | ExperimentRequest, planOrRequest?: string | ExperimentRequest) => Promise<unknown>;
  remember: (scopeOrRequest?: string | RememberRequest, claim?: string, evidence?: unknown) => Promise<unknown>;
  forge_tool: (request?: string | ForgeToolRequest, constraints?: string[] | string) => Promise<unknown>;
  run_agent: (agentOrOpts: AgentName | { agent?: AgentName; prompt: string; timeout?: number; maxOutput?: number }, prompt?: string, opts?: RunAgentOpts | string) => Promise<string>;
  delegateAgent: (request: DelegateAgentRequest | string) => Promise<DelegateAgentResult>;
  run_websearch?: (query: string) => Promise<string>;
}

interface ShellResult {
  command: string;
  exitCode: number | null;
  output: string;
  stdout?: string;
  stderr?: string;
  durationMs: number;
  error?: string;
}

interface MemoryRecord {
  id: string;
  createdAt: string;
  expiresAt?: string;
  repoKey: string;
  repoPath: string;
  scope: string;
  claim: string;
  evidence: unknown;
  confidence?: number;
  tags?: string[];
}

interface ForgeMetadata {
  name: string;
  goal: string;
  constraints: string[];
  createdAt: string;
  updatedAt: string;
  repoKey: string;
  path: string;
}

const DEFAULT_MAX_OUTPUT = 50 * 1024;

function parseMaybeJson<T>(value: T | string | undefined, fallback: T): T {
  if (typeof value !== "string") return value ?? fallback;
  return JSON.parse(value) as T;
}

function splitContentLines(content: string): { lines: string[]; finalNewline: boolean } {
  const finalNewline = content.endsWith("\n");
  const lines = content.split("\n");
  if (finalNewline) lines.pop();
  return { lines, finalNewline };
}

function normalizeSearchPattern(pattern: string | RegExp): string {
  if (pattern && typeof pattern === "object" && pattern instanceof RegExp) {
    return pattern.source;
  }
  if (typeof pattern === "object") {
    throw new Error(
      "rg: received an object as pattern (likely a RegExp lost through IPC). " +
      "Pass a string pattern instead, e.g. rg('pattern\\\\s*') not rg(/pattern\\s/)"
    );
  }

  let pat = pattern as string;
  const rxDelim = pat.match(/^\/([^/]+)\/([gimsuy]*)$/);
  if (rxDelim) pat = rxDelim[1];
  if (!pat || typeof pat !== "string") {
    throw new Error(`rg: pattern must be a non-empty string, got ${typeof pat}: ${JSON.stringify(pat)}`);
  }
  return pat;
}

export function runRipgrepSearch(root: string, pattern: string | RegExp, opts?: GrepOpts | string): GrepMatch[] {
  const o: GrepOpts = typeof opts === "string" ? JSON.parse(opts) : opts || {};
  const maxResults = o.maxResults || 100;
  const pat = normalizeSearchPattern(pattern);

  const run = (fixedStrings = false) => {
    const args: string[] = [
      "rg",
      "--json",
      "--no-messages",
      "--color",
      "never",
      "--smart-case",
      "--max-columns",
      "2000",
      "--max-columns-preview",
    ];
    if (fixedStrings) args.push("--fixed-strings");
    args.push("-e", pat);
    if (o.glob) args.push("--glob", o.glob);
    try {
      return Bun.spawnSync(args, {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (error) {
      return {
        exitCode: 127,
        stdout: new Uint8Array(),
        stderr: new TextEncoder().encode(error instanceof Error ? error.message : String(error)),
      };
    }
  };

  let result = run(false);
  let err = new TextDecoder().decode(result.stderr).trim();
  if (result.exitCode !== 0 && result.exitCode !== 1 && (result.exitCode === 2 || /regex parse error|unclosed group|repetition operator missing expression/i.test(err))) {
    result = run(true);
    err = new TextDecoder().decode(result.stderr).trim();
  }

  const finalOut = new TextDecoder().decode(result.stdout).trim();
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    if (/command not found|No such file or directory|ENOENT|Executable not found in \$PATH/i.test(err) || result.exitCode === 127 || result.exitCode === 2) {
      return runJavaScriptSearchFallback(root, pat, o, maxResults);
    }
    throw new Error(`rg failed: ${err || `exit ${result.exitCode}`}`);
  }
  if (!finalOut) return [];

  const matches: GrepMatch[] = [];
  for (const line of finalOut.split("\n")) {
    if (matches.length >= maxResults) break;
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === "match") {
        matches.push({
          file: parsed.data.path.text,
          line: parsed.data.line_number,
          text: parsed.data.lines.text.trim(),
        });
      }
    } catch {
      // Skip malformed lines.
    }
  }
  return matches;
}

function runJavaScriptSearchFallback(root: string, pattern: string, opts: GrepOpts, maxResults: number): GrepMatch[] {
  let rx: RegExp | null = null;
  const flags = /[A-Z]/.test(pattern) ? "" : "i";
  try {
    rx = new RegExp(pattern, flags);
  } catch {
    rx = null;
  }
  const needle = flags.includes("i") ? pattern.toLowerCase() : pattern;
  const files = scanGlobPaths(root, opts.glob || "**/*");
  const matches: GrepMatch[] = [];
  for (const file of files) {
    if (matches.length >= maxResults) break;
    if (file.endsWith("/")) continue;
    const parts = file.split("/");
    if (parts.some((part) => part === ".git" || part === "node_modules" || part === ".DS_Store")) continue;
    let content = "";
    try {
      content = readFileSync(join(root, file), "utf-8");
    } catch {
      continue;
    }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
      const haystack = flags.includes("i") ? lines[i].toLowerCase() : lines[i];
      const matched = rx ? rx.test(lines[i]) : haystack.includes(needle);
      if (matched) {
        matches.push({ file, line: i + 1, text: lines[i].trim() });
      }
      if (rx) rx.lastIndex = 0;
    }
  }
  return matches;
}

function joinContentLines(lines: string[], finalNewline: boolean): string {
  return lines.join("\n") + (finalNewline ? "\n" : "");
}

function lineNumberForIndex(content: string, index: number): number {
  return content.slice(0, Math.max(0, index)).split("\n").length;
}

function findStringOccurrences(content: string, needle: string): Array<{ index: number; line: number }> {
  const occurrences: Array<{ index: number; line: number }> = [];
  let index = content.indexOf(needle);
  while (index >= 0) {
    occurrences.push({ index, line: lineNumberForIndex(content, index) });
    index = content.indexOf(needle, index + needle.length);
  }
  return occurrences;
}

function editFileDiagnostic(input: {
  filePath: string;
  matched: number;
  reason: string;
  matches?: Array<{ line: number }>;
  suggestion: string;
  failureCount?: number;
}): string {
  const failureCount = input.failureCount ?? 1;
  return JSON.stringify({
    matched: input.matched,
    edited: false,
    reason: input.reason,
    suggestion: input.suggestion,
    matches: input.matches ?? [],
    failuresForFile: failureCount,
    requiresTargetRegionPlan: failureCount >= 2,
    filePath: input.filePath,
  });
}

function editFileEscalationSuggestion(baseSuggestion: string, failureCount: number): string {
  if (failureCount < 2) return baseSuggestion;
  return [
    "This is the second editFile failure for this file. Stop retrying anchors.",
    "Before the next edit, compute target regions with class/function name, start line, end line, and insertion/replacement line.",
    baseSuggestion,
  ].join(" ");
}

function detectSymbol(line: string): Omit<FileSymbol, "startLine" | "endLine" | "parent"> | null {
  const indent = line.match(/^\s*/)?.[0].length ?? 0;
  const trimmed = line.trim();
  let match = trimmed.match(/^(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/);
  if (match) return { kind: "class", name: match[1], indent, signature: trimmed };

  match = trimmed.match(/^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/);
  if (match) return { kind: indent > 0 ? "method" : "function", name: match[1], indent, signature: trimmed };

  match = trimmed.match(/^class\s+([A-Za-z_]\w*)\b/);
  if (match) return { kind: "class", name: match[1], indent, signature: trimmed };

  match = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/);
  if (match) return { kind: indent > 0 ? "method" : "function", name: match[1], indent, signature: trimmed };

  match = trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/);
  if (match) return { kind: "function", name: match[1], indent, signature: trimmed };

  match = trimmed.match(/^(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/);
  if (match && !["if", "for", "while", "switch", "catch", "function"].includes(match[1])) {
    return { kind: indent > 0 ? "method" : "function", name: match[1], indent, signature: trimmed };
  }

  match = trimmed.match(/^(?:#{1,6})\s+(.+)$/);
  if (match) return { kind: "section", name: match[1].trim(), indent, signature: trimmed };

  return null;
}

function listFileSymbols(content: string): FileSymbol[] {
  const { lines } = splitContentLines(content);
  const symbols: FileSymbol[] = [];
  for (let index = 0; index < lines.length; index++) {
    const detected = detectSymbol(lines[index]);
    if (!detected) continue;
    symbols.push({
      ...detected,
      startLine: index + 1,
      endLine: lines.length,
    });
  }

  for (let i = 0; i < symbols.length; i++) {
    const current = symbols[i];
    for (let j = i + 1; j < symbols.length; j++) {
      if (symbols[j].indent <= current.indent) {
        current.endLine = symbols[j].startLine - 1;
        break;
      }
    }
    const parent = symbols
      .slice(0, i)
      .reverse()
      .find((candidate) => candidate.indent < current.indent && candidate.endLine >= current.startLine);
    if (parent) current.parent = parent.name;
  }

  return symbols.map((symbol) => ({ ...symbol, signature: symbol.signature.slice(0, 240) }));
}

function dataRoot(): string {
  return resolve(process.env.RLM_TOOL_HOME || join(process.env.HOME || "/tmp", ".rlm"));
}

function repoKey(repoPath: string): string {
  return createHash("sha256").update(resolve(repoPath)).digest("hex").slice(0, 16);
}

function resolveInside(root: string, target: string, label = target): string {
  const abs = resolve(root, target);
  const rel = relative(root, abs);
  if (rel === "" || (rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\") && !isAbsolute(rel))) {
    return abs;
  }
  throw new Error("Path escape blocked: " + label);
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function truncateMiddle(text: string, maxOutput: number): string {
  if (text.length <= maxOutput) return text;
  const half = Math.floor(maxOutput / 2);
  const head = text.slice(0, half);
  const tail = text.slice(-half);
  const dropped = text.length - maxOutput;
  return head + `\n...[truncated ${dropped.toLocaleString()} chars]...\n` + tail;
}

function assertSafeShellCommand(command: string): void {
  if (!command || typeof command !== "string") {
    throw new Error("command must be a non-empty string");
  }

  const blocked: RegExp[] = [
    /\brm\s+(-\w*r\w*f|--no-preserve-root)/i,
    /\bchmod\s+777/,
    /\bdd\s+/,
    /\bmkfs\b/,
    /\bcurl\b.*\|\s*(sh|bash)/,
    /\bwget\b.*\|\s*(sh|bash)/,
    />\s*\/dev\/sd/,
    /\bsudo\b/,
  ];
  for (const re of blocked) {
    if (re.test(command)) {
      throw new Error(`Security block: command matches forbidden pattern ${re}`);
    }
  }
}

async function runShellCommand(repoPath: string, command: string, opts: BashOpts = {}): Promise<ShellResult> {
  assertSafeShellCommand(command);
  const timeoutMs = opts.timeout || 30000;
  const maxOutput = opts.maxOutput || DEFAULT_MAX_OUTPUT;
  const startMs = Date.now();

  try {
    const proc = Bun.spawn(["sh", "-c", command], {
      cwd: repoPath,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: process.env.HOME },
    });

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const timer = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        proc.kill();
        reject(new Error(`command timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    const completion = (async () => {
      const exitCode = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      return { exitCode, stdout, stderr };
    })();

    const { exitCode, stdout, stderr } = await Promise.race([completion, timer]);
    if (timeoutId) clearTimeout(timeoutId);

    let output = stdout || "";
    if (stderr) {
      output += (output ? "\n" : "") + "[stderr]\n" + stderr;
    }
    if (!output) output = "(no output)";

    return {
      command,
      exitCode,
      output: truncateMiddle(output, maxOutput).trim(),
      stdout: truncateMiddle(stdout, maxOutput).trim(),
      stderr: truncateMiddle(stderr, maxOutput).trim(),
      durationMs: Date.now() - startMs,
    };
  } catch (e) {
    const stderr = `bash error: ${(e as Error).message}`;
    return {
      command,
      exitCode: null,
      output: stderr,
      stdout: "",
      stderr,
      durationMs: Date.now() - startMs,
      error: (e as Error).message,
    };
  }
}

function shellResultToString(result: ShellResult): string {
  if (result.exitCode !== 0) {
    const code = result.exitCode == null ? "error" : result.exitCode;
    return `[exit code ${code}]\n${result.output}`;
  }
  return result.output.trim();
}

const VALID_AGENTS: AgentName[] = ["claude", "gemini-cli", "codex", "opencode", "copilot", "cursor-agent"];
const DEFAULT_DELEGATE_FORBIDDEN = [".git/", "node_modules/", "graphify-out/"];
const FULL_DIFF_MAX_OUTPUT = Number.MAX_SAFE_INTEGER;

function uniqueStrings(values: string[]): string[] {
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

function addNodeBinDir(dirs: string[], dir: string | undefined): void {
  if (!dir) return;
  if (existsSync(join(dir, "node"))) dirs.push(dir);
}

function codexNodeBinDirs(env: NodeJS.ProcessEnv): string[] {
  const dirs: string[] = [];
  const explicit = env.RLM_WIKI_CODEX_NODE_BIN || env.RLM_CODEX_NODE_BIN;
  if (explicit) addNodeBinDir(dirs, explicit.endsWith("/bin") ? explicit : join(explicit, "bin"));

  const home = env.HOME;
  if (!home) return uniqueStrings(dirs);

  const nvmVersions = join(env.NVM_DIR || join(home, ".nvm"), "versions", "node");
  if (existsSync(nvmVersions)) {
    for (const version of readdirSync(nvmVersions).sort(compareNodeVersionDesc)) {
      addNodeBinDir(dirs, join(nvmVersions, version, "bin"));
    }
  }

  addNodeBinDir(dirs, join(home, ".volta", "bin"));

  const fnmVersions = join(home, ".fnm", "node-versions");
  if (existsSync(fnmVersions)) {
    for (const version of readdirSync(fnmVersions).sort(compareNodeVersionDesc)) {
      addNodeBinDir(dirs, join(fnmVersions, version, "installation", "bin"));
    }
  }

  return uniqueStrings(dirs);
}

function externalAgentEnv(agent: AgentName): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: process.env.HOME };
  if (agent !== "codex") return env;
  const pathParts = (env.PATH || "").split(":").filter(Boolean);
  const codexIndex = pathParts.findIndex((dir) => existsSync(join(dir, "codex")));
  const nodeDirs = codexNodeBinDirs(env);
  const pathWithNode = codexIndex >= 0
    ? uniqueStrings([
      ...pathParts.slice(0, codexIndex + 1),
      ...nodeDirs,
      ...pathParts.slice(codexIndex + 1),
    ])
    : uniqueStrings([...nodeDirs, ...pathParts]);
  return {
    ...env,
    NO_COLOR: "1",
    PATH: pathWithNode.join(":"),
  };
}

function assertAgentName(agent: AgentName | undefined): AgentName {
  const actual = agent || "claude";
  if (!VALID_AGENTS.includes(actual)) {
    throw new Error(`unknown agent "${actual}". Supported: ${VALID_AGENTS.join(", ")}`);
  }
  return actual;
}

function buildAgentShellCommand(agent: AgentName, tmpFile: string): string {
  if (agent === "claude") {
    return `claude -p --dangerously-skip-permissions "$(cat '${tmpFile}')"`;
  }
  if (agent === "gemini-cli") {
    return `gemini -p "$(cat '${tmpFile}')"`;
  }
  if (agent === "codex") {
    return `codex exec --color never --sandbox workspace-write --skip-git-repo-check --ephemeral --full-auto -c model_reasoning_effort="high" - < '${tmpFile}'`;
  }
  if (agent === "opencode") {
    return `opencode --prompt "$(cat '${tmpFile}')"`;
  }
  if (agent === "copilot") {
    return `copilot -i "$(cat '${tmpFile}')" --yolo`;
  }
  if (agent === "cursor-agent") {
    return `cursor-agent --yolo "$(cat '${tmpFile}')"`;
  }
  return `claude -p --dangerously-skip-permissions "$(cat '${tmpFile}')"`;
}

async function readProcessOutput(
  stream: ReadableStream<Uint8Array> | null,
  name: "stdout" | "stderr",
  onOutput?: RunAgentOpts["onOutput"],
): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    if (!chunk) continue;
    text += chunk;
    try {
      onOutput?.({ stream: name, chunk });
    } catch {
      // Streaming diagnostics should never break the worker process.
    }
  }
  const tail = decoder.decode();
  if (tail) {
    text += tail;
    try {
      onOutput?.({ stream: name, chunk: tail });
    } catch {
      // Streaming diagnostics should never break the worker process.
    }
  }
  return text;
}

async function runExternalAgent(
  cwd: string,
  agent: AgentName,
  prompt: string,
  opts: RunAgentOpts = {},
): Promise<ShellResult> {
  const timeoutMs = opts.timeout || 120_000;
  const maxOutput = opts.maxOutput || 100 * 1024;
  const startMs = Date.now();
  const tmpFile = `/tmp/rlm-agent-${randomUUID()}.txt`;
  await Bun.write(tmpFile, prompt);

  try {
    const proc = Bun.spawn(["sh", "-c", buildAgentShellCommand(agent, tmpFile)], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: externalAgentEnv(agent),
    });

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const timer = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        proc.kill();
        reject(new Error(`run_agent: ${agent} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    const completion = (async () => {
      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        readProcessOutput(proc.stdout, "stdout", opts.onOutput),
        readProcessOutput(proc.stderr, "stderr", opts.onOutput),
      ]);
      return { exitCode, stdout, stderr };
    })();

    const { exitCode, stdout, stderr } = await Promise.race([completion, timer]);
    if (timeoutId) clearTimeout(timeoutId);

    let output = stdout || "";
    if (stderr) {
      output += (output ? "\n" : "") + "[stderr]\n" + stderr;
    }
    if (!output) output = "(no output)";

    return {
      command: `${agent} <bounded-prompt>`,
      exitCode,
      output: truncateMiddle(output, maxOutput).trim(),
      stdout: truncateMiddle(stdout, maxOutput).trim(),
      stderr: truncateMiddle(stderr, maxOutput).trim(),
      durationMs: Date.now() - startMs,
    };
  } catch (e) {
    const stderr = `run_agent error: ${(e as Error).message}`;
    return {
      command: `${agent} <bounded-prompt>`,
      exitCode: null,
      output: stderr,
      stdout: "",
      stderr,
      durationMs: Date.now() - startMs,
      error: (e as Error).message,
    };
  } finally {
    try { unlinkSync(tmpFile); } catch {
      // Ignore cleanup errors.
    }
  }
}

function runGitCommand(cwd: string, args: string[], maxOutput = DEFAULT_MAX_OUTPUT): ShellResult {
  const startMs = Date.now();
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  const output = truncateMiddle((stdout + (stderr ? (stdout ? "\n" : "") + "[stderr]\n" + stderr : "")).trim() || "(no output)", maxOutput);
  return {
    command: `git ${args.join(" ")}`,
    exitCode: result.exitCode,
    output,
    stdout: truncateMiddle(stdout.trim(), maxOutput),
    stderr: truncateMiddle(stderr.trim(), maxOutput),
    durationMs: Date.now() - startMs,
  };
}

function runGitRawStdoutCommand(cwd: string, args: string[]): ShellResult {
  const startMs = Date.now();
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  return {
    command: `git ${args.join(" ")}`,
    exitCode: result.exitCode,
    output: stdout || (result.exitCode !== 0 && stderr ? `[stderr]\n${stderr}` : ""),
    stdout,
    stderr,
    durationMs: Date.now() - startMs,
  };
}

function applyPatchText(cwd: string, patch: string, label: string): ShellResult {
  const tmpRoot = mkdtempSync(join(tmpdir(), "rlm-patch-"));
  const patchPath = join(tmpRoot, `${label}.patch`);
  try {
    writeFileSync(patchPath, patch, "utf-8");
    return runGitCommand(cwd, ["apply", "--whitespace=nowarn", patchPath], FULL_DIFF_MAX_OUTPUT);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function runGitNullList(cwd: string, args: string[]): string[] {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) return [];
  const stdout = new TextDecoder().decode(result.stdout);
  return stdout.split("\0").filter(Boolean).map(normalizePathForScope);
}

function isForbiddenDelegatePath(filePath: string, forbiddenFiles: string[]): boolean {
  return forbiddenFiles.some((pattern) => patternMatchesPath(pattern, filePath));
}

function copyUntrackedFilesToDelegate(sourceRepo: string, delegateDir: string, forbiddenFiles: string[]): string[] {
  const copied: string[] = [];
  const untrackedFiles = runGitNullList(sourceRepo, ["ls-files", "--others", "--exclude-standard", "-z"]);
  for (const file of untrackedFiles) {
    if (isForbiddenDelegatePath(file, forbiddenFiles)) continue;
    const sourcePath = resolveInside(sourceRepo, file);
    if (!existsSync(sourcePath)) continue;
    const stat = statSync(sourcePath);
    if (!stat.isFile()) continue;
    const targetPath = resolveInside(delegateDir, file);
    ensureDir(dirname(targetPath));
    copyFileSync(sourcePath, targetPath);
    copied.push(file);
  }
  return copied;
}

function seedDelegateWorktreeFromDirtyState(
  sourceRepo: string,
  delegateDir: string,
  forbiddenFiles: string[],
): { seeded: boolean; copiedUntracked: string[]; baselineCommit?: ShellResult } {
  const stagedPatch = runGitRawStdoutCommand(sourceRepo, ["diff", "--cached", "--binary", "--"]);
  const unstagedPatch = runGitRawStdoutCommand(sourceRepo, ["diff", "--binary", "--"]);

  for (const [label, result] of [["staged", stagedPatch], ["unstaged", unstagedPatch]] as const) {
    if (result.exitCode !== 0 || !result.output || result.output === "(no output)") continue;
    const applied = applyPatchText(delegateDir, result.output, label);
    if (applied.exitCode !== 0) {
      throw new Error(`delegateAgent: failed to seed ${label} patch into isolated worktree.\n${applied.output}`);
    }
  }

  const copiedUntracked = copyUntrackedFilesToDelegate(sourceRepo, delegateDir, forbiddenFiles);
  const status = runGitCommand(delegateDir, ["status", "--short"], FULL_DIFF_MAX_OUTPUT);
  const seeded = status.exitCode === 0 && status.output !== "(no output)" && status.output.trim().length > 0;
  if (!seeded) return { seeded: false, copiedUntracked };

  runGitCommand(delegateDir, ["add", "-A", "--", "."], FULL_DIFF_MAX_OUTPUT);
  const baselineCommit = runGitCommand(delegateDir, [
    "-c",
    "user.name=RLM Delegate",
    "-c",
    "user.email=rlm-delegate@example.invalid",
    "commit",
    "--no-verify",
    "-m",
    "rlm delegate baseline",
  ], FULL_DIFF_MAX_OUTPUT);
  if (baselineCommit.exitCode !== 0) {
    throw new Error(`delegateAgent: failed to create isolated baseline commit after seeding dirty state.\n${baselineCommit.output}`);
  }
  return { seeded: true, copiedUntracked, baselineCommit };
}

function normalizePathForScope(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "");
}

function patternMatchesPath(pattern: string, filePath: string): boolean {
  const normalizedPattern = normalizePathForScope(pattern);
  const normalizedPath = normalizePathForScope(filePath);
  if (!normalizedPattern) return false;
  if (normalizedPattern.endsWith("/")) return normalizedPath.startsWith(normalizedPattern);
  if (!normalizedPattern.includes("*")) {
    return normalizedPath === normalizedPattern || normalizedPath.startsWith(`${normalizedPattern}/`);
  }
  const escaped = normalizedPattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`).test(normalizedPath);
}

function parseGitStatusFiles(status: string): string[] {
  const files: string[] = [];
  for (const line of status.split("\n")) {
    if (!line.trim() || line === "(clean)") continue;
    const raw = (line.length >= 3 && line[2] === " ")
      ? line.slice(3).trim()
      : line.replace(/^[ MADRCU?!]{1,2}\s+/, "").trim();
    if (!raw) continue;
    files.push(normalizePathForScope(raw.includes(" -> ") ? raw.split(" -> ").pop() || raw : raw));
  }
  return Array.from(new Set(files));
}

function checkDelegateScope(
  changedFiles: string[],
  allowedFiles: string[],
  forbiddenFiles: string[],
): DelegateScopeCheck {
  const violations: string[] = [];
  for (const file of changedFiles) {
    if (allowedFiles.length > 0 && !allowedFiles.some((pattern) => patternMatchesPath(pattern, file))) {
      violations.push(`${file} is outside allowedFiles`);
    }
    if (forbiddenFiles.some((pattern) => patternMatchesPath(pattern, file))) {
      violations.push(`${file} matches forbiddenFiles`);
    }
  }
  return {
    passed: violations.length === 0,
    isClean: violations.length === 0,
    changedFiles,
    violations,
    issues: violations,
    allowedFiles,
    forbiddenFiles,
  };
}

function normalizeDelegateRequest(request: DelegateAgentRequest | string): DelegateAgentRequest {
  if (typeof request === "string") return { taskContract: request };
  if (!request || typeof request !== "object") {
    throw new Error("delegateAgent: provide { taskContract, allowedFiles?, forbiddenFiles?, testCommand? }");
  }
  return request;
}

function buildDelegatePrompt(request: DelegateAgentRequest, agent: AgentName): string {
  const allowed = request.allowedFiles?.length ? request.allowedFiles.join(", ") : "(no explicit allowlist; keep edits minimal)";
  const forbidden = request.forbiddenFiles?.length ? request.forbiddenFiles.join(", ") : "(default forbidden paths only)";
  return [
    "You are a bounded implementation worker hired by RLM.",
    "RLM remains the controller and will inspect your diff before accepting anything.",
    "",
    "Task contract:",
    request.taskContract,
    "",
    "Hard constraints:",
    `- Agent: ${agent}`,
    `- Allowed files/patterns: ${allowed}`,
    `- Forbidden files/patterns: ${forbidden}`,
    "- Do not commit, push, create branches, change remotes, open PRs, or call external project APIs.",
    "- Do not broaden the task. Prefer the smallest safe edit.",
    "- If the task cannot be completed inside the allowed scope, stop and explain why.",
    request.testCommand ? `- Run this verification command before finishing: ${request.testCommand}` : "- Run only focused verification if you can infer it safely.",
    request.maxTurns ? `- Stop after ${request.maxTurns} failed implementation attempts.` : "- Stop after two failed implementation attempts.",
    request.maxCost ? `- Respect this rough cost budget: ${request.maxCost}.` : "",
    "",
    "Return concise output only:",
    "- What changed",
    "- Files changed",
    "- Verification command/result",
    "- Any blockers",
    "",
    "The host will collect git status and diff separately, so do not paste large diffs unless there is no other way.",
  ].filter(Boolean).join("\n");
}

function normalizeExperimentRequest(
  hypothesisOrRequest: string | ExperimentRequest,
  planOrRequest?: string | ExperimentRequest,
): ExperimentRequest {
  if (typeof hypothesisOrRequest === "object" && hypothesisOrRequest !== null) {
    return hypothesisOrRequest;
  }
  if (typeof planOrRequest === "object" && planOrRequest !== null) {
    return { ...planOrRequest, hypothesis: hypothesisOrRequest };
  }
  return { hypothesis: hypothesisOrRequest, plan: planOrRequest };
}

function toStringArray(value: string | string[] | undefined): string[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function memoryPath(): string {
  return join(dataRoot(), "memory.jsonl");
}

function readMemoryRecords(): MemoryRecord[] {
  const path = memoryPath();
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line) as MemoryRecord; } catch { return null; }
    })
    .filter((record): record is MemoryRecord => Boolean(record));
}

function writeMemoryRecords(records: MemoryRecord[]): void {
  ensureDir(dirname(memoryPath()));
  writeFileSync(memoryPath(), records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : ""), "utf-8");
}

function normalizeRememberRequest(
  scopeOrRequest?: string | RememberRequest,
  claim?: string,
  evidence?: unknown,
): RememberRequest {
  if (typeof scopeOrRequest === "object" && scopeOrRequest !== null) {
    return scopeOrRequest;
  }
  if (typeof scopeOrRequest === "string" && claim) {
    return { action: "record", scope: scopeOrRequest, claim, evidence };
  }
  if (typeof scopeOrRequest === "string") {
    return { action: "recall", scope: scopeOrRequest };
  }
  return { action: "recall" };
}

function normalizeForgeRequest(request?: string | ForgeToolRequest, constraints?: string[] | string): ForgeToolRequest {
  if (typeof request === "object" && request !== null) return request;
  if (typeof request === "string") {
    return { action: "draft", goal: request, constraints };
  }
  return { action: "list" };
}

function normalizeForgeConstraints(value: string[] | string | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function forgeCodeFromSpec(spec: ForgeToolRequest): string | null {
  if ("code" in spec && spec.code !== undefined && typeof spec.code !== "string") {
    throw new Error("forge_tool create: code must be a string");
  }
  if (typeof spec.code === "string") return spec.code;

  if ("codeLines" in spec && spec.codeLines !== undefined) {
    if (!Array.isArray(spec.codeLines) || !spec.codeLines.every((line) => typeof line === "string")) {
      throw new Error("forge_tool create: codeLines must be an array of strings");
    }
    return spec.codeLines.join("\n");
  }

  if ("codeBase64" in spec && spec.codeBase64 !== undefined) {
    if (typeof spec.codeBase64 !== "string") {
      throw new Error("forge_tool create: codeBase64 must be a string");
    }
    return Buffer.from(spec.codeBase64, "base64").toString("utf-8");
  }
  return null;
}

function hasForgeCodeSpec(spec: ForgeToolRequest): boolean {
  return "code" in spec || "codeLines" in spec || "codeBase64" in spec;
}

function assertToolName(name: string | undefined): string {
  if (!name || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) {
    throw new Error("forge_tool: name must start with a letter and contain only letters, numbers, underscores, or hyphens");
  }
  return name;
}

function forgeDir(repoPath: string): string {
  return join(dataRoot(), "forged-tools", repoKey(repoPath));
}

function forgeScriptPath(repoPath: string, name: string): string {
  return join(forgeDir(repoPath), `${name}.js`);
}

function forgeMetaPath(repoPath: string, name: string): string {
  return join(forgeDir(repoPath), `${name}.json`);
}

async function runForgedTool(repoPath: string, scriptPath: string, args: string[], opts: BashOpts): Promise<ShellResult> {
  const timeoutMs = opts.timeout || 30000;
  const maxOutput = opts.maxOutput || DEFAULT_MAX_OUTPUT;
  const startMs = Date.now();

  try {
    const proc = Bun.spawn(["bun", scriptPath, ...args], {
      cwd: repoPath,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: process.env.HOME },
    });

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const timer = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        proc.kill();
        reject(new Error(`forged tool timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    const completion = (async () => {
      const exitCode = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      return { exitCode, stdout, stderr };
    })();

    const { exitCode, stdout, stderr } = await Promise.race([completion, timer]);
    if (timeoutId) clearTimeout(timeoutId);

    let output = stdout || "";
    if (stderr) {
      output += (output ? "\n" : "") + "[stderr]\n" + stderr;
    }
    if (!output) output = "(no output)";

    return {
      command: `bun ${basename(scriptPath)} ${args.join(" ")}`.trim(),
      exitCode,
      output: truncateMiddle(output, maxOutput).trim(),
      durationMs: Date.now() - startMs,
    };
  } catch (e) {
    return {
      command: `bun ${basename(scriptPath)} ${args.join(" ")}`.trim(),
      exitCode: null,
      output: `forge_tool run error: ${(e as Error).message}`,
      durationMs: Date.now() - startMs,
      error: (e as Error).message,
    };
  }
}

/**
 * Build tool functions for codebase exploration.
 * These execute on the HOST side and are called from the sandbox via tool_call IPC.
 */
export function buildRepoTools(repoPath: string): RepoTools {
  const editFileFailuresByPath = new Map<string, number>();

  function recordEditFileFailure(filePath: string): number {
    const failures = (editFileFailuresByPath.get(filePath) ?? 0) + 1;
    editFileFailuresByPath.set(filePath, failures);
    return failures;
  }

  function clearEditFileFailures(filePath: string): void {
    editFileFailuresByPath.delete(filePath);
  }

  function exec(cmd: string): string {
    const result = Bun.spawnSync(["sh", "-c", cmd], {
      cwd: repoPath,
      stdout: "pipe",
      stderr: "pipe",
    });
    return new TextDecoder().decode(result.stdout).trim();
  }

  return {
    readFile(filePath: string): string {
      const abs = resolveInside(repoPath, filePath);
      if (!existsSync(abs)) throw new Error("File not found: " + filePath);
      return readFileSync(abs, "utf-8");
    },

    readFileRange(filePath: string, startLine: number, endLine?: number): ReadFileRangeResult {
      const abs = resolveInside(repoPath, filePath);
      if (!existsSync(abs)) throw new Error("File not found: " + filePath);
      const content = readFileSync(abs, "utf-8");
      const { lines } = splitContentLines(content);
      const start = Math.max(1, Math.floor(startLine || 1));
      const end = Math.min(lines.length, Math.floor(endLine || start + 120 - 1));
      if (start > lines.length + 1) {
        throw new Error(`readFileRange: startLine ${start} is beyond EOF (${lines.length} lines)`);
      }
      if (end < start - 1) {
        throw new Error(`readFileRange: endLine ${end} must be >= startLine - 1 (${start - 1})`);
      }
      return {
        path: filePath,
        startLine: start,
        endLine: end,
        totalLines: lines.length,
        content: lines.slice(start - 1, end).join("\n"),
      };
    },

    inspect(filePath: string): FileInspection {
      const abs = resolveInside(repoPath, filePath);
      return inspectAbsolutePath(abs, filePath);
    },

    listSymbols(filePath: string): FileSymbol[] {
      const abs = resolveInside(repoPath, filePath);
      if (!existsSync(abs)) throw new Error("File not found: " + filePath);
      return listFileSymbols(readFileSync(abs, "utf-8"));
    },

    glob(pattern: string): string[] {
      return scanGlobPaths(repoPath, pattern);
    },

    rg(pattern: string | RegExp, opts?: GrepOpts | string): GrepMatch[] {
      return runRipgrepSearch(repoPath, pattern, opts);
    },

    grep(pattern: string | RegExp, opts?: GrepOpts | string): GrepMatch[] {
      return runRipgrepSearch(repoPath, pattern, opts);
    },

    writeFile(filePath: string, content: string): { path: string; bytesWritten: number } {
      if (typeof content !== "string") {
        throw new Error("writeFile: content must be a string");
      }
      const abs = resolveInside(repoPath, filePath);
      ensureDir(dirname(abs));
      writeFileSync(abs, content, "utf-8");
      clearEditFileFailures(filePath);
      return { path: filePath, bytesWritten: Buffer.byteLength(content, "utf-8") };
    },

    editFileRange(filePath: string, startLine: number, endLine: number, newText: string): EditFileRangeResult {
      if (typeof newText !== "string") {
        throw new Error("editFileRange: newText must be a string");
      }
      const abs = resolveInside(repoPath, filePath);
      if (!existsSync(abs)) throw new Error("File not found: " + filePath);
      const content = readFileSync(abs, "utf-8");
      const { lines, finalNewline } = splitContentLines(content);
      const start = Math.floor(startLine);
      const end = Math.floor(endLine);
      if (!Number.isFinite(start) || !Number.isFinite(end)) {
        throw new Error("editFileRange: startLine and endLine must be finite numbers");
      }
      if (start < 1) throw new Error("editFileRange: startLine must be >= 1");
      if (end < start - 1) {
        throw new Error("editFileRange: endLine must be >= startLine - 1. Use endLine=startLine-1 to insert before startLine.");
      }
      if (end > lines.length) {
        throw new Error(`editFileRange: endLine ${end} is beyond EOF (${lines.length} lines)`);
      }

      const replacement = splitContentLines(newText).lines;
      const removeCount = end >= start ? end - start + 1 : 0;
      lines.splice(start - 1, removeCount, ...replacement);
      writeFileSync(abs, joinContentLines(lines, finalNewline), "utf-8");
      clearEditFileFailures(filePath);
      return {
        path: filePath,
        startLine: start,
        endLine: end,
        removedLines: removeCount,
        insertedLines: replacement.length,
      };
    },

    editFile(
      filePath: string,
      oldString: string,
      newString: string,
      opts?: EditFileOpts | string,
    ): { path: string; replacements: number; startLine: number } {
      const o = parseMaybeJson<EditFileOpts>(opts, {});
      if (oldString === newString) {
        throw new Error("editFile: oldString and newString must be different");
      }
      if (!oldString || typeof oldString !== "string") {
        throw new Error("editFile: oldString must be a non-empty string");
      }
      if (typeof newString !== "string") {
        throw new Error("editFile: newString must be a string");
      }

      const abs = resolveInside(repoPath, filePath);
      if (!existsSync(abs)) throw new Error("File not found: " + filePath);
      const content = readFileSync(abs, "utf-8");
      const occurrences = findStringOccurrences(content, oldString);
      if (!occurrences.length) {
        const failureCount = recordEditFileFailure(filePath);
        const suggestion = editFileEscalationSuggestion(
          "Re-read the current file or target region and use exact current text. If the change is structural, use bounded edits or a deterministic transform; use writeFile only when full replacement is safer.",
          failureCount
        );
        throw new Error(
          "editFile: oldString not found. " +
          editFileDiagnostic({
            filePath,
            matched: 0,
            reason: "oldString did not match the current file content",
            suggestion,
            failureCount,
          })
        );
      }
      if (occurrences.length > 1 && !o.replaceAll) {
        const requestedLine = Number.isFinite(o.startLine) ? Math.floor(o.startLine as number) : null;
        const lineMatch = requestedLine === null ? null : occurrences.find((entry) => entry.line === requestedLine);
        if (!lineMatch) {
          const failureCount = recordEditFileFailure(filePath);
          const lines = occurrences.slice(0, 8).map((entry) => entry.line).join(", ");
          const suffix = occurrences.length > 8 ? ", ..." : "";
          const startLineHint = requestedLine === null
            ? "Pass { startLine } from a current read if this is truly a small exact replacement."
            : `No occurrence starts at requested startLine ${requestedLine}.`;
          const suggestion = editFileEscalationSuggestion(
            "Provide startLine, choose a larger unique surrounding block, or inspect structure and make bounded edits. Avoid full-file rewrite for large files unless it is clearly safer.",
            failureCount
          );
          throw new Error(
            `editFile: oldString found ${occurrences.length} times at lines ${lines}${suffix}. ${startLineHint} ` +
            editFileDiagnostic({
              filePath,
              matched: occurrences.length,
              reason: requestedLine === null
                ? "oldString matched multiple locations"
                : `oldString matched multiple locations but none started at line ${requestedLine}`,
              suggestion,
              matches: occurrences.map((entry) => ({ line: entry.line })),
              failureCount,
            })
          );
        }
        const updated = content.slice(0, lineMatch.index) + newString + content.slice(lineMatch.index + oldString.length);
        writeFileSync(abs, updated, "utf-8");
        clearEditFileFailures(filePath);
        return { path: filePath, replacements: 1, startLine: lineMatch.line };
      }
      const startLine = occurrences[0].line;
      const updated = o.replaceAll
        ? content.replaceAll(oldString, newString)
        : content.replace(oldString, newString);
      writeFileSync(abs, updated, "utf-8");
      clearEditFileFailures(filePath);
      return { path: filePath, replacements: o.replaceAll ? occurrences.length : 1, startLine };
    },

    gitLog(n?: number): GitLogEntry[] {
      const count = typeof n === "number" ? n : 20;
      const out = exec(
        `git log --format='{"hash":"%H","author":"%an","date":"%ai","message":"%s"}' -n ${count}`
      );
      if (!out) return [];
      return out
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try { return JSON.parse(line) as GitLogEntry; } catch { return null; }
        })
        .filter((x): x is GitLogEntry => x !== null);
    },

    gitDiff(a: string, b?: string): string {
      const refB = b || "HEAD";
      return exec(`git diff ${a} ${refB}`);
    },

    gitBlame(filePath: string): string {
      return exec(`git blame ${filePath}`);
    },

    gitStatus(): string {
      return exec("git status --short") || "(clean)";
    },

    gitDiffWorking(filePath?: string): string {
      if (filePath) return exec(`git diff -- ${filePath}`);
      return exec("git diff") || "(no unstaged changes)";
    },

    applyPatch(patch: string, opts?: ApplyPatchOpts | string): ApplyPatchResult {
      const o = parseMaybeJson<ApplyPatchOpts>(opts, {});
      if (!patch || typeof patch !== "string") {
        throw new Error("applyPatch: patch must be a non-empty unified diff string");
      }

      const tmpRoot = mkdtempSync(join(tmpdir(), "rlm-apply-patch-"));
      const patchPath = join(tmpRoot, "candidate.patch");
      try {
        writeFileSync(patchPath, patch, "utf-8");
        const args = ["apply"];
        if (o.check) args.push("--check");
        if (o.reverse) args.push("--reverse");
        args.push(`--whitespace=${o.whitespace || "nowarn"}`);
        args.push(patchPath);
        const result = runGitCommand(repoPath, args, DEFAULT_MAX_OUTPUT);
        return {
          ...result,
          applied: !o.check && result.exitCode === 0,
        };
      } finally {
        rmSync(tmpRoot, { recursive: true, force: true });
      }
    },

    listFiles(): string[] {
      const out = exec("git ls-files");
      if (out) return out.split("\n").filter(Boolean);
      // Fallback: git ls-files failed (e.g. Xcode license not agreed, git not configured)
      // Use Bun Glob to enumerate files, excluding common noise directories
      const entries = scanGlobPaths(repoPath, "**/*");
      return entries.filter((f: string) => {
        const parts = f.split("/");
        return !parts.some((p: string) => p === ".git" || p === "node_modules" || p === ".DS_Store");
      });
    },

    detectRunners(): RunnerCandidate[] {
      const runners: RunnerCandidate[] = [];
      const seen = new Set<string>();
      const add = (candidate: RunnerCandidate) => {
        if (seen.has(candidate.command)) return;
        seen.add(candidate.command);
        runners.push(candidate);
      };
      const has = (path: string) => existsSync(join(repoPath, path));

      if (has("package.json")) {
        try {
          const pkg = JSON.parse(readFileSync(join(repoPath, "package.json"), "utf-8")) as { scripts?: Record<string, string> };
          const packageRunner = has("bun.lockb") || has("bun.lock") ? "bun" : has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : "npm";
          for (const script of ["test", "check", "typecheck", "lint"]) {
            if (pkg.scripts?.[script]) {
              add({ kind: "node", command: `${packageRunner} run ${script}`, reason: `package.json defines scripts.${script}` });
            }
          }
        } catch {
          add({ kind: "node", command: "npm test", reason: "package.json exists but could not be parsed; npm test is the conventional fallback" });
        }
      }

      if (has("pyproject.toml") || has("pytest.ini") || has("tox.ini") || has("requirements.txt")) {
        if (has("uv.lock") || has("pyproject.toml")) {
          add({ kind: "python", command: "uv run pytest", reason: "Python project metadata found; uv run pytest uses the project environment when available" });
        }
        add({ kind: "python", command: "python3 -m pytest", reason: "Python test metadata found" });
      }

      if (has("go.mod")) {
        add({ kind: "go", command: "go test ./...", reason: "go.mod exists" });
      }

      if (has("Cargo.toml")) {
        add({ kind: "rust", command: "cargo test", reason: "Cargo.toml exists" });
      }

      if (has("Gemfile")) {
        add({ kind: "ruby", command: "bundle exec rake test", reason: "Gemfile exists" });
        add({ kind: "ruby", command: "bundle exec rspec", reason: "Gemfile exists; rspec may be the project runner" });
      }

      return runners;
    },

    async bash(command: string, opts?: BashOpts | string): Promise<string> {
      const o: BashOpts = parseMaybeJson(opts, {});
      return shellResultToString(await runShellCommand(repoPath, command, o));
    },

    async experiment(hypothesisOrRequest: string | ExperimentRequest, planOrRequest?: string | ExperimentRequest): Promise<unknown> {
      const request = normalizeExperimentRequest(hypothesisOrRequest, planOrRequest);
      const rawSteps = request.steps?.length
        ? request.steps
        : request.command
          ? [{ name: "command", command: request.command }]
          : [];

      if (!request.hypothesis || typeof request.hypothesis !== "string") {
        throw new Error("experiment: provide a hypothesis string or { hypothesis, steps }");
      }
      if (rawSteps.length === 0) {
        throw new Error("experiment: provide at least one step or command");
      }
      if (rawSteps.length > 20) {
        throw new Error("experiment: at most 20 steps are allowed");
      }

      const started = Date.now();
      const stopOnFailure = request.stopOnFailure ?? true;
      const steps = [];

      for (let i = 0; i < rawSteps.length; i++) {
        const step = rawSteps[i];
        if (!step?.command || typeof step.command !== "string") {
          throw new Error(`experiment: steps[${i}].command must be a non-empty string`);
        }

        const result = await runShellCommand(repoPath, step.command, {
          timeout: step.timeout ?? request.timeout,
          maxOutput: step.maxOutput ?? request.maxOutput,
        });

        const checks = [];
        const expectedExitCode = step.expectExitCode ?? 0;
        checks.push({
          type: "exitCode",
          expected: expectedExitCode,
          actual: result.exitCode,
          passed: result.exitCode === expectedExitCode,
        });

        for (const needle of toStringArray(step.mustContain)) {
          checks.push({
            type: "mustContain",
            expected: needle,
            passed: result.output.includes(needle),
          });
        }
        for (const needle of toStringArray(step.mustNotContain)) {
          checks.push({
            type: "mustNotContain",
            expected: needle,
            passed: !result.output.includes(needle),
          });
        }

        const passed = checks.every((check) => check.passed);
        steps.push({
          name: step.name || `step ${i + 1}`,
          command: step.command,
          exitCode: result.exitCode,
          passed,
          durationMs: result.durationMs,
          checks,
          output: result.output,
        });

        if (!passed && stopOnFailure) break;
      }

      const passed = steps.every((step) => step.passed);
      return {
        hypothesis: request.hypothesis,
        plan: request.plan || "",
        passed,
        summary: passed ? "Hypothesis survived the experiment." : "Hypothesis failed or needs revision.",
        durationMs: Date.now() - started,
        steps,
      };
    },

    async remember(scopeOrRequest?: string | RememberRequest, claim?: string, evidence?: unknown): Promise<unknown> {
      const request = normalizeRememberRequest(scopeOrRequest, claim, evidence);
      const action = request.action || (request.claim ? "record" : "recall");
      ensureDir(dirname(memoryPath()));

      if (action === "record") {
        if (!request.scope || !request.claim) {
          throw new Error("remember record: provide scope and claim");
        }

        const now = new Date();
        const record: MemoryRecord = {
          id: randomUUID(),
          createdAt: now.toISOString(),
          repoKey: repoKey(repoPath),
          repoPath: resolve(repoPath),
          scope: request.scope,
          claim: request.claim,
          evidence: request.evidence ?? null,
          confidence: request.confidence,
          tags: request.tags,
        };
        if (request.ttlDays && Number.isFinite(request.ttlDays)) {
          record.expiresAt = new Date(now.getTime() + request.ttlDays * 24 * 60 * 60 * 1000).toISOString();
        }

        appendFileSync(memoryPath(), JSON.stringify(record) + "\n", "utf-8");
        return { action: "record", stored: true, record };
      }

      if (action === "forget") {
        if (!request.id) throw new Error("remember forget: provide id");
        const records = readMemoryRecords();
        const kept = records.filter((record) => record.id !== request.id);
        writeMemoryRecords(kept);
        return { action: "forget", removed: records.length - kept.length, id: request.id };
      }

      const nowMs = Date.now();
      const query = request.query?.toLowerCase();
      const limit = Math.max(1, Math.min(100, request.limit || 20));
      const records = readMemoryRecords()
        .filter((record) => !record.expiresAt || Date.parse(record.expiresAt) > nowMs)
        .filter((record) => !request.scope || record.scope === request.scope || record.scope.startsWith(`${request.scope}/`))
        .filter((record) => {
          if (!query) return true;
          const haystack = JSON.stringify({
            scope: record.scope,
            claim: record.claim,
            evidence: record.evidence,
            tags: record.tags,
          }).toLowerCase();
          return haystack.includes(query);
        })
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit);

      return { action, count: records.length, records };
    },

    async forge_tool(request?: string | ForgeToolRequest, constraints?: string[] | string): Promise<unknown> {
      const spec = normalizeForgeRequest(request, constraints);
      const action = spec.action || (hasForgeCodeSpec(spec) ? "create" : "draft");
      const dir = forgeDir(repoPath);
      ensureDir(dir);

      if (action === "draft") {
        const goal = spec.goal || "Build a small reusable verifier or parser.";
        const normalizedConstraints = normalizeForgeConstraints(spec.constraints);
        const code = [
          "#!/usr/bin/env bun",
          "const args = process.argv.slice(2);",
          "",
          `// Goal: ${goal.replace(/\n/g, " ")}`,
          ...normalizedConstraints.map((constraint) => `// Constraint: ${constraint.replace(/\n/g, " ")}`),
          "// Keep this tool deterministic. Read files from process.cwd(), print JSON or concise text, and exit non-zero on failure.",
          "",
          "console.log(JSON.stringify({ ok: true, args }, null, 2));",
        ].join("\n");
        return { action: "draft", goal, constraints: normalizedConstraints, code };
      }

      if (action === "list") {
        const tools = existsSync(dir)
          ? readdirSync(dir)
            .filter((entry) => entry.endsWith(".json"))
            .map((entry) => {
              try { return JSON.parse(readFileSync(join(dir, entry), "utf-8")) as ForgeMetadata; } catch { return null; }
            })
            .filter((entry): entry is ForgeMetadata => Boolean(entry))
          : [];
        return { action: "list", repoKey: repoKey(repoPath), tools };
      }

      const name = assertToolName(spec.name);
      const scriptPath = forgeScriptPath(repoPath, name);
      const metaPath = forgeMetaPath(repoPath, name);

      if (action === "create") {
        const source = forgeCodeFromSpec(spec);
        if (!source) {
          throw new Error("forge_tool create: provide code, codeLines, or codeBase64");
        }
        if (existsSync(scriptPath) && !spec.overwrite) {
          throw new Error(`forge_tool create: ${name} already exists; pass overwrite: true to replace it`);
        }

        const now = new Date().toISOString();
        const prior = existsSync(metaPath)
          ? (() => { try { return JSON.parse(readFileSync(metaPath, "utf-8")) as Partial<ForgeMetadata>; } catch { return {}; } })()
          : {};
        const metadata: ForgeMetadata = {
          name,
          goal: spec.goal || prior.goal || "",
          constraints: normalizeForgeConstraints(spec.constraints ?? prior.constraints),
          createdAt: prior.createdAt || now,
          updatedAt: now,
          repoKey: repoKey(repoPath),
          path: scriptPath,
        };

        writeFileSync(scriptPath, source.endsWith("\n") ? source : source + "\n", "utf-8");
        writeFileSync(metaPath, JSON.stringify(metadata, null, 2) + "\n", "utf-8");
        return { action: "create", created: true, metadata };
      }

      if (action === "read") {
        if (!existsSync(scriptPath)) throw new Error(`forge_tool read: ${name} does not exist`);
        const metadata = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf-8")) : null;
        return { action: "read", metadata, code: readFileSync(scriptPath, "utf-8") };
      }

      if (action === "run") {
        if (!existsSync(scriptPath)) throw new Error(`forge_tool run: ${name} does not exist`);
        const args = (spec.args || []).map((arg) => String(arg));
        const result = await runForgedTool(repoPath, scriptPath, args, {
          timeout: spec.timeout,
          maxOutput: spec.maxOutput,
        });
        return { action: "run", name, ...result, passed: result.exitCode === 0 };
      }

      if (action === "delete") {
        if (existsSync(scriptPath)) unlinkSync(scriptPath);
        if (existsSync(metaPath)) unlinkSync(metaPath);
        return { action: "delete", deleted: true, name };
      }

      throw new Error(`forge_tool: unsupported action ${action}`);
    },

    async delegateAgent(requestInput: DelegateAgentRequest | string): Promise<DelegateAgentResult> {
      const request = normalizeDelegateRequest(requestInput);
      if (!request.taskContract || typeof request.taskContract !== "string") {
        throw new Error("delegateAgent: taskContract must be a non-empty string");
      }
      const agent = assertAgentName(request.agent);
      const defaultForbidden = DEFAULT_DELEGATE_FORBIDDEN;
      const allowedFiles = (request.allowedFiles || []).map(normalizePathForScope);
      const forbiddenFiles = [...defaultForbidden, ...(request.forbiddenFiles || [])].map(normalizePathForScope);
      const notes = [
        "delegateAgent ran in an isolated git worktree.",
        "The main RLM worktree was not mutated by the delegated agent.",
        "RLM must review scope, tests, and diff before applying any candidate change locally.",
      ];

      const tmpRoot = mkdtempSync(join(tmpdir(), "rlm-delegate-"));
      const delegateDir = join(tmpRoot, "repo");
      let worktreeAdded = false;
      try {
        const add = runGitCommand(repoPath, ["worktree", "add", "--detach", delegateDir, "HEAD"]);
        if (add.exitCode !== 0) {
          throw new Error(`delegateAgent: could not create isolated git worktree.\n${add.output}`);
        }
        worktreeAdded = true;

        const seed = seedDelegateWorktreeFromDirtyState(repoPath, delegateDir, forbiddenFiles);
        if (seed.seeded) {
          notes.push("The isolated worktree was seeded with the current dirty state before the worker ran.");
          notes.push("The returned diff is relative to that seeded baseline, so it can be applied back onto the current dirty worktree.");
          if (seed.copiedUntracked.length > 0) {
            notes.push(`Seeded ${seed.copiedUntracked.length} untracked file(s) into the isolated baseline.`);
          }
        }

        const agentResult = await runExternalAgent(
          delegateDir,
          agent,
          buildDelegatePrompt(request, agent),
          { timeout: request.timeout, maxOutput: request.maxOutput, onOutput: request.onOutput },
        );

        runGitCommand(delegateDir, ["add", "-N", "--", "."]);
        const statusResult = runGitRawStdoutCommand(delegateDir, ["status", "--short"]);
        const status = statusResult.exitCode === 0 ? statusResult.output : "";
        const changedFiles = parseGitStatusFiles(status);
        const diffResult = runGitRawStdoutCommand(delegateDir, ["diff", "--binary", "--"]);
        const diff = diffResult.exitCode === 0 ? diffResult.output : "";
        const scopeCheck = checkDelegateScope(changedFiles, allowedFiles, forbiddenFiles);

        const testResult = request.testCommand
          ? await runShellCommand(delegateDir, request.testCommand, {
            timeout: request.timeout || 120_000,
            maxOutput: request.maxOutput || DEFAULT_MAX_OUTPUT,
          })
          : undefined;
        const testsPassed = !testResult || testResult.exitCode === 0;
        const readyForReview = agentResult.exitCode === 0 && scopeCheck.passed && testsPassed && diff !== "(no output)" && diff.length > 0;

        return {
          agent,
          isolated: true,
          appliedToMainWorktree: false,
          readyForReview,
          taskContract: request.taskContract,
          changedFiles,
          status: status || "(clean)",
          diff: diff || "(no diff)",
          agentResult,
          testResult,
          scopeCheck,
          notes,
          seededDirtyState: seed.seeded,
          diffBytes: Buffer.byteLength(diff || "", "utf-8"),
        };
      } finally {
        if (worktreeAdded) {
          runGitCommand(repoPath, ["worktree", "remove", "--force", delegateDir]);
        }
        rmSync(tmpRoot, { recursive: true, force: true });
      }
    },

    async run_agent(agentOrOpts: AgentName | { agent?: AgentName; prompt: string; timeout?: number; maxOutput?: number }, prompt?: string, opts?: RunAgentOpts | string): Promise<string> {
      // Support both calling conventions:
      // 1. run_agent("claude", "prompt text", opts)  — positional
      // 2. run_agent({ agent: "claude", prompt: "prompt text" })  — object-style (from prompts)
      let actualAgent: AgentName;
      let actualPrompt: string;
      let actualOpts: RunAgentOpts;

      if (typeof agentOrOpts === "object" && agentOrOpts !== null) {
        actualAgent = agentOrOpts.agent || "claude";
        actualPrompt = agentOrOpts.prompt;
        actualOpts = { timeout: agentOrOpts.timeout, maxOutput: agentOrOpts.maxOutput };
      } else {
        actualAgent = agentOrOpts;
        actualPrompt = prompt!;
        actualOpts = typeof opts === "string" ? JSON.parse(opts) : opts || {};
      }

      const timeoutMs = actualOpts.timeout || 120_000;
      const maxOutput = actualOpts.maxOutput || 100 * 1024;

      if (!actualPrompt || typeof actualPrompt !== "string") {
        throw new Error("run_agent: prompt must be a non-empty string");
      }

      actualAgent = assertAgentName(actualAgent);

      // Warn if prompt is suspiciously long (likely embedded file contents)
      if (actualPrompt.length > 4000) {
        console.warn(`[run_agent] Warning: prompt is ${actualPrompt.length} chars. AI agents can read files themselves — consider referencing file paths instead of embedding content.`);
      }

      const result = await runExternalAgent(repoPath, actualAgent, actualPrompt, { timeout: timeoutMs, maxOutput });
      return shellResultToString(result);
    },
  };
}

/**
 * Build wrapper function source strings for injection into the sandbox.
 */
export function buildToolWrappers(toolNames: string[]): Record<string, string> {
  const wrappers: Record<string, string> = {};
  for (const name of toolNames) {
    wrappers[name] = `async function(...args) {
  const raw = await __rlm_tool_call("${name}", args);
  try {
    const envelope = JSON.parse(raw);
    if (envelope && envelope.__t === "s") return envelope.v;
    if (envelope && envelope.__t === "j") return JSON.parse(envelope.v);
    return raw;
  } catch { return raw; }
}`;
  }
  return wrappers;
}

// ── Multi-repo workspace tools ──────────────────────────────────

/**
 * Parse a namespaced path "repoId:relative/path" into components.
 */
export function parseRepoPath(input: string): { repoId: string | null; relPath: string } {
  if (typeof input !== "string") {
    throw new Error(`parseRepoPath: expected string, got ${typeof input}`);
  }
  const colon = input.indexOf(":");
  if (colon <= 0) return { repoId: null, relPath: input };
  const prefix = input.slice(0, colon);
  const afterColon = input.slice(colon + 1);
  if (prefix.length === 1 || prefix.includes("/") || prefix.includes("\\") || afterColon.startsWith("//")) {
    return { repoId: null, relPath: input };
  }
  return { repoId: prefix, relPath: afterColon };
}

/**
 * Build workspace-aware tools that route namespaced paths to per-repo tools.
 * @param repoToolsById - per-repo tool objects keyed by repoId
 * @param repoPathsById - optional mapping from repoId to absolute repo path (enables writeFile)
 */
export function buildWorkspaceTools(
  repoToolsById: Record<string, RepoTools>,
  repoPathsById?: Record<string, string>
): Record<string, (...args: unknown[]) => unknown> {
  const repoIds = Object.keys(repoToolsById);

  function route(path: string): { tools: RepoTools; relPath: string; repoId: string } {
    const { repoId, relPath } = parseRepoPath(path);
    if (!repoId) {
      throw new Error(
        `Workspace mode requires "repoId:path" prefix. Available repos: ${repoIds.join(", ")}. Got: "${path}"`
      );
    }
    if (!repoToolsById[repoId]) {
      throw new Error(
        `Unknown repo "${repoId}". Available repos: ${repoIds.join(", ")}`
      );
    }
    return { tools: repoToolsById[repoId], relPath, repoId };
  }

  function workspaceGrep(pattern: unknown, opts?: unknown): GrepMatch[] {
    const o: GrepOpts = typeof opts === "string" ? JSON.parse(opts) : (opts as GrepOpts) || {};
    if (o.glob) {
      const { repoId, relPath } = parseRepoPath(o.glob);
      if (repoId && repoToolsById[repoId]) {
        return repoToolsById[repoId]
          .rg(pattern as string, { ...o, glob: relPath })
          .map((m: GrepMatch) => ({ ...m, file: `${repoId}:${m.file}` }));
      }
    }
    throw new Error(
      `rg/grep in workspace mode: specify repo via opts.glob prefix, e.g. rg("pattern", {glob: "repoId:src/**/*.js"}). Or use searchAll(pattern). Available repos: ${repoIds.join(", ")}`
    );
  }

  return {
    readFile(path: unknown) {
      const r = route(path as string);
      return r.tools.readFile(r.relPath);
    },

    readFileRange(path: unknown, startLine: unknown, endLine?: unknown) {
      const r = route(path as string);
      const result = r.tools.readFileRange(r.relPath, startLine as number, endLine as number | undefined);
      return { ...result, path: `${r.repoId}:${result.path}` };
    },

    inspect(path: unknown) {
      const r = route(path as string);
      const info = r.tools.inspect(r.relPath);
      return { ...info, path: `${r.repoId}:${info.path}` };
    },

    listSymbols(path: unknown) {
      const r = route(path as string);
      return r.tools.listSymbols(r.relPath).map((symbol) => ({
        ...symbol,
        path: `${r.repoId}:${r.relPath}`,
      }));
    },

    glob(pattern: unknown) {
      const r = route(pattern as string);
      return r.tools.glob(r.relPath).map((f: string) => `${r.repoId}:${f}`);
    },

    grep(pattern: unknown, opts?: unknown) {
      return workspaceGrep(pattern, opts);
    },

    rg(pattern: unknown, opts?: unknown) {
      return workspaceGrep(pattern, opts);
    },

    listFiles(repoId: unknown, opts?: unknown) {
      if (!repoToolsById[repoId as string]) {
        throw new Error(`Unknown repo "${repoId}". Available repos: ${repoIds.join(", ")}`);
      }
      const o = typeof opts === "string" ? JSON.parse(opts) : (opts as { namespaced?: boolean } | undefined) || {};
      const files = repoToolsById[repoId as string].listFiles();
      if (o.namespaced === false) return files;
      return files.map((f: string) => `${repoId}:${f}`);
    },

    detectRunners(repoId: unknown) {
      if (!repoToolsById[repoId as string]) throw new Error(`Unknown repo "${repoId}".`);
      return repoToolsById[repoId as string].detectRunners();
    },

    gitLog(repoId: unknown, n?: unknown) {
      if (!repoToolsById[repoId as string]) throw new Error(`Unknown repo "${repoId}".`);
      return repoToolsById[repoId as string].gitLog(n as number);
    },

    gitDiff(repoId: unknown, a: unknown, b?: unknown) {
      if (!repoToolsById[repoId as string]) throw new Error(`Unknown repo "${repoId}".`);
      return repoToolsById[repoId as string].gitDiff(a as string, b as string);
    },

    gitBlame(repoId: unknown, path: unknown) {
      if (!repoToolsById[repoId as string]) throw new Error(`Unknown repo "${repoId}".`);
      return repoToolsById[repoId as string].gitBlame(path as string);
    },

    async bash(repoId: unknown, command: unknown, opts?: unknown) {
      if (!repoToolsById[repoId as string]) {
        throw new Error(`Unknown repo "${repoId}". Available repos: ${repoIds.join(", ")}`);
      }
      return repoToolsById[repoId as string].bash(command as string, opts as BashOpts);
    },

    async experiment(repoOrRequest: unknown, requestOrPlan?: unknown, maybePlan?: unknown) {
      let repoId: string;
      let request: unknown;
      let plan: unknown;

      if (typeof repoOrRequest === "string" && repoToolsById[repoOrRequest]) {
        repoId = repoOrRequest;
        request = requestOrPlan;
        plan = maybePlan;
      } else if (typeof repoOrRequest === "object" && repoOrRequest !== null && "repo" in repoOrRequest) {
        const { repo, ...rest } = repoOrRequest as Record<string, unknown>;
        repoId = repo as string;
        request = rest;
      } else {
        throw new Error(`experiment in workspace mode: pass repoId first or { repo, hypothesis, steps }. Available repos: ${repoIds.join(", ")}`);
      }

      if (!repoToolsById[repoId]) {
        throw new Error(`Unknown repo "${repoId}". Available repos: ${repoIds.join(", ")}`);
      }
      return repoToolsById[repoId].experiment(request as string | ExperimentRequest, plan as string | ExperimentRequest);
    },

    async remember(scopeOrRequest?: unknown, claim?: unknown, evidence?: unknown) {
      if (typeof scopeOrRequest === "object" && scopeOrRequest !== null && "repo" in scopeOrRequest) {
        const { repo, ...rest } = scopeOrRequest as Record<string, unknown>;
        const repoId = repo as string;
        if (!repoToolsById[repoId]) {
          throw new Error(`Unknown repo "${repoId}". Available repos: ${repoIds.join(", ")}`);
        }
        return repoToolsById[repoId].remember(rest as RememberRequest);
      }
      return repoToolsById[repoIds[0]].remember(scopeOrRequest as string | RememberRequest, claim as string, evidence);
    },

    async forge_tool(repoOrRequest?: unknown, requestOrConstraints?: unknown) {
      let repoId: string;
      let request: unknown;
      let constraints: unknown;

      if (typeof repoOrRequest === "string" && repoToolsById[repoOrRequest]) {
        repoId = repoOrRequest;
        request = requestOrConstraints;
      } else if (typeof repoOrRequest === "object" && repoOrRequest !== null && "repo" in repoOrRequest) {
        const { repo, ...rest } = repoOrRequest as Record<string, unknown>;
        repoId = repo as string;
        request = rest;
      } else {
        throw new Error(`forge_tool in workspace mode: pass repoId first or { repo, action, ... }. Available repos: ${repoIds.join(", ")}`);
      }

      if (!repoToolsById[repoId]) {
        throw new Error(`Unknown repo "${repoId}". Available repos: ${repoIds.join(", ")}`);
      }
      return repoToolsById[repoId].forge_tool(request as string | ForgeToolRequest, constraints as string[] | string);
    },

    gitStatus(repoId: unknown) {
      if (!repoToolsById[repoId as string]) throw new Error(`Unknown repo "${repoId}".`);
      return repoToolsById[repoId as string].gitStatus();
    },

    gitDiffWorking(repoId: unknown, path?: unknown) {
      if (!repoToolsById[repoId as string]) throw new Error(`Unknown repo "${repoId}".`);
      return repoToolsById[repoId as string].gitDiffWorking(path as string);
    },

    applyPatch(repoId: unknown, patch?: unknown, opts?: unknown) {
      if (typeof repoId === "object" && repoId !== null && "repo" in (repoId as Record<string, unknown>)) {
        const request = repoId as Record<string, unknown>;
        const actualRepo = request.repo as string;
        if (!repoToolsById[actualRepo]) throw new Error(`Unknown repo "${actualRepo}".`);
        return repoToolsById[actualRepo].applyPatch(request.patch as string, request as ApplyPatchOpts);
      }
      if (!repoToolsById[repoId as string]) throw new Error(`Unknown repo "${repoId}".`);
      return repoToolsById[repoId as string].applyPatch(patch as string, opts as ApplyPatchOpts | string);
    },

    listRepos() {
      return repoIds.map((id) => ({ id }));
    },

    searchAll(pattern: unknown, opts?: unknown) {
      const o: GrepOpts = typeof opts === "string" ? JSON.parse(opts) : (opts as GrepOpts) || {};
      if (o.glob) {
        const { relPath } = parseRepoPath(o.glob);
        o.glob = relPath;
      }
      const results: GrepMatch[] = [];
      for (const id of repoIds) {
        try {
          const matches = repoToolsById[id].rg(pattern as string, o);
          for (const m of matches) {
            results.push({ ...m, file: `${id}:${m.file}` });
          }
        } catch {
          // Skip repos that error
        }
      }
      return results;
    },

    async run_agent(agentOrOpts: unknown, prompt?: unknown, opts?: unknown) {
      // In workspace mode, run_agent runs in the FIRST repo by default.
      // If agentOrOpts is an object with a `repo` field, route to that repo.
      let repoId = repoIds[0];
      let actualPrompt = (prompt as string) || "";
      
      const isObj = typeof agentOrOpts === "object" && agentOrOpts !== null;
      if (isObj) {
        if ("repo" in (agentOrOpts as Record<string, unknown>)) {
          repoId = (agentOrOpts as Record<string, unknown>).repo as string;
        }
        if ("prompt" in (agentOrOpts as Record<string, unknown>)) {
          actualPrompt = (agentOrOpts as Record<string, unknown>).prompt as string;
        }
      }

      // If repo wasn't explicitly provided, try to infer it from the first repoId mentioned in the prompt
      if (isObj && !("repo" in (agentOrOpts as Record<string, unknown>)) && actualPrompt) {
        for (const id of repoIds) {
          if (actualPrompt.includes(`${id}:`)) {
            repoId = id;
            break;
          }
        }
      }

      if (!repoToolsById[repoId]) {
        throw new Error(`Unknown repo "${repoId}". Available repos: ${repoIds.join(", ")}`);
      }

      // Rewrite the prompt: Strip the `repoId:` prefixes so the downstream agent understands the clean paths
      // Note: If prompt refers to multiple repos, the remote agent will only be running in `repoId`'s cwd.
      if (actualPrompt) {
        const regex = new RegExp(`\\b${repoId}:`, 'g');
        actualPrompt = actualPrompt.replace(regex, "");
        if (isObj) {
           (agentOrOpts as any).prompt = actualPrompt;
        } else {
           prompt = actualPrompt;
        }
      }

      return repoToolsById[repoId].run_agent(agentOrOpts as any, prompt as string, opts as RunAgentOpts);
    },

    async delegateAgent(requestInput: unknown) {
      const request = normalizeDelegateRequest(requestInput as DelegateAgentRequest | string);
      let repoId = repoIds[0];
      if (request.repo) {
        repoId = request.repo;
      } else if (request.taskContract) {
        for (const id of repoIds) {
          if (request.taskContract.includes(`${id}:`)) {
            repoId = id;
            break;
          }
        }
      }
      if (!repoToolsById[repoId]) {
        throw new Error(`Unknown repo "${repoId}". Available repos: ${repoIds.join(", ")}`);
      }

      const stripPrefix = (value: string) => value.replace(new RegExp(`\\b${repoId}:`, "g"), "");
      const routedRequest: DelegateAgentRequest = {
        ...request,
        taskContract: stripPrefix(request.taskContract),
        allowedFiles: request.allowedFiles?.map(stripPrefix),
        forbiddenFiles: request.forbiddenFiles?.map(stripPrefix),
      };
      return repoToolsById[repoId].delegateAgent(routedRequest);
    },

    editFile(namespacedPath: unknown, oldString: unknown, newString: unknown, opts?: unknown) {
      const r = route(namespacedPath as string);
      return r.tools.editFile(r.relPath, oldString as string, newString as string, opts as EditFileOpts | string);
    },

    editFileRange(namespacedPath: unknown, startLine: unknown, endLine: unknown, newText: unknown) {
      const r = route(namespacedPath as string);
      return r.tools.editFileRange(r.relPath, startLine as number, endLine as number, newText as string);
    },

    writeFile(namespacedPath: unknown, content: unknown) {
      // Write a file safely — avoids heredoc escaping issues with bash.
      // Path must use "repoId:relative/path" format.
      const r = route(namespacedPath as string);
      return r.tools.writeFile(r.relPath, content as string);
    },
  };
}
