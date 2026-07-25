/**
 * MCP Client — connects rlm-bun to external MCP servers.
 *
 * Supports two transport types:
 * - stdio: spawns a subprocess (e.g. "npx -y @modelcontextprotocol/server-github")
 * - http/sse: connects to a remote MCP endpoint
 *
 * Config is loaded from `.mcp.json` (project root), `.rlm-bun/mcp.json`, or `~/.rlm/mcp.json`.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ── Config types ─────────────────────────────────────────────────

export interface MCPServerConfig {
    /** Stdio transport: command to spawn */
    command?: string;
    /** Stdio transport: arguments for the command */
    args?: string[];
    /** Stdio transport: extra environment variables (supports ${ENV_VAR} expansion) */
    env?: Record<string, string>;
    /** HTTP transport type: "http" (StreamableHTTP) or "sse" */
    type?: "http" | "sse";
    /** HTTP transport: URL to connect to */
    url?: string;
    /** HTTP transport: headers (supports ${ENV_VAR} expansion) */
    headers?: Record<string, string>;
    /** Set to false to disable this server */
    enabled?: boolean;
}

export interface MCPConfig {
    mcpServers: Record<string, MCPServerConfig>;
}

// ── Connection result ────────────────────────────────────────────

export interface MCPConnection {
    name: string;
    client: Client;
    tools: Tool[];
    cleanup: () => Promise<void>;
}

// ── Env resolution ───────────────────────────────────────────────

/**
 * Resolve ${ENV_VAR} placeholders in strings.
 * Missing vars resolve to empty string.
 */
export function resolveEnv(value: string): string {
    return value.replace(/\$\{(\w+)\}/g, (_, key) => process.env[key] ?? "");
}

/**
 * Resolve env vars in a Record of strings.
 */
function resolveEnvRecord(rec: Record<string, string>): Record<string, string> {
    return Object.fromEntries(
        Object.entries(rec).map(([k, v]) => [k, resolveEnv(v)])
    );
}

// ── Config loading ───────────────────────────────────────────────

/**
 * Load and merge MCP config from standard locations.
 *
 * Merge order, with later files overriding earlier server names:
 * 1. For each supplied cwd in order: `<cwd>/.mcp.json`, then `<cwd>/.rlm-bun/mcp.json`
 * 2. `~/.rlm/mcp.json`
 */
export function loadMCPConfig(cwd?: string | string[]): MCPConfig | null {
    const roots = (Array.isArray(cwd) ? cwd : [cwd])
        .filter((root): root is string => Boolean(root));
    const locations = [
        ...roots.flatMap((root) => [
            join(root, ".mcp.json"),
            join(root, ".rlm-bun", "mcp.json"),
        ]),
        join(homedir(), ".rlm", "mcp.json"),
    ];
    const seen = new Set<string>();

    let merged: MCPConfig | null = null;
    for (const loc of locations) {
        if (seen.has(loc)) continue;
        seen.add(loc);
        if (existsSync(loc)) {
            try {
                const parsed = JSON.parse(readFileSync(loc, "utf-8")) as MCPConfig;
                const existingServers: Record<string, MCPServerConfig> = merged ? merged.mcpServers : {};
                merged = {
                    mcpServers: {
                        ...existingServers,
                        ...(parsed.mcpServers ?? {}),
                    },
                };
            } catch (err) {
                console.error(`[MCP] Failed to parse ${loc}:`, (err as Error).message);
            }
        }
    }
    return merged;
}

// ── Connection ───────────────────────────────────────────────────

/**
 * Connect to a single MCP server and discover its tools.
 */
export async function connectMCPServer(
    name: string,
    config: MCPServerConfig
): Promise<MCPConnection> {
    const client = new Client(
        { name: `rlm-bun-${name}`, version: "1.0.0" },
        { capabilities: {} }
    );

    let cleanup: () => Promise<void>;

    if (config.command) {
        // ── Stdio transport (spawn subprocess) ──
        const transport = new StdioClientTransport({
            command: config.command,
            args: config.args ?? [],
            env: {
                ...process.env,
                ...(config.env ? resolveEnvRecord(config.env) : {}),
            } as Record<string, string>,
        });
        await client.connect(transport);
        cleanup = async () => {
            try { await client.close(); } catch { }
        };
    } else if (config.url) {
        // ── HTTP / SSE transport ──
        const url = new URL(resolveEnv(config.url));
        const headers = config.headers ? resolveEnvRecord(config.headers) : {};

        const transport =
            config.type === "sse"
                ? new SSEClientTransport(url, { requestInit: { headers } })
                : new StreamableHTTPClientTransport(url, { requestInit: { headers } });

        await client.connect(transport);
        cleanup = async () => {
            try { await client.close(); } catch { }
        };
    } else {
        throw new Error(`[MCP:${name}] Invalid config — needs "command" or "url"`);
    }

    // Discover tools
    const { tools } = await client.listTools();

    return { name, client, tools, cleanup };
}

/**
 * Connect to all enabled MCP servers from config.
 * Uses Promise.allSettled — one broken server won't block the rest.
 */
export async function connectAllMCPServers(
    config: MCPConfig
): Promise<MCPConnection[]> {
    const connections: MCPConnection[] = [];

    const entries = Object.entries(config.mcpServers)
        .filter(([, cfg]) => cfg.enabled !== false);

    if (entries.length === 0) return connections;

    await Promise.allSettled(
        entries.map(async ([name, cfg]) => {
            try {
                const conn = await connectMCPServer(name, cfg);
                connections.push(conn);
                console.error(`[MCP] Connected: ${name} (${conn.tools.length} tools)`);
            } catch (err) {
                console.error(`[MCP] Failed to connect ${name}:`, (err as Error).message);
                // Soft failure — agent can still work without this server
            }
        })
    );

    return connections;
}
