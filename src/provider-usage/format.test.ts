import { describe, expect, test } from "bun:test";
import {
  clampUsedPercent,
  formatResetCountdown,
  formatTimeAgo,
  formatWindowLabel,
  remainingPercent,
  usageBarTone,
} from "./format.ts";

describe("provider-usage format", () => {
  test("window labels match Orca status bar conventions", () => {
    expect(formatWindowLabel(300)).toBe("5h");
    expect(formatWindowLabel(10080)).toBe("wk");
    expect(formatWindowLabel(60)).toBe("1h");
    expect(formatWindowLabel(45)).toBe("45m");
    expect(formatWindowLabel(1440)).toBe("1d");
  });

  test("clampUsedPercent rounds and clamps 0–100", () => {
    expect(clampUsedPercent(99.6)).toBe(100);
    expect(clampUsedPercent(-3)).toBe(0);
    expect(clampUsedPercent(150)).toBe(100);
    expect(clampUsedPercent(42.2)).toBe(42);
  });

  test("remainingPercent is 100 minus used", () => {
    expect(remainingPercent(0)).toBe(100);
    expect(remainingPercent(12)).toBe(88);
    expect(remainingPercent(100)).toBe(0);
    expect(remainingPercent(99.6)).toBe(0);
  });

  test("usageBarTone uses remaining-balance bands", () => {
    expect(usageBarTone(100)).toBe("ok");
    expect(usageBarTone(40)).toBe("ok");
    expect(usageBarTone(39)).toBe("warn");
    expect(usageBarTone(20)).toBe("warn");
    expect(usageBarTone(19)).toBe("critical");
    expect(usageBarTone(0)).toBe("critical");
  });

  test("formatTimeAgo and formatResetCountdown are human-readable", () => {
    const now = Date.now();
    expect(formatTimeAgo(now - 10_000, now)).toBe("just now");
    expect(formatTimeAgo(now - 5 * 60_000, now)).toBe("5m ago");
    expect(formatResetCountdown(0)).toBe("Resets now");
    expect(formatResetCountdown(12 * 60_000)).toBe("Resets in 12m");
    expect(formatResetCountdown(3 * 60 * 60_000)).toBe("Resets in 3h");
  });
});
