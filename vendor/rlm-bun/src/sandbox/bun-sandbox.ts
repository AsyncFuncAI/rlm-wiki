import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { z } from "zod";
import {
  encode,
  createMessageBuffer,
  MSG_OUTPUT,
  MSG_ERROR,
  MSG_SUBMIT,
  MSG_TOOL_CALL,
  MSG_READY,
} from "./protocol.ts";
import type { MessageBuffer } from "./protocol.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(__dirname, "worker.ts");

/** Zod schema for BunSandbox constructor options */
export const BunSandboxOptionsSchema = z.object({
  timeout: z.number().optional(),
  maxOutputChars: z.number().optional().default(10_000),
  tools: z.record(z.string(), z.function()).optional().default({}),
  maxRestarts: z.number().optional().default(3),
  onToolCall: z.function().nullable().optional().default(null),
});

export type BunSandboxOptions = z.infer<typeof BunSandboxOptionsSchema>;

export interface ToolCallEvent {
  name: string;
  args?: unknown[];
  phase: "start" | "done" | "error";
  executionMode?: "execute" | "probe" | null;
  error?: string;
  durationMs?: number;
}

export interface ExecuteResult {
  type: "output" | "error" | "submit";
  output?: string;
  /** Full, un-truncated output for durable session storage */
  rawOutput?: string;
  outputs?: Record<string, unknown>;
}

export interface ExecuteProbeOptions {
  timeout?: number;
  maxOutputChars?: number;
}

interface Injection {
  type: "value" | "function";
  name: string;
  serialized?: string;
  source?: string;
}

/**
 * Manages a persistent Bun subprocess for code execution.
 * LLM-generated code runs here with injected tools and repo data.
 */
export class BunSandbox {
  timeout: number | null;
  maxOutputChars: number;
  tools: Record<string, (...args: unknown[]) => unknown>;
  maxRestarts: number;
  onToolCall: ((...args: unknown[]) => void) | null;

  proc: ReturnType<typeof Bun.spawn> | null;
  msgBuffer: MessageBuffer | null;
  private _reader: ReadableStreamDefaultReader<Uint8Array> | null;
  private _decoder: TextDecoder;
  _alive: boolean;
  private _restartCount: number;

  private _pendingResolve: ((msg: Record<string, unknown>) => void) | null;
  private _pendingReject: ((err: Error) => void) | null;

  _injections: Injection[];

  constructor(opts: Partial<BunSandboxOptions> = {}) {
    this.timeout = opts.timeout ?? null;
    this.maxOutputChars = opts.maxOutputChars || 10_000;
    this.tools = (opts.tools as Record<string, (...args: unknown[]) => unknown>) || {};
    this.maxRestarts = opts.maxRestarts ?? 3;
    this.onToolCall = (opts.onToolCall as ((...args: unknown[]) => void) | null) || null;

    this.proc = null;
    this.msgBuffer = null;
    this._reader = null;
    this._decoder = new TextDecoder();
    this._alive = false;
    this._restartCount = 0;

    this._pendingResolve = null;
    this._pendingReject = null;

    this._injections = [];
  }

  /** Start the worker subprocess and wait for it to be ready. */
  async start(): Promise<void> {
    await this._spawn();
  }

