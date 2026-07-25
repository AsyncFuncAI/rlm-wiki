import { readFileSync, existsSync, readdirSync } from "fs";
import { isAbsolute, relative, resolve } from "path";
import { parseCSV, inferColumnTypes } from "../utils/csv-parser.ts";
import { runRipgrepSearch, type GrepMatch, type GrepOpts, type BashOpts } from "./tools.ts";
import { inspectAbsolutePath, type FileInspection } from "./inspect.ts";
import { scanGlobPaths } from "./glob.ts";

export interface FileInfo {
  size: number;
  lines?: number;
  type: string;
  modified: string;
  binary?: boolean;
  lineCountSkipped?: string;
}

export interface CSVInfo {
  columns: string[];
  rowCount: number;
  sample: Record<string, string>[];
  columnTypes: Record<string, string>;
}

export interface CSVQueryOpts {
  columns?: string[];
  filter?: { column: string; op: string; value: string | number };
  filters?: { column: string; op: string; value: string | number }[];
  limit?: number;
  offset?: number;
}

export interface CSVAggregateOpts {
  groupBy?: string;
  aggregates: { column: string; op: string }[];
}

export interface FileTools {
  readFile: (filePath: string) => string;
  inspect: (filePath: string) => FileInspection;
  glob: (pattern: string) => string[];
  rg: (pattern: string | RegExp, opts?: GrepOpts | string) => GrepMatch[];
  grep: (pattern: string | RegExp, opts?: GrepOpts | string) => GrepMatch[];
  listFiles: (dir?: string) => string[];
  fileInfo: (filePath: string) => FileInfo;
  csvInfo: (filePath: string) => CSVInfo;
  csvQuery: (filePath: string, opts?: CSVQueryOpts) => { rows: Record<string, string>[]; total: number; hasMore: boolean };
  csvAggregate: (filePath: string, opts: CSVAggregateOpts) => { results: Record<string, unknown>[] };
  bash: (command: string, opts?: BashOpts | string) => Promise<string>;
}

/**
 * Build tool functions for file/data analysis mode.
 */
