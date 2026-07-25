/**
 * MCP Tools Factory — bridges MCP server tools into the rlm-bun host tool registry.
 *
 * Each MCP tool becomes a callable: mcp__<server>__<tool>(args) → result
 * A meta-tool `list_mcp_tools()` lets the agent self-discover available MCP tools.
 *
 * Follows the same factory pattern as makeLLMTools / makeLSPTools / makeWebSearchTool.
 */

import type { MCPConnection } from "./client.ts";

export interface MCPToolInfo {
    server: string;
    tool: string;
    callAs: string;
    description: string;
    inputSchema: unknown;
}

/**
 * Sanitize a name to be a valid JavaScript identifier fragment.
 * Replaces hyphens, dots, and other non-alphanumeric/underscore chars with underscores.
 * E.g. "chrome-devtools" → "chrome_devtools"
 */
export function sanitizeName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_]/g, "_");
}

/**
 * Build host tool functions from MCP connections.
 *
 * @param connections - Active MCP connections with discovered tools
 * @returns Record of tool functions keyed by `mcp__<server>__<tool>` plus `list_mcp_tools`
 */
export function makeMCPTools(
    connections: MCPConnection[]
): Record<string, (...args: any[]) => Promise<unknown>> {
    const toolMap: Record<string, (...args: any[]) => Promise<unknown>> = {};

    for (const conn of connections) {
        const safeName = sanitizeName(conn.name);
        for (const tool of conn.tools) {
            // Namespaced key: mcp__chrome_devtools__navigate_page
            const toolKey = `mcp__${safeName}__${sanitizeName(tool.name)}`;

            toolMap[toolKey] = async (args: Record<string, unknown> = {}) => {
                const callArgs = normalizeMCPCallArgs(tool.name, args);
                let result: any;
                try {
                    result = await conn.client.callTool({
                        name: tool.name,
                        arguments: callArgs,
                    });
                } catch (err) {
                    throw new Error(formatMCPToolFailure(conn.name, tool.name, toolKey, tool.inputSchema, callArgs, err));
                }

                // MCP callTool returns { content: [...], isError?: boolean }
                if (result.isError) {
                    throw new Error(formatMCPToolFailure(conn.name, tool.name, toolKey, tool.inputSchema, callArgs, result.content));
                }

                return normalizeMCPToolResult(tool.name, result);
            };
        }
    }

    const allToolInfos = (): MCPToolInfo[] => connections.flatMap((conn) => {
        const safeName = sanitizeName(conn.name);
        return conn.tools.map((t) => ({
            server: conn.name,
            tool: t.name,
            callAs: `mcp__${safeName}__${sanitizeName(t.name)}`,
            description: t.description ?? "",
            inputSchema: t.inputSchema,
        }));
    });

    // Meta-tool: list all available MCP tools with schemas
    toolMap["list_mcp_tools"] = async (): Promise<MCPToolInfo[]> => {
        return allToolInfos();
    };

    // Meta-tool: exact schema lookup after discovery. This is intentionally
    // small and predictable so agents do not need to dump every MCP schema when
    // they only need one tool's required fields.
    toolMap["mcp_tool_schema"] = async (selector?: string): Promise<MCPToolInfo | MCPToolInfo[]> => {
        const infos = allToolInfos();
        const raw = String(selector ?? "").trim();
        if (!raw) return infos;

        const needle = normalizeToolSelector(raw);
        const exact = infos.find((info) => {
            const keys = [
                info.callAs,
                info.tool,
                `${info.server}:${info.tool}`,
                `${info.server}.${info.tool}`,
                `${sanitizeName(info.server)}:${sanitizeName(info.tool)}`,
                `${sanitizeName(info.server)}.${sanitizeName(info.tool)}`,
            ].map(normalizeToolSelector);
            return keys.includes(needle);
        });
        if (exact) return exact;

        const partial = infos.filter((info) =>
            normalizeToolSelector(info.callAs).includes(needle) ||
            normalizeToolSelector(info.tool).includes(needle)
        );
        if (partial.length > 0) return partial;

        const available = infos.slice(0, 20).map((info) => info.callAs).join(", ");
        throw new Error(`No MCP tool matched ${JSON.stringify(raw)}. Try list_mcp_tools(). Available examples: ${available}${infos.length > 20 ? ", ..." : ""}`);
    };

    return toolMap;
}

/**
 * Build a system prompt section describing available MCP tools.
 *
 * This text is injected into the system prompt so the agent knows
 * which MCP tools exist, what they do, and how to call them.
 */
