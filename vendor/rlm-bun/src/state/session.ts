/**
 * Session — A durable, append-only event log for the RLM execution loop.
 *
 * Inspired by Anthropic's Managed Agents architecture:
 *   "The Session: The single source of truth. A persistent, durable event log
 *    that lives outside of both the sandbox and the LLM."
 *
 * The Session stores every reasoning step, code block, raw output, and tool call
 * durably. The agent can query its own history via getSessionEvents(), avoiding
 * the irreversible data loss caused by context window summarization. Display
 * surfaces are still capped, so prompts should steer agents toward targeted
 * searches/slices and JIT peeks instead of printing entire stored outputs.
 *
 * Storage backends:
 *   - FileSession: append-only JSONL on local filesystem (Phase 1)
 *   - S3Session: uploads the session JSONL to an S3 bucket using AWS SDK v3
 */

import { existsSync, readFileSync, appendFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { randomBytes } from "crypto";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

// ── Event Types ──────────────────────────────────────────────────────

export type SessionEventType =
  | "reasoning"
  | "code"
  | "output"
  | "error"
  | "jit"
  | "submit"
  | "tool-call"
  | "tool-result"
  | "status";

export interface SessionEvent {
  /** Monotonically increasing sequence number */
  id: number;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Event type */
  type: SessionEventType;
  /** Which iteration (step) produced this event */
  step: number;
  /** The stored event data. Display layers may still cap printed output. */
  content: string;
  /** Optional structured metadata */
  metadata?: SessionEventMetadata;
}

export interface SessionEventMetadata {
  definedVars?: string[];
  readFiles?: string[];
  toolCounts?: Record<string, number>;
  keyFindings?: string;
  toolName?: string;
  durationMs?: number;
  resultType?: string;
  llmCalls?: number;
  llmCallBudget?: number;
}

// ── Query Options ────────────────────────────────────────────────────

export interface SessionQueryOpts {
  /** Retrieve events from a specific step */
  step?: number;
  /** Range start (inclusive) */
  fromStep?: number;
  /** Range end (inclusive) */
  toStep?: number;
  /** Filter by event type */
  type?: SessionEventType;
  /** Return only the last N events */
  last?: number;
  /** Max content length returned per event (truncates for context window safety) */
  maxContentLength?: number;
}

// ── Session Interface ────────────────────────────────────────────────

export interface Session {
  readonly id: string;
  readonly eventCount: number;

  /** Append an event to the session log. Called by the harness. */
  emit(event: Omit<SessionEvent, "id" | "timestamp">): SessionEvent;

  /** Query events from the session log. Exposed as a sandbox tool. */
  getEvents(opts?: SessionQueryOpts): SessionEvent[];

  /** Get a specific step's events */
  getStep(step: number): SessionEvent[];

  /** Build a constant-size prompt summary for the LLM context window. */
  summarize(lastNFull?: number): string;

  /** Total number of distinct steps recorded */
  stepCount(): number;

  /** Persist to storage (no-op if already durable per-write) */
  save(): Promise<void>;
}

// ── FileSession Implementation ───────────────────────────────────────

/**
 * Append-only JSONL-backed session.
 *
 * Each event is appended as a single JSON line to `{sessionDir}/{sessionId}.jsonl`.
 * Reads are served from an in-memory cache that stays in sync with the file.
 *
 * When mounted on S3 Files, this exact class provides durable, shared sessions
 * with no code changes — the NFS mount handles sync, durability, and sharing.
 */
export class FileSession implements Session {
  readonly id: string;
  private _events: SessionEvent[] = [];
  private _nextId = 0;
  private _filePath: string;

  constructor(opts: { id?: string; sessionDir?: string }) {
    this.id = opts.id || generateSessionId();
    const dir = opts.sessionDir || join(process.cwd(), ".rlm-sessions");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this._filePath = join(dir, `${this.id}.jsonl`);

    // If resuming an existing session, load it
    if (existsSync(this._filePath)) {
      this._loadFromFile();
    }
  }

  get eventCount(): number {
    return this._events.length;
  }

  get filePath(): string {
    return this._filePath;
  }

  emit(partial: Omit<SessionEvent, "id" | "timestamp">): SessionEvent {
    const event: SessionEvent = {
      id: this._nextId++,
      timestamp: new Date().toISOString(),
      ...partial,
    };
    this._events.push(event);
    // Durably append to JSONL — one line per event
    appendFileSync(this._filePath, JSON.stringify(event) + "\n");
    return event;
  }

  getEvents(opts: SessionQueryOpts = {}): SessionEvent[] {
    let results = [...this._events];

    // Filter by step
    if (opts.step !== undefined) {
      const maxStep = this._events.length > 0 ? Math.max(...this._events.map(e => e.step)) : -1;
      if (opts.step > maxStep) {
        throw new Error(`getSessionEvents: step ${opts.step} requested, but maximum recorded step is ${maxStep}.`);
      }
      results = results.filter(e => e.step === opts.step);
    }

    // Filter by step range
    if (opts.fromStep !== undefined) {
      results = results.filter(e => e.step >= opts.fromStep!);
    }
    if (opts.toStep !== undefined) {
      results = results.filter(e => e.step <= opts.toStep!);
    }

    // Filter by type
    if (opts.type) {
      results = results.filter(e => e.type === opts.type);
    }

    // Last N
    if (opts.last !== undefined && opts.last > 0) {
      results = results.slice(-opts.last);
    }

    // Truncate content if requested (for context window safety)
    if (opts.maxContentLength && opts.maxContentLength > 0) {
      results = results.map(e => {
        if (e.content.length > opts.maxContentLength!) {
          return {
            ...e,
            content:
              e.content.slice(0, opts.maxContentLength!) +
              `\n...[truncated ${(e.content.length - opts.maxContentLength!).toLocaleString()} chars — do not print full event content; use a targeted search, slice, or JIT peek]`,
          };
        }
        return e;
      });
    }

    return results;
  }

  getStep(step: number): SessionEvent[] {
    return this._events.filter(e => e.step === step);
  }

  stepCount(): number {
    if (this._events.length === 0) return 0;
    const steps = new Set(this._events.map(e => e.step));
    return steps.size;
  }

  summarize(lastNFull: number = 3): string {
    if (this._events.length === 0) return "(no session events yet)";

    const maxStep = Math.max(...this._events.map(e => e.step));
    const totalSteps = this.stepCount();

    const parts: string[] = [];
    parts.push(`Session: ${this.id} — ${this._events.length} events across ${totalSteps} steps`);

    // Determine which steps get full detail vs summary
    const fullDetailThreshold = maxStep - lastNFull + 1;

    // Summarize older steps (1-line each)
    const oldSteps = new Set<number>();
    for (const e of this._events) {
      if (e.step < fullDetailThreshold) oldSteps.add(e.step);
    }

    if (oldSteps.size > 0) {
      parts.push("");
      parts.push("--- Earlier steps (summarized) ---");
      for (const step of [...oldSteps].sort((a, b) => a - b)) {
        const stepEvents = this._events.filter(e => e.step === step);
        const summary = this._summarizeStep(step, stepEvents);
        parts.push(summary);
      }
    }

    // Full detail for recent steps
    const recentSteps = new Set<number>();
    for (const e of this._events) {
      if (e.step >= fullDetailThreshold) recentSteps.add(e.step);
    }

    if (recentSteps.size > 0) {
      parts.push("");
      parts.push("--- Recent steps (full detail) ---");
      for (const step of [...recentSteps].sort((a, b) => a - b)) {
        const stepEvents = this._events.filter(e => e.step === step);
        parts.push(this._formatStepFull(step, stepEvents));
      }
    }

    parts.push("");
    parts.push("💡 Use `await getSessionEvents({ step: N })` to locate past data, then search/slice only the narrow fact you need.");
    parts.push("💡 If a summary says output was truncated, use one `<JIT>...</JIT>` peek with `vars()`, `rg`, `inspect`, `listSymbols`, `readFileRange`, or a targeted search over event content.");

    return parts.join("\n");
  }

  async save(): Promise<void> {
    // Already durable per-write via appendFileSync — this is a no-op.
    // Exists for interface completeness and future backends that batch writes.
  }

  // ── Private helpers ──────────────────────────────────────────────

  private _loadFromFile(): void {
    const content = readFileSync(this._filePath, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    this._events = [];
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as SessionEvent;
        this._events.push(event);
      } catch {
        // Skip malformed lines
      }
    }
    this._nextId = this._events.length > 0
      ? Math.max(...this._events.map(e => e.id)) + 1
      : 0;
  }

  private _summarizeStep(step: number, events: SessionEvent[]): string {
    const parts: string[] = [`  Step ${step}:`];

    // Defined vars
    const vars = events
      .filter(e => e.metadata?.definedVars?.length)
      .flatMap(e => e.metadata!.definedVars!);
    if (vars.length > 0) {
      parts.push(`Defined [${vars.join(", ")}].`);
    }

    // Read files
    const files = events
      .filter(e => e.metadata?.readFiles?.length)
      .flatMap(e => e.metadata!.readFiles!);
    if (files.length > 0) {
      const fileList = files.length <= 5
        ? files.join(", ")
        : files.slice(0, 4).join(", ") + ` +${files.length - 4} more`;
      parts.push(`Read [${fileList}].`);
    }

    const toolCounts = events.find(e => e.metadata?.toolCounts)?.metadata?.toolCounts;
    if (toolCounts && Object.keys(toolCounts).length > 0) {
      const tools = Object.entries(toolCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, count]) => `${name}×${count}`)
        .join(", ");
      parts.push(`Tools [${tools}].`);
    }

    const jitCount = events.filter(e => e.type === "jit").length;
    if (jitCount > 0) {
      parts.push(`JIT peeks ×${jitCount}.`);
    }

    // Key findings or reasoning snippet
    const finding = events.find(e => e.metadata?.keyFindings);
    if (finding) {
      parts.push(finding.metadata!.keyFindings!);
    } else {
      const reasoning = events.find(e => e.type === "reasoning");
      if (reasoning) {
        const snippet = reasoning.content.slice(0, 100);
        parts.push(snippet + (reasoning.content.length > 100 ? "..." : ""));
      }
    }

    return parts.join(" ");
  }

  private _formatStepFull(step: number, events: SessionEvent[]): string {
    const parts: string[] = [`=== Step ${step} ===`];

    const reasoning = events.find(e => e.type === "reasoning");
    if (reasoning) parts.push(`Reasoning: ${reasoning.content}`);

    const code = events.find(e => e.type === "code");
    if (code) {
      parts.push("Code:");
      parts.push("```js");
      parts.push(code.content);
      parts.push("```");
    }

    const jitEvents = events.filter(e => e.type === "jit");
    for (const jit of jitEvents) {
      parts.push("JIT peek:");
      parts.push(jit.content);
    }

    const output = events.find(e => e.type === "output" || e.type === "error");
    if (output) {
      // Truncate output in the summary to avoid ballooning the prompt
      const maxSummaryOutput = 5000;
      let content = output.content;
      if (content.length > maxSummaryOutput) {
        const half = Math.floor(maxSummaryOutput / 2);
        content =
          content.slice(0, half) +
          `\n...[truncated ${(content.length - maxSummaryOutput).toLocaleString()} chars — use JIT plus targeted search/slice, not full output replay]...\n` +
          content.slice(-half);
      }
      parts.push(`Output (${output.content.length} chars):`);
      parts.push(content);
    }

    return parts.join("\n");
  }

  // ── Static factory ───────────────────────────────────────────────

  /**
   * Load an existing session from a JSONL file.
   */
  static load(filePath: string): FileSession {
    if (!existsSync(filePath)) {
      throw new Error(`Session file not found: ${filePath}`);
    }
    // Extract session ID from filename
    const filename = filePath.split("/").pop()!;
    const id = filename.replace(/\.jsonl$/, "");
    const sessionDir = dirname(filePath);

    return new FileSession({ id, sessionDir });
  }
}

// ── S3Session Implementation ────────────────────────────────────────

export class S3Session extends FileSession {
  private _s3: S3Client;
  private _bucket: string;

  constructor(opts: { id?: string; sessionDir?: string; bucket: string; region?: string }) {
    super(opts);
    this._bucket = opts.bucket;
    this._s3 = new S3Client({ region: opts.region });
  }

  async save(): Promise<void> {
    await super.save();
    const content = readFileSync(this.filePath, "utf-8");
    await this._s3.send(
      new PutObjectCommand({
        Bucket: this._bucket,
        Key: `sessions/${this.id}.jsonl`,
        Body: content,
      })
    );
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function generateSessionId(): string {
  const ts = Date.now().toString(36);
  const rand = randomBytes(4).toString("hex");
  return `rlm-${ts}-${rand}`;
}
