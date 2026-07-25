import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

export interface LspMessage {
  jsonrpc: string;
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

export class LspClient extends EventEmitter {
  process: ChildProcess;
  messageId: number;
  pendingRequests: Map<number, PendingRequest>;
  buffer: Buffer;
  openFiles: Set<string>;

  constructor(process: ChildProcess) {
    super();
    this.process = process;
    this.messageId = 1;
    this.pendingRequests = new Map();
    this.buffer = Buffer.alloc(0);
    this.openFiles = new Set();

    this.readLoop();
  }

  async readLoop(): Promise<void> {
    const stdout = this.process.stdout;
    if (!stdout) {
      console.error("LSP read error: process.stdout is null");
      return;
    }

    stdout.on('data', (chunk: Buffer | Uint8Array) => {
      this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
      this.processBuffer();
    });

    stdout.on('error', (err: Error) => {
      console.error("LSP stdout error:", err.message);
    });
  }

  processBuffer(): void {
    while (true) {
      const match = this.buffer.toString('ascii').match(/Content-Length: (\d+)\r\n\r\n/);
      if (!match) break;

      const headerLength = match[0].length;
      const contentLength = parseInt(match[1], 10);
      const totalLength = headerLength + contentLength;

      if (this.buffer.length < totalLength) break;

      const messageBuffer = this.buffer.subarray(headerLength, totalLength);
      this.buffer = this.buffer.subarray(totalLength);

      try {
        const message = JSON.parse(messageBuffer.toString('utf-8')) as LspMessage;
        this.handleMessage(message);
      } catch (err) {
        console.error("Failed to parse LSP message:", err);
      }
    }
  }

  handleMessage(message: LspMessage): void {
    if (message.id !== undefined && this.pendingRequests.has(message.id)) {
      const { resolve, reject } = this.pendingRequests.get(message.id)!;
      this.pendingRequests.delete(message.id);
      if (message.error) {
        reject(message.error);
      } else {
        resolve(message.result);
      }
    } else {
      this.emit('notification', message);
    }
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.messageId++;
    const message: LspMessage = { jsonrpc: "2.0", id, method, params };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.write(message);
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  write(message: LspMessage): void {
    const json = JSON.stringify(message);
    const payload = `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`;

    if (this.process.stdin && typeof (this.process.stdin as any).write === 'function') {
      (this.process.stdin as any).write(payload);
    } else if (this.process.stdin && typeof (this.process.stdin as any).getWriter === 'function') {
      const writer = (this.process.stdin as any).getWriter();
      writer.write(new TextEncoder().encode(payload));
      writer.releaseLock();
    }
  }

  kill(): void {
    this.process.kill();
  }
}