export function buildMCPPromptSection(connections: MCPConnection[]): string {
    if (connections.length === 0) return "";

    const sections: string[] = [];
    sections.push("## MCP Tools (Model Context Protocol)");
    sections.push("You have access to external MCP server tools. Call them like any other async tool.");
    sections.push("");
    sections.push("### Discovery:");
    sections.push("- `await list_mcp_tools()` → list all available MCP tools with descriptions and schemas");
    sections.push("- `await mcp_tool_schema(\"mcp__server__tool\")` → exact schema for one MCP tool; use this before first use of any unfamiliar MCP tool");
    sections.push("");
    sections.push("### Schema-first MCP workflow:");
    sections.push("- If a task mentions Slack, Linear, Jira, docs, tickets, customers, incidents, calendars, email, or any external system, discover the relevant MCP tool early with `list_mcp_tools()` or server-specific search tools.");
    sections.push("- Before calling a side-effect tool (send/post/create/update/delete), inspect the exact input schema and resolve target IDs first (for example Slack channel ID before sending). Do not guess argument names from prose examples.");
    sections.push("- If an MCP call fails validation, do not retry by guessing. Call `mcp_tool_schema(...)` for direct MCP tools, or the server's schema lookup tool when using a tool router, then retry with only the required fields. If the same tool or nested slug fails again, stop using it and submit a clean failure/status answer.");
    sections.push("- Your final answer must never be raw MCP JavaScript. For external side effects, say plainly whether the action succeeded. If it succeeded, include the returned id/timestamp/link. If it failed, say it was not completed and include the error/log id.");
    sections.push("- MCP JSON text responses are normalized into objects when possible. Inspect fields directly instead of repeatedly string-slicing JSON.");
    sections.push("");

    for (const conn of connections) {
        if (conn.tools.length === 0) continue;
        const safeName = sanitizeName(conn.name);
        sections.push(`### MCP Server: ${conn.name} (${conn.tools.length} tools)`);
        sections.push("");
        for (const tool of conn.tools) {
            const toolKey = `mcp__${safeName}__${sanitizeName(tool.name)}`;
            const desc = tool.description ? ` — ${tool.description}` : "";
            // Extract parameter info from inputSchema
            const schema = tool.inputSchema as any;
            let params = "";
            if (schema?.properties) {
                const props = Object.entries(schema.properties)
                    .map(([k, v]: [string, any]) => {
                        const required = schema.required?.includes(k) ? "" : "?";
                        return `${k}${required}: ${v.type || "any"}`;
                    })
                    .join(", ");
                params = `{ ${props} }`;
            }
            sections.push(`- \`await ${toolKey}(${params})\`${desc}`);
        }
        sections.push("");
    }

    if (connections.some((conn) => conn.tools.some((tool) => /^COMPOSIO_/i.test(tool.name)))) {
        const composioServer = sanitizeName(connections.find((conn) => conn.tools.some((tool) => /^COMPOSIO_/i.test(tool.name)))?.name || "composio");
        sections.push("### Composio router pattern:");
        sections.push("- `COMPOSIO_SEARCH_TOOLS` finds concrete tool slugs for a use case. Its response is normalized to expose `session_id`, `tools`, and `tool_schemas` at the top level.");
        sections.push("- `COMPOSIO_GET_TOOL_SCHEMAS` returns the exact required arguments for those slugs.");
        sections.push("- `COMPOSIO_MULTI_EXECUTE_TOOL` executes concrete tool slugs. Never pass guessed nested arguments to it; fetch schemas for the nested slugs first. Distinguish the router schema from the nested tool schema; the nested argument object must match the nested slug's required field names exactly.");
        sections.push("- In `COMPOSIO_MULTI_EXECUTE_TOOL`, each nested item must use `arguments`, not `parameters`: `{ tool_slug: \"SLACKBOT_SEND_MESSAGE\", arguments: { channel: \"wiki\", markdown_text: \"...\" } }`.");
        sections.push("- For Slack channel sends, use the literal slug `SLACKBOT_SEND_MESSAGE`. `SLACKBOT_SEND_MESSAGE.channel` accepts a channel name or ID. If the user gave `#wiki`, strip `#` and use `channel: \"wiki\"` with `markdown_text`; only call `SLACKBOT_FIND_CHANNELS` first if the send schema requires an ID or direct send fails.");
        sections.push("- Keep one stable `session_id` across Composio search, schema lookup, connection checks, and execution.");
        sections.push("```js");
        sections.push(`const found = await mcp__${composioServer}__COMPOSIO_SEARCH_TOOLS({ queries: [{ use_case: "post message to Slack channel" }], session: { generate_id: true } });`);
        sections.push(`const schemas = await mcp__${composioServer}__COMPOSIO_GET_TOOL_SCHEMAS({ tool_slugs: ["SLACKBOT_SEND_MESSAGE"], session_id: found.session_id });`);
        sections.push(`await mcp__${composioServer}__COMPOSIO_MULTI_EXECUTE_TOOL({ tools: [{ tool_slug: "SLACKBOT_SEND_MESSAGE", arguments: { channel: "wiki", markdown_text: "Message text" } }], session_id: found.session_id, current_step: "POST_MESSAGE" });`);
        sections.push("```");
        sections.push("");
    }

    const exampleServer = sanitizeName(connections[0]?.name || "server");
    const exampleTool = sanitizeName(connections[0]?.tools[0]?.name || "tool");
    sections.push("**Usage pattern**: Call MCP tools with a single object argument:");
    sections.push("```js");
    sections.push(`const result = await mcp__${exampleServer}__${exampleTool}({ param: "value" });`);
    sections.push("console.log(result);");
    sections.push("```");
    sections.push("");

    return sections.join("\n") + "\n";
}