export function buildFileTools(basePath: string): FileTools {
  function resolvePath(filePath: string): string {
    const abs = resolve(basePath, filePath);
    const rel = relative(basePath, abs);
    if (rel !== "" && (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel))) {
      throw new Error("Path escape blocked: " + filePath);
    }
    return abs;
  }

  return {
    readFile(filePath: string): string {
      const abs = resolvePath(filePath);
      if (!existsSync(abs)) throw new Error("File not found: " + filePath);
      return readFileSync(abs, "utf-8");
    },

    inspect(filePath: string): FileInspection {
      return inspectAbsolutePath(resolvePath(filePath), filePath);
    },

    glob(pattern: string): string[] {
      return scanGlobPaths(basePath, pattern);
    },

    rg(pattern: string | RegExp, opts?: GrepOpts | string): GrepMatch[] {
      return runRipgrepSearch(basePath, pattern, opts);
    },

    grep(pattern: string | RegExp, opts?: GrepOpts | string): GrepMatch[] {
      return runRipgrepSearch(basePath, pattern, opts);
    },

    listFiles(dir?: string): string[] {
      const target = dir ? resolvePath(dir) : basePath;
      if (!existsSync(target)) return [];
      const entries = readdirSync(target, { withFileTypes: true });
      const files: string[] = [];
      for (const e of entries) {
        if (e.isFile()) files.push(e.name);
        else if (e.isDirectory()) files.push(e.name + "/");
      }
      return files;
    },

    fileInfo(filePath: string): FileInfo {
      const info = inspectAbsolutePath(resolvePath(filePath), filePath);
      return {
        size: info.size,
        lines: info.lines,
        type: info.ext || info.mime || info.kind,
        modified: info.modified,
        binary: info.binary,
        lineCountSkipped: info.lineCountSkipped,
      };
    },

    csvInfo(filePath: string): CSVInfo {
      const abs = resolvePath(filePath);
      if (!existsSync(abs)) throw new Error("File not found: " + filePath);
      const content = readFileSync(abs, "utf-8");
      const rows = parseCSV(content);
      if (rows.length === 0) return { columns: [], rowCount: 0, sample: [], columnTypes: {} };
      const columns = Object.keys(rows[0]);
      const sample = rows.slice(0, 5);
      const columnTypes = inferColumnTypes(rows);
      return { columns, rowCount: rows.length, sample, columnTypes };
    },

    csvQuery(filePath: string, opts: CSVQueryOpts = {}): { rows: Record<string, string>[]; total: number; hasMore: boolean } {
      const abs = resolvePath(filePath);
      if (!existsSync(abs)) throw new Error("File not found: " + filePath);
      const content = readFileSync(abs, "utf-8");
      let rows = parseCSV(content);

      const filters = opts.filters || (opts.filter ? [opts.filter] : []);
      for (const f of filters) {
        rows = rows.filter((row) => {
          const val = row[f.column];
          const cmp = String(f.value);
          switch (f.op) {
            case "eq": return val === cmp;
            case "neq": return val !== cmp;
            case "contains": return val?.includes(cmp);
            case "gt": return parseFloat(val) > parseFloat(cmp);
            case "lt": return parseFloat(val) < parseFloat(cmp);
            case "gte": return parseFloat(val) >= parseFloat(cmp);
            case "lte": return parseFloat(val) <= parseFloat(cmp);
            default: return true;
          }
        });
      }

      if (opts.columns) {
        rows = rows.map((row) => {
          const filtered: Record<string, string> = {};
          for (const col of opts.columns!) {
            filtered[col] = row[col];
          }
          return filtered;
        });
      }

      const total = rows.length;
      const offset = opts.offset || 0;
      const limit = opts.limit || 50;
      const sliced = rows.slice(offset, offset + limit);
      return { rows: sliced, total, hasMore: offset + limit < total };
    },

    csvAggregate(filePath: string, opts: CSVAggregateOpts): { results: Record<string, unknown>[] } {
      const abs = resolvePath(filePath);
      if (!existsSync(abs)) throw new Error("File not found: " + filePath);
      const content = readFileSync(abs, "utf-8");
      const rows = parseCSV(content);

      const groups: Record<string, Record<string, string>[]> = {};
      if (opts.groupBy) {
        for (const row of rows) {
          const key = row[opts.groupBy] || "(empty)";
          if (!groups[key]) groups[key] = [];
          groups[key].push(row);
        }
      } else {
        groups["_all"] = rows;
      }

      const results: Record<string, unknown>[] = [];
      for (const [groupKey, groupRows] of Object.entries(groups)) {
        const result: Record<string, unknown> = {};
        if (opts.groupBy) result[opts.groupBy] = groupKey;

        for (const agg of opts.aggregates) {
          const values = groupRows.map((r) => r[agg.column]).filter(Boolean);
          const nums = values.map(Number).filter((n) => !isNaN(n));
          const key = `${agg.op}_${agg.column}`;

          switch (agg.op) {
            case "count": result[key] = values.length; break;
            case "sum": result[key] = nums.reduce((a, b) => a + b, 0); break;
            case "avg": result[key] = nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0; break;
            case "min": result[key] = nums.length ? Math.min(...nums) : null; break;
            case "max": result[key] = nums.length ? Math.max(...nums) : null; break;
            case "distinct": result[key] = [...new Set(values)].length; break;
          }
        }
        results.push(result);
      }
      return { results };
    },

    async bash(command: string, opts?: BashOpts | string): Promise<string> {
      const o: BashOpts = typeof opts === "string" ? JSON.parse(opts) : opts || {};
      const timeoutMs = o.timeout || 30000;
      const maxOutput = o.maxOutput || 50 * 1024;
      const blocked: RegExp[] = [
        /\brm\s+(-\w*r\w*f|--no-preserve-root)/i,
        /\bchmod\s+777/, /\bdd\s+/, /\bmkfs\b/,
        /\bcurl\b.*\|\s*(sh|bash)/, /\bwget\b.*\|\s*(sh|bash)/,
        />\s*\/dev\/sd/, /\bsudo\b/,
      ];
      for (const re of blocked) {
        if (re.test(command)) throw new Error(`Security block: command matches forbidden pattern ${re}`);
      }
      try {
        const proc = Bun.spawn(["sh", "-c", command], {
          cwd: basePath, stdout: "pipe", stderr: "pipe",
          env: { ...process.env, HOME: process.env.HOME },
        });
        const timer = new Promise<never>((_, reject) =>
          setTimeout(() => { proc.kill(); reject(new Error(`bash: timed out after ${timeoutMs}ms`)); }, timeoutMs)
        );
        const completion = (async () => {
          const exitCode = await proc.exited;
          const stdout = await new Response(proc.stdout).text();
          const stderr = await new Response(proc.stderr).text();
          return { exitCode, stdout, stderr };
        })();
        const { exitCode, stdout, stderr } = await Promise.race([completion, timer]);
        let output = stdout || "";
        if (stderr) output += (output ? "\n" : "") + "[stderr]\n" + stderr;
        if (!output) output = "(no output)";
        if (output.length > maxOutput) {
          const head = output.slice(0, Math.floor(maxOutput / 2));
          const tail = output.slice(-Math.floor(maxOutput / 2));
          output = head + `\n...[truncated ${(output.length - maxOutput).toLocaleString()} chars]...\n` + tail;
        }
        if (exitCode !== 0) return `[exit code ${exitCode}]\n${output}`;
        return output.trim();
      } catch (e) {
        return `bash error: ${(e as Error).message}`;
      }
    },
  };
}
