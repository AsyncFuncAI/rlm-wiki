import { describe, expect, test } from "bun:test";
import { AnthropicClient } from "./anthropic.ts";

describe("Anthropic Agent SDK diagnostics", () => {
  test("pipes Claude Code stderr into wrapped SDK errors", () => {
    const client = new AnthropicClient({ apiKey: "test-key" }) as unknown as {
      _buildQueryOptions(): { stderr?: (data: string) => void };
      _wrapSDKError(error: unknown): never;
    };
    const options = client._buildQueryOptions();

    expect(typeof options.stderr).toBe("function");
    options.stderr?.("auth expired on stderr\n");
    expect(() => client._wrapSDKError(new Error("claude exited with 1: no stderr"))).toThrow(/Claude Code stderr:\nauth expired/);
  });
});