function normalizeToolSelector(value: string): string {
    return value
        .trim()
        .replace(/^await\s+/, "")
        .replace(/\(.*$/, "")
        .toLowerCase();
}

function normalizeMCPCallArgs(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
    if (!/^COMPOSIO_MULTI_EXECUTE_TOOL$/i.test(toolName)) return args;
    const tools = Array.isArray(args.tools) ? args.tools : null;
    if (!tools) return args;

    let changed = false;
    const normalizedTools = tools.map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return item;
        const row = item as Record<string, unknown>;
        let next = row;
        if (!("arguments" in next) && "parameters" in next) {
            changed = true;
            const { parameters, ...rest } = next;
            next = { ...rest, arguments: parameters };
        }
        const nestedArgs = next.arguments;
        if (
            (!("tool_slug" in next) || next.tool_slug == null || next.tool_slug === "") &&
            nestedArgs &&
            typeof nestedArgs === "object" &&
            !Array.isArray(nestedArgs) &&
            "channel" in nestedArgs &&
            ("markdown_text" in nestedArgs || "text" in nestedArgs || "blocks" in nestedArgs || "attachments" in nestedArgs)
        ) {
            changed = true;
            return { ...next, tool_slug: "SLACKBOT_SEND_MESSAGE" };
        }
        return next;
    });

    return changed ? { ...args, tools: normalizedTools } : args;
}

function formatMCPToolFailure(
    server: string,
    tool: string,
    callAs: string,
    inputSchema: unknown,
    args: unknown,
    failure: unknown
): string {
    const redactedArgs = redactForPrompt(args);
    const parts = [
        `[MCP:${server}:${tool}] ${stringifyMCPFailure(failure)}`,
        `Called as: await ${callAs}(${safeJson(redactedArgs)})`,
        `Input schema: ${truncateForPrompt(safeJson(inputSchema, 2), 2400)}`,
        `Retry guidance: inspect \`await mcp_tool_schema("${callAs}")\` and use the exact required fields from the schema. Do not guess argument names.`,
    ];

    if (/COMPOSIO_/i.test(tool)) {
        parts.push("Composio note: for nested tool slugs used with COMPOSIO_MULTI_EXECUTE_TOOL, call COMPOSIO_GET_TOOL_SCHEMAS for those slugs before retrying.");
    }

    return parts.join("\n");
}

function normalizeMCPToolResult(toolName: string, result: any): unknown {
    const contentItems = Array.isArray(result?.content) ? result.content as Array<{ type?: string; text?: string }> : [];
    const textParts = contentItems
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "");

    if (textParts.length > 0) return normalizeParsedMCPValue(toolName, parseJSONTextIfPossible(textParts.join("\n")));

    if (result && typeof result === "object") {
        if ("structuredContent" in result && result.structuredContent !== undefined) {
            return normalizeParsedMCPValue(toolName, result.structuredContent);
        }
        if ("toolResult" in result && result.toolResult !== undefined) {
            return normalizeParsedMCPValue(toolName, result.toolResult);
        }
        if ("content" in result && result.content !== undefined) {
            return normalizeParsedMCPValue(toolName, result.content);
        }
    }

    return normalizeParsedMCPValue(toolName, result);
}

