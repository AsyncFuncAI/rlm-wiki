import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "fs";
import { extname } from "path";

const SAMPLE_BYTES = 8192;
const LINE_COUNT_MAX_BYTES = 2 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  css: "text/css",
  csv: "text/csv",
  gif: "image/gif",
  html: "text/html",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "text/javascript",
  json: "application/json",
  jsonl: "application/x-ndjson",
  md: "text/markdown",
  mjs: "text/javascript",
  pdf: "application/pdf",
  png: "image/png",
  py: "text/x-python",
  rs: "text/x-rust",
  ts: "text/typescript",
  tsx: "text/typescript",
  txt: "text/plain",
  yaml: "application/yaml",
  yml: "application/yaml",
  zip: "application/zip",
};

export interface FileInspection {
  path: string;
  kind: "file" | "directory" | "other";
  size: number;
  modified: string;
  ext?: string;
  mime?: string;
  binary?: boolean;
  lines?: number;
  entries?: number;
  lineCountSkipped?: string;
}

function readSample(path: string, size: number): Uint8Array {
  const length = Math.min(size, SAMPLE_BYTES);
  if (length <= 0) return new Uint8Array();

  const fd = openSync(path, "r");
  try {
    const buffer = new Uint8Array(length);
    const bytesRead = readSync(fd, buffer, 0, length, 0);
    return buffer.slice(0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

function isProbablyBinary(sample: Uint8Array): boolean {
  if (sample.length === 0) return false;
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    const isCommonWhitespace = byte === 9 || byte === 10 || byte === 13;
    const isPrintable = byte >= 32 && byte <= 126;
    const isUtf8HighByte = byte >= 128;
    if (!isCommonWhitespace && !isPrintable && !isUtf8HighByte) suspicious++;
  }
  return suspicious / sample.length > 0.3;
}

function countLines(path: string): number {
  const text = readFileSync(path, "utf-8");
  if (text.length === 0) return 0;
  return text.split(/\r\n|\r|\n/).length;
}

export function inspectAbsolutePath(absPath: string, displayPath: string): FileInspection {
  if (!existsSync(absPath)) throw new Error("File not found: " + displayPath);

  const stat = statSync(absPath);
  const base = {
    path: displayPath,
    size: stat.size,
    modified: stat.mtime.toISOString(),
  };

  if (stat.isDirectory()) {
    return {
      ...base,
      kind: "directory",
      entries: readdirSync(absPath).length,
    };
  }

  if (!stat.isFile()) {
    return {
      ...base,
      kind: "other",
    };
  }

  const ext = extname(displayPath).slice(1).toLowerCase() || undefined;
  const sample = readSample(absPath, stat.size);
  const binary = isProbablyBinary(sample);
  const info: FileInspection = {
    ...base,
    kind: "file",
    ext,
    mime: ext ? MIME_BY_EXT[ext] || (binary ? "application/octet-stream" : "text/plain") : binary ? "application/octet-stream" : "text/plain",
    binary,
  };

  if (binary) {
    info.lineCountSkipped = "binary file";
  } else if (stat.size > LINE_COUNT_MAX_BYTES) {
    info.lineCountSkipped = `file larger than ${LINE_COUNT_MAX_BYTES.toLocaleString()} bytes`;
  } else {
    info.lines = countLines(absPath);
  }

  return info;
}
