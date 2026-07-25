// Sentinel markers for sandbox ↔ host communication.
// These are used as JSON message `type` fields over stdin/stdout.

export const MSG_OUTPUT: string = "output";
export const MSG_ERROR: string = "error";
export const MSG_SUBMIT: string = "submit";
export const MSG_TOOL_CALL: string = "tool_call";
export const MSG_READY: string = "ready";

// Delimiter between JSON messages on the wire.
// We use a rare string unlikely to appear in code output.
export const MSG_DELIMITER: string = "\n__RLM_MSG_BOUNDARY__\n";

/**
 * Encode a message for sending over the pipe.
 */
export function encode(msg: Record<string, unknown>): string {
  return JSON.stringify(msg) + MSG_DELIMITER;
}

export interface MessageBuffer {
  push: (chunk: string) => void;
  drain: () => Record<string, unknown>[];
}

/**
 * Create a message buffer that accumulates raw chunks and yields complete messages.
 */
export function createMessageBuffer(): MessageBuffer {
  let buffer = "";

  return {
    push(chunk: string): void {
      buffer += chunk;
    },
    drain(): Record<string, unknown>[] {
      const messages: Record<string, unknown>[] = [];
      let idx: number;
      while ((idx = buffer.indexOf(MSG_DELIMITER)) !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + MSG_DELIMITER.length);
        if (raw.trim()) {
          try {
            messages.push(JSON.parse(raw) as Record<string, unknown>);
          } catch (e) {
            messages.push({ type: MSG_ERROR, error: `JSON parse error: ${(e as Error).message}\nRaw: ${raw.slice(0, 200)}` });
          }
        }
      }
      return messages;
    },
  };
}