function parseJSONTextIfPossible(text: string): unknown {
    let value: unknown = text;
    for (let i = 0; i < 2 && typeof value === "string"; i++) {
        const trimmed = value.trim();
        if (!/^[{[]/.test(trimmed) && !/^"[\s\S]*[}\]]"\s*$/.test(trimmed)) break;
        try {
            value = JSON.parse(trimmed);
        } catch {
            break;
        }
    }
    return value;
}

function normalizeParsedMCPValue(toolName: string, value: unknown): unknown {
    if (!/^COMPOSIO_/i.test(toolName) || !value || typeof value !== "object" || Array.isArray(value)) {
        return value;
    }

    const outer = value as Record<string, unknown>;
    const data = outer.data && typeof outer.data === "object" && !Array.isArray(outer.data)
        ? outer.data as Record<string, unknown>
        : null;
    if (!data) return value;

    const status = {
        successful: outer.successful,
        error: outer.error,
        log_id: outer.log_id,
    };

    if (/^COMPOSIO_SEARCH_TOOLS$/i.test(toolName)) {
        const toolSchemas = data.tool_schemas && typeof data.tool_schemas === "object" && !Array.isArray(data.tool_schemas)
            ? data.tool_schemas as Record<string, unknown>
            : {};
        const schemaTools = Object.values(toolSchemas)
            .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item));
        const slugSet = new Set<string>();
        for (const schema of schemaTools) {
            if (typeof schema.tool_slug === "string") slugSet.add(schema.tool_slug);
        }
        const results = Array.isArray(data.results) ? data.results : [];
        for (const result of results) {
            if (!result || typeof result !== "object" || Array.isArray(result)) continue;
            for (const key of ["primary_tool_slugs", "related_tool_slugs"]) {
                const slugs = (result as Record<string, unknown>)[key];
                if (Array.isArray(slugs)) {
                    for (const slug of slugs) if (typeof slug === "string") slugSet.add(slug);
                }
            }
        }
        const tools = schemaTools.length > 0
            ? schemaTools
            : [...slugSet].map((slug) => ({ tool_slug: slug }));
        const session = data.session && typeof data.session === "object" && !Array.isArray(data.session)
            ? data.session as Record<string, unknown>
            : {};
        return {
            ...data,
            ...status,
            session_id: typeof data.session_id === "string"
                ? data.session_id
                : typeof session.id === "string"
                    ? session.id
                    : "",
            tools,
            connections: data.toolkit_connection_statuses,
        };
    }

    if (/^COMPOSIO_GET_TOOL_SCHEMAS$/i.test(toolName)) {
        const toolSchemas = data.tool_schemas && typeof data.tool_schemas === "object" && !Array.isArray(data.tool_schemas)
            ? data.tool_schemas as Record<string, unknown>
            : {};
        return {
            ...data,
            ...status,
            schemas: Object.values(toolSchemas),
        };
    }

    if (/^COMPOSIO_MULTI_EXECUTE_TOOL$/i.test(toolName)) {
        return {
            ...data,
            ...status,
        };
    }

    return value;
}

function stringifyMCPFailure(failure: unknown): string {
    if (failure instanceof Error) return failure.message;
    if (Array.isArray(failure)) {
        return failure.map((item) => {
            if (item && typeof item === "object" && "text" in item) {
                return String((item as { text?: unknown }).text ?? "");
            }
            return safeJson(item);
        }).join("\n");
    }
    if (failure && typeof failure === "object" && "content" in failure) {
        return stringifyMCPFailure((failure as { content?: unknown }).content);
    }
    return safeJson(failure);
}

function safeJson(value: unknown, indent = 0): string {
    try {
        const json = JSON.stringify(value, null, indent);
        return json === undefined ? String(value) : json;
    } catch {
        return String(value);
    }
}

function truncateForPrompt(value: string, max: number): string {
    if (value.length <= max) return value;
    return value.slice(0, max) + `...[truncated ${value.length - max} chars]`;
}

const SENSITIVE_ARG_KEY_RE = /(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|authorization|auth|cookie|session[_-]?token|client[_-]?secret|webhook)/i;
const PRIVATE_TEXT_ARG_KEY_RE = /^(?:text|markdown_text|message|body|content|comment|description|blocks|attachments)$/i;

function redactForPrompt(value: unknown, depth = 0): unknown {
    if (depth > 8) return "[redacted nested value]";
    if (Array.isArray(value)) return value.map((item) => redactForPrompt(item, depth + 1));
    if (!value || typeof value !== "object") {
        if (typeof value === "string" && value.length > 500) {
            return value.slice(0, 160) + `...[redacted ${value.length - 160} chars]`;
        }
        return value;
    }

    const entries = Object.entries(value as Record<string, unknown>).map(([key, child]) => {
        if (SENSITIVE_ARG_KEY_RE.test(key)) return [key, "[redacted sensitive field]"];
        if (PRIVATE_TEXT_ARG_KEY_RE.test(key)) return [key, redactPrivateText(child)];
        return [key, redactForPrompt(child, depth + 1)];
    });

    return Object.fromEntries(entries);
}

function redactPrivateText(value: unknown): unknown {
    if (typeof value === "string") {
        return value.length === 0 ? "" : `[redacted text, ${value.length} chars]`;
    }
    if (Array.isArray(value)) {
        return value.map((item) => redactPrivateText(item));
    }
    if (value && typeof value === "object") {
        return "[redacted structured text]";
    }
    return value;
}