  async _spawn(): Promise<void> {
    this.proc = Bun.spawn(["bun", "run", WORKER_PATH], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    this.msgBuffer = createMessageBuffer();
    this._alive = true;
    this._reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader();

    this._readLoop();

    await this._waitForMessage(MSG_READY, 10_000);
  }

  /** Background loop that continuously reads stdout and dispatches messages. */
  async _readLoop(): Promise<void> {
    try {
      while (this._alive) {
        const { done, value } = await this._reader!.read();
        if (done) {
          this._alive = false;
          this._rejectPending(new Error("Sandbox process ended unexpectedly"));
          break;
        }

        this.msgBuffer!.push(this._decoder.decode(value, { stream: true }));
        this._drainMessages();
      }
    } catch (err) {
      if (this._alive) {
        this._alive = false;
        this._rejectPending(err as Error);
      }
    }
  }

  /** Process all complete messages from the buffer. */
  _drainMessages(): void {
    const msgs = this.msgBuffer!.drain();
    for (const msg of msgs) {
      this._dispatchMessage(msg);
    }
  }

  /** Route a message to the appropriate handler. */
  _dispatchMessage(msg: Record<string, unknown>): void {
    if (msg.type === MSG_TOOL_CALL) {
      this._handleToolCallMessage(msg);
      return;
    }

    if (this._pendingResolve) {
      const resolve = this._pendingResolve;
      this._pendingResolve = null;
      this._pendingReject = null;
      resolve(msg);
    }
  }

  _rejectPending(err: Error): void {
    if (this._pendingReject) {
      const reject = this._pendingReject;
      this._pendingResolve = null;
      this._pendingReject = null;
      reject(err);
    }
  }

  _handleToolCallMessage(msg: Record<string, unknown>): void {
    void this._handleToolCall(msg).catch((err) => {
      this._rejectPending(err instanceof Error ? err : new Error(String(err)));
    });
  }

  /** Send a message to the worker. */
  _send(msg: Record<string, unknown>): void {
    if (!this._alive || !this.proc) {
      throw new Error("Sandbox is not running");
    }
    (this.proc.stdin as import('bun').FileSink).write(encode(msg));
  }

  /** Wait for the next message from the worker. */
  _waitForMessage(expectedType: string | null, timeout?: number): Promise<Record<string, unknown>> {
    const ms = timeout !== undefined ? timeout : (this.timeout ?? undefined);

    return new Promise((resolve, reject) => {
      // drain existing messages first
      const msgs = this.msgBuffer!.drain();
      for (const msg of msgs) {
        if (msg.type === MSG_TOOL_CALL) {
          this._handleToolCallMessage(msg);
          continue;
        }
        return resolve(msg);
      }

      const timer = ms !== undefined
        ? setTimeout(() => {
            if (this._pendingReject) {
              this._pendingResolve = null;
              const rej = this._pendingReject;
              this._pendingReject = null;
              rej(new Error(`Sandbox timeout (${ms}ms) waiting for ${expectedType || "any"} message`));
            }
          }, ms)
        : null;

      this._pendingResolve = (msg: Record<string, unknown>) => {
        if (timer !== null) clearTimeout(timer);
        resolve(msg);
      };
      this._pendingReject = (err: Error) => {
        if (timer !== null) clearTimeout(timer);
        reject(err);
      };
    });
  }

  /** Handle a tool_call from the worker by executing the tool on the host. */
  async _handleToolCall(msg: Record<string, unknown>): Promise<void> {
    const { name, args, callId, executionMode } = msg as {
      name: string;
      args: unknown[];
      callId: number;
      executionMode?: "execute" | "probe" | null;
    };
    const tool = this.tools[name];

    if (!tool) {
      this._send({
        type: "tool_result",
        callId,
        result: `Error: Unknown tool "${name}"`,
      });
      return;
    }

    const startMs = Date.now();
    if (this.onToolCall) {
      try { this.onToolCall({ name, args, phase: "start", executionMode } as ToolCallEvent); } catch { }
    }

    try {
      const result = await tool(...(Array.isArray(args) ? args : [args]));
      let envelope: string;
      if (typeof result === "string") {
        envelope = JSON.stringify({ __t: "s", v: result });
      } else {
        envelope = JSON.stringify({ __t: "j", v: JSON.stringify(result) });
      }
      this._send({
        type: "tool_result",
        callId,
        result: envelope,
      });

      if (this.onToolCall) {
        try { this.onToolCall({ name, phase: "done", executionMode, durationMs: Date.now() - startMs } as ToolCallEvent); } catch { }
      }
    } catch (err) {
      this._send({
        type: "tool_result",
        callId,
        result: JSON.stringify({ __t: "s", v: `Error in tool ${name}: ${(err as Error).message}` }),
      });

      if (this.onToolCall) {
        try { this.onToolCall({ name, phase: "error", executionMode, error: (err as Error).message, durationMs: Date.now() - startMs } as ToolCallEvent); } catch { }
      }
    }
  }

  /** Execute JavaScript code in the sandbox. */
  async execute(code: string): Promise<ExecuteResult> {
    if (!this._alive) {
      const restarted = await this._tryRestart();
      if (!restarted) {
        return {
          type: "error",
          output: "Sandbox crashed and could not be restarted",
          rawOutput: "Sandbox crashed and could not be restarted",
        };
      }
    }

    try {
      this._send({ type: "execute", code });
      const msg = await this._waitForMessage(null);

      if (msg.type === MSG_SUBMIT) {
        return { type: "submit", outputs: msg.outputs as Record<string, unknown> };
      }

      if (msg.type === MSG_ERROR) {
        const errStr = msg.error as string;
        return { type: "error", output: errStr, rawOutput: errStr };
      }

      const raw = (msg.output as string) || "";
      return {
        type: "output",
        output: truncateOutput(raw, this.maxOutputChars),
        rawOutput: raw,
      };
    } catch (err) {
      const errMsg = `Sandbox crashed: ${(err as Error).message}. Will auto-restart on next execute().`;
      if (!this._alive && this._restartCount < this.maxRestarts) {
        return { type: "error", output: errMsg, rawOutput: errMsg };
      }
      const sandboxErr = `Sandbox error: ${(err as Error).message}`;
      return { type: "error", output: sandboxErr, rawOutput: sandboxErr };
    }
  }

  /**
   * Execute a tiny just-in-time probe in the same sandbox.
   *
   * Probe results are intentionally capped and SUBMIT is disallowed. This gives
   * the agent a cheap way to inspect live variables/session facts without
   * spending a full major RLM step or producing a final answer accidentally.
   */
  async executeProbe(code: string, opts: ExecuteProbeOptions = {}): Promise<ExecuteResult> {
    if (/\bSUBMIT\s*\(/.test(code)) {
      return {
        type: "error",
        output: "JIT probe cannot call SUBMIT; write a normal ```js step to submit.",
        rawOutput: "JIT probe cannot call SUBMIT; write a normal ```js step to submit.",
      };
    }

    if (!this._alive) {
      const restarted = await this._tryRestart();
      if (!restarted) {
        return {
          type: "error",
          output: "Sandbox crashed and could not be restarted",
          rawOutput: "Sandbox crashed and could not be restarted",
        };
      }
    }

    const maxOutputChars = opts.maxOutputChars ?? Math.min(this.maxOutputChars, 4_000);

    try {
      this._send({ type: "probe", code });
      const msg = await this._waitForMessage(null, opts.timeout);

      if (msg.type === MSG_SUBMIT) {
        return {
          type: "error",
          output: "JIT probe attempted to submit; ignored.",
          rawOutput: "JIT probe attempted to submit; ignored.",
        };
      }

      if (msg.type === MSG_ERROR) {
        const errStr = truncateOutput(msg.error as string, maxOutputChars);
        return { type: "error", output: errStr, rawOutput: errStr };
      }

      const raw = (msg.output as string) || "";
      const capped = truncateOutput(raw, maxOutputChars);
      return {
        type: "output",
        output: capped,
        rawOutput: capped,
      };
    } catch (err) {
      const errMsg = `JIT probe error: ${(err as Error).message}`;
      return { type: "error", output: errMsg, rawOutput: errMsg };
    }
  }

  /** Attempt to restart the worker after a crash. Replays all injections to restore state. */
  async _tryRestart(): Promise<boolean> {
    if (this._restartCount >= this.maxRestarts) {
      return false;
    }
    this._restartCount++;

    try {
      try {
        this.proc?.kill();
      } catch { }

      await this._spawn();

      for (const inj of this._injections) {
        if (inj.type === "value") {
          this._send({
            type: "inject",
            name: inj.name,
            valueType: "value",
            value: inj.serialized,
          });
          await this._waitForMessage(MSG_OUTPUT, 5_000);
        } else {
          this._send({
            type: "inject",
            name: inj.name,
            valueType: "function",
            source: inj.source,
          });
          await this._waitForMessage(MSG_OUTPUT, 5_000);
        }
      }

      return true;
    } catch {
      return false;
    }
  }

  /** Inject a JSON-serializable variable into the worker's global scope. */
  async inject(name: string, value: unknown): Promise<void> {
    const serialized = JSON.stringify(value);
    this._injections.push({ type: "value", name, serialized });

    this._send({
      type: "inject",
      name,
      valueType: "value",
      value: serialized,
    });
    await this._waitForMessage(MSG_OUTPUT);
  }

  /** Inject a function source into the worker's global scope. */
  async injectFunction(name: string, source: string): Promise<void> {
    this._injections.push({ type: "function", name, source });

    this._send({
      type: "inject",
      name,
      valueType: "function",
      source,
    });
    await this._waitForMessage(MSG_OUTPUT);
  }

  /** Shut down the worker subprocess. */
  async shutdown(): Promise<void> {
    this._alive = false;
    this._rejectPending(new Error("Sandbox shut down"));
    if (this._reader) {
      try {
        this._reader.releaseLock();
      } catch { }
      this._reader = null;
    }
    if (this.proc) {
      try {
        this.proc.kill();
      } catch { }
      this.proc = null;
    }
  }
}

/**
 * Smart line-aware output truncation.
 * Keeps the first and last lines, with a truncation notice in between.
 */
export function truncateOutput(output: string, maxChars: number): string {
  if (!output || output.length <= maxChars) return output;

  const lines = output.split("\n");

  if (lines.length <= 3) {
    const half = Math.floor(maxChars / 2);
    const dropped = output.length - maxChars;
    return (
      output.slice(0, half) +
      `\n...[truncated ${dropped.toLocaleString()} chars]...\n` +
      output.slice(-half)
    );
  }

  const headLines: string[] = [];
  const tailLines: string[] = [];
  let headChars = 0;
  let tailChars = 0;
  const budget = Math.floor(maxChars / 2);

  for (const line of lines) {
    if (headChars + line.length + 1 > budget) break;
    headLines.push(line);
    headChars += line.length + 1;
  }

  for (let i = lines.length - 1; i >= 0; i--) {
    if (tailChars + lines[i].length + 1 > budget) break;
    tailLines.unshift(lines[i]);
    tailChars += lines[i].length + 1;
  }

  const droppedLines = lines.length - headLines.length - tailLines.length;
  const droppedChars = output.length - headChars - tailChars;

  if (droppedLines <= 0) return output;

  return (
    headLines.join("\n") +
    `\n...[truncated ${droppedLines} lines, ${droppedChars.toLocaleString()} chars]...\n` +
    tailLines.join("\n")
  );
}
