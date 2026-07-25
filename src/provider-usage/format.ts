/**
 * Short human-readable label for a usage window duration.
 * 10080 minutes (7 days) is hard-coded as "wk" for Orca StatusBar parity.
 */
export function formatWindowLabel(windowMinutes: number): string {
  if (windowMinutes === 10080) return "wk";
  if (windowMinutes === 300) return "5h";
  if (windowMinutes === 60) return "1h";
  if (windowMinutes < 60) return `${windowMinutes}m`;
  if (windowMinutes % (60 * 24 * 7) === 0) {
    return `${windowMinutes / (60 * 24 * 7)}wk`;
  }
  if (windowMinutes % (60 * 24) === 0) {
    return `${windowMinutes / (60 * 24)}d`;
  }
  if (windowMinutes % 60 === 0) return `${windowMinutes / 60}h`;
  return `${windowMinutes}m`;
}

/** Single clamp for bar width + label so status bar and tooltip never diverge. */
export function clampUsedPercent(usedPercent: number): number {
  return Math.max(0, Math.min(100, Math.round(usedPercent)));
}

/** Remaining balance 0–100 from provider usedPercent. */
export function remainingPercent(usedPercent: number): number {
  return clampUsedPercent(100 - clampUsedPercent(usedPercent));
}

/**
 * Color band by remaining balance (full bar = healthy):
 * green ≥40% left, yellow 20–39%, red <20%.
 */
export function usageBarTone(remainingPct: number): "ok" | "warn" | "critical" {
  if (remainingPct >= 40) return "ok";
  if (remainingPct >= 20) return "warn";
  return "critical";
}

export function formatTimeAgo(ts: number, now = Date.now()): string {
  const diff = now - ts;
  if (diff < 60_000) return "just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ago`;
}

function formatDuration(ms: number): string {
  if (ms <= 0) return "now";
  const totalMins = Math.floor(ms / 60_000);
  if (totalMins < 60) return `${totalMins}m`;
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
  }
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

export function formatResetCountdown(ms: number): string {
  const duration = formatDuration(ms);
  return duration === "now" ? "Resets now" : `Resets in ${duration}`;
}

export function parseResetDescription(resetValue: string | number | undefined | null): string | null {
  const resetTimestamp = parseResetTimestamp(resetValue);
  if (resetTimestamp === null) return null;
  try {
    const date = new Date(resetTimestamp);
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();
    if (isToday) {
      return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    }
    return date.toLocaleDateString(undefined, {
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return null;
  }
}

export function parseResetTimestamp(value: string | number | undefined | null): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return value > 10_000_000_000 ? value : value * 1000;
  }
  if (!value) return null;
  const numericValue = Number(value);
  if (Number.isFinite(numericValue) && String(value).trim() !== "") {
    return numericValue > 10_000_000_000 ? numericValue : numericValue * 1000;
  }
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}
