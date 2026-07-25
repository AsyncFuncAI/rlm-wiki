/**
 * Streaming CSV parser — zero dependencies, RFC 4180 compliant.
 * Handles quoted fields, escaped quotes, newlines inside quotes.
 */

/**
 * Parse a single CSV line into an array of field values.
 * Handles quoted fields with embedded commas, quotes, and newlines.
 */
export function parseCSVLine(line: string, delimiter: string = ","): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      i++; // skip escaped quote
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === delimiter && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

/**
 * Split CSV text into logical lines, handling quoted newlines.
 */
export function splitCSVLines(text: string): string[] {
  const lines: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '""';
        i++;
      } else {
        inQuotes = !inQuotes;
        current += char;
      }
    } else if ((char === "\n" || (char === "\r" && next === "\n")) && !inQuotes) {
      if (current.trim()) lines.push(current);
      current = "";
      if (char === "\r") i++; // skip \n in \r\n
    } else if (char === "\r" && !inQuotes) {
      if (current.trim()) lines.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) lines.push(current);
  return lines;
}

/**
 * Count total data rows in a CSV (excludes header).
 */
export async function countCSVRows(filePath: string): Promise<number> {
  const text = await Bun.file(filePath).text();
  const lines = splitCSVLines(text);
  return Math.max(0, lines.length - 1);
}

/**
 * Get CSV headers from the first line.
 */
export async function getCSVHeaders(filePath: string, delimiter: string = ","): Promise<string[]> {
  const text = await Bun.file(filePath).text();
  const lines = splitCSVLines(text);
  if (lines.length === 0) return [];
  return parseCSVLine(lines[0], delimiter);
}

/**
 * Parse a full CSV string into an array of row objects.
 * Uses the first line as headers.
 */
export function parseCSV(text: string, delimiter: string = ","): Record<string, string>[] {
  const lines = splitCSVLines(text);
  if (lines.length < 2) return [];
  const headers = parseCSVLine(lines[0], delimiter);
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i], delimiter);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] ?? "";
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Infer column types from sample rows.
 */
export function inferColumnTypes(rows: Record<string, string>[]): Record<string, string> {
  if (rows.length === 0) return {};

  const columns = Object.keys(rows[0]);
  const types: Record<string, string> = {};

  for (const col of columns) {
    const values = rows.map((r) => r[col]).filter((v) => v !== "" && v != null);

    if (values.length === 0) {
      types[col] = "string";
      continue;
    }

    // Check number
    if (values.every((v) => !isNaN(Number(v)) && v.trim() !== "")) {
      types[col] = "number";
      continue;
    }

    // Check boolean
    const boolSet = new Set(["true", "false", "yes", "no", "1", "0"]);
    if (values.every((v) => boolSet.has(v.toLowerCase().trim()))) {
      types[col] = "boolean";
      continue;
    }

    // Check date (ISO 8601 or common formats)
    const dateRx = /^\d{4}[-/]\d{1,2}[-/]\d{1,2}|^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}/;
    if (values.every((v) => dateRx.test(v.trim()) && !isNaN(Date.parse(v)))) {
      types[col] = "date";
      continue;
    }

    types[col] = "string";
  }

  return types;
}

