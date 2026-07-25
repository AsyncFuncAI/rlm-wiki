import { describe, expect, test } from "bun:test";
import {
  assembleHtmlJourney,
  buildHtmlBlueprintPrompt,
  buildHtmlBlockPrompt,
  coerceBeatTypeForLevel,
  defaultBeatsForLevel,
  defaultHtmlBlueprint,
  extractHtmlBlock,
  fallbackBlockHtml,
  HTML_AUDIENCE_VOICE_REMINDER,
  htmlJourneyTimelineCss,
  htmlUserBriefSteeringReminder,
  lintJourneyBlockHtml,
  normalizeJourneyBlockHtml,
  parseHtmlBlueprintXml,
  slimEvidenceForSection,
} from "./html-pipeline.ts";

describe("html-pipeline", () => {
  test("default blueprint has L1–L10 including worth borrowing", () => {
    const bp = defaultHtmlBlueprint("Demo");
    expect(bp.sections).toHaveLength(10);
    expect(bp.sections[0]!.id).toBe("L1");
    expect(bp.sections[9]!.id).toBe("L10");
    expect(bp.sections[9]!.kicker.toLowerCase()).toContain("worth borrowing");
    expect(bp.sections[9]!.intent.toLowerCase()).toMatch(/borrow|best practice|recurring/);
  });

  test("parseHtmlBlueprintXml fills all levels from partial XML", () => {
    const raw = `
<html_blueprint>
  <title>Anarlog tour</title>
  <core_noun>session</core_noun>
  <section id="L1">
    <kicker>L1 · What is this</kicker>
    <title>Local meeting notes you own</title>
    <intent>Open-source notetaker</intent>
    <must_include>README.md</must_include>
    <visual>none</visual>
  </section>
  <section id="L4">
    <kicker>L4 · Tech stack</kicker>
    <title>Stack</title>
    <intent>table</intent>
    <must_include>apps/desktop/package.json</must_include>
    <visual>table</visual>
  </section>
</html_blueprint>`;
    const bp = parseHtmlBlueprintXml(raw, "Fallback");
    expect(bp.title).toBe("Anarlog tour");
    expect(bp.coreNoun).toBe("session");
    expect(bp.sections).toHaveLength(10);
    expect(bp.sections[0]!.title).toMatch(/Local meeting/);
    expect(bp.sections[3]!.mustInclude).toContain("package.json");
    expect(bp.sections[9]!.id).toBe("L10");
  });

  test("blueprint and block prompts mention markers and L10", () => {
    const bp = defaultHtmlBlueprint("Repo");
    const blue = buildHtmlBlueprintPrompt({
      title: "Repo",
      brief: "Tour this",
      genre: "tour",
      scope: "acme/repo",
      codeKbContext: "<code-kb>src/main.ts</code-kb>",
    });
    expect(blue).toContain("html_blueprint");
    expect(blue).toContain("L10");
    expect(blue.toLowerCase()).toContain("worth borrowing");
    const block = buildHtmlBlockPrompt({
      section: bp.sections[0]!,
      blueprint: bp,
      brief: "Tour",
      genre: "tour",
      scope: "acme/repo",
      theme: "light",
    });
    expect(block).toContain("GW_BLOCK_START L1");
    expect(block).toContain("note-kicker");
  });

  test("extractHtmlBlock prefers markers", () => {
    const raw = `noise
<!--GW_BLOCK_START L3-->
<article class="entry note" id="l3"><p class="note-kicker">L3</p></article>
<!--GW_BLOCK_END-->
`;
    expect(extractHtmlBlock(raw, "L3")).toContain('id="l3"');
  });

  test("assembleHtmlJourney builds prime-volume style shell", () => {
    const bp = defaultHtmlBlueprint("OpenClaw");
    const blocks = bp.sections.map((s) => ({
      id: s.id,
      html: `<article class="entry note" id="l${s.id.slice(1)}" data-level="${s.id.slice(1)}"><p class="note-kicker">${s.kicker}</p><h2 class="note-title">${s.title}</h2><div class="note-body"><p>ok <code>src/a.ts</code></p></div></article>`,
      rawText: "",
    }));
    const html = assembleHtmlJourney({
      title: "OpenClaw",
      coreNoun: "agent",
      blocks,
      sections: bp.sections,
      scope: "acme/openclaw",
      dress: {
        id: "ink-paper",
        label: "Light",
        summary: "light",
        theme: "light",
        cssContract: "c",
        layoutRules: "l",
        cssRoot: ":root{--bg:#fff;--text:#171717;--muted:#3f3f3f;--line:#e9e9e9;--surface:#fff}",
      },
    });
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain('id="journey"');
    expect(html).toContain('class="journey"');
    expect(html).toContain("note-kicker");
    expect(html).toContain("entry note");
    expect(html).toContain("width: min(460px, 100%)");
    expect(html).toContain("left: 50%");
    expect(html).toContain('id="l1"');
    expect(html).toContain('id="l10"');
    expect(html).toContain("data-gw-journey");
    expect(html).toContain('data-theme="light"');
    expect(html).not.toContain("journey-nav");
    expect(htmlJourneyTimelineCss()).toContain(".journey");
    expect(html).toContain("OpenClaw");
  });

  test("slimEvidenceForSection prefers must_include paths and caps size", () => {
    const pack = [
      "README.md intro",
      "src/server.ts main host",
      "src/auth/session.ts login",
      "src/other.ts noise",
      "x".repeat(20_000),
    ].join("\n");
    const slim = slimEvidenceForSection(pack, {
      id: "L4",
      kicker: "L4",
      title: "Stack",
      intent: "stack",
      mustInclude: "src/server.ts, src/auth/session.ts",
      visual: "table",
      beats: [],
    });
    expect(slim).toContain("src/server.ts");
    expect(slim).toContain("src/auth/session.ts");
    expect(slim.length).toBeLessThan(pack.length);
    expect(slim.length).toBeLessThanOrEqual(6_000);
  });

  test("default blueprint includes expandable chain beats", () => {
    const bp = defaultHtmlBlueprint("Demo");
    expect(bp.sections[0]!.beats.length).toBeGreaterThanOrEqual(2);
    expect(bp.sections[4]!.beats.length).toBeGreaterThanOrEqual(3);
  });

  test("normalizeJourneyBlockHtml wraps multi-root; rich blocks on rail not chain", () => {
    const raw = `
<article class="entry note"><p class="note-kicker">L4</p><h2 class="note-title">Stack</h2><p class="note-body">Hook.</p></article>
<figure class="entry term-entry"><div class="term"><pre>pnpm i</pre></div></figure>
<figure class="entry table-entry"><table class="claims"><tr><td>a</td></tr></table></figure>
`;
    const out = normalizeJourneyBlockHtml(raw, "L4", 3);
    expect(out).toContain("level-segment");
    expect(out).toContain("entry note");
    expect(out).toContain("term-entry");
    expect(out).toContain("table-entry");
    // all children are rich or anchor — no chain needed
    expect(out).not.toMatch(/\bbeat\b/);
    expect(out).not.toMatch(/\bwrap\b/);
    // rich on rail: term appears outside any chain-rail
    expect(out.indexOf("term-entry")).toBeLessThan(
      out.includes("chain-rail") ? out.indexOf("chain-rail") : out.length,
    );
  });

  test("block prompt asks for linear scroll journey not click-to-expand", () => {
    const bp = defaultHtmlBlueprint("Repo");
    const prompt = buildHtmlBlockPrompt({
      section: bp.sections[4]!,
      blueprint: bp,
      brief: "Tour",
      genre: "tour",
      scope: "acme/repo",
      theme: "light",
    });
    expect(prompt.toLowerCase()).toContain("level-segment");
    expect(prompt.toLowerCase()).toContain("scroll");
    expect(prompt).toMatch(/FORBIDDEN/);
    expect(prompt).toMatch(/entry note/);
    expect(prompt.toLowerCase()).toContain("no click");
    expect(prompt).toMatch(/details|chain-toggle/i); // forbidden list
  });

  test("assembled journey rejects wrap/hero/beat and uses OpenCode geometry", () => {
    const bp = defaultHtmlBlueprint("OpenClaw");
    const blocks = bp.sections.map((s, i) => ({
      id: s.id,
      html: fallbackBlockHtml(s, i),
      rawText: "",
    }));
    const html = assembleHtmlJourney({
      title: "OpenClaw",
      coreNoun: "agent",
      blocks,
      sections: bp.sections,
      scope: "acme/openclaw",
    });
    expect(html).toContain('data-gw-journey="1"');
    expect(html).toContain('class="journey"');
    expect(html).toContain("entry note");
    expect(html).toContain("width: min(460px, 100%)");
    expect(html).toContain("left: 50%");
    expect(html).toContain("margin-left: auto !important");
    expect(html).not.toMatch(/class="wrap"/);
    expect(html).not.toMatch(/class="beat"/);
    expect(html).not.toMatch(/class="hero"/);
    expect(html).not.toMatch(/nth-child\s*\(\s*even\s*\)/i);
    expect(html).not.toMatch(/margin-left\s*:\s*50%/);
    // linear rail: steps/files/flow visible without expand chrome
    expect(html).toContain("steps-entry");
    expect(html).not.toMatch(/<details\b/i);
    expect(html).not.toMatch(/class="[^"]*chain-toggle/);
  });

  test("normalize strips agent zigzag styles and left/right beat shells", () => {
    const raw = `
<style>.beat:nth-child(even){margin-left:50%}</style>
<div class="wrap"><article class="beat left" style="float:left;margin-left:50%;width:48%">
  <p class="kicker">L1</p><h2>Bad zigzag</h2>
</article></div>
`;
    const out = normalizeJourneyBlockHtml(raw, "L1", 0);
    expect(out).not.toContain("<style");
    expect(out).not.toMatch(/margin-left\s*:\s*50%/);
    expect(out).not.toMatch(/\bclass=["'][^"']*\bwrap\b/);
    expect(out).not.toMatch(/\bclass=["'][^"']*\bbeat\b/);
    expect(out).not.toMatch(/float\s*:/);
    expect(out).toContain("entry note");
    expect(out).toContain("level-segment");
  });

  test("parseHtmlBlueprintXml keeps beats when present", () => {
    const raw = `<html_blueprint>
  <title>T</title><core_noun>session</core_noun>
  <section id="L1">
    <kicker>L1 · What</kicker><title>Product</title><intent>hook</intent>
    <must_include>README.md</must_include><visual>none</visual>
    <beat type="note" title="Audience" prove="README"/>
    <beat type="term" title="Run" prove="pnpm dev"/>
  </section>
</html_blueprint>`;
    const bp = parseHtmlBlueprintXml(raw, "T");
    expect(bp.sections[0]!.beats).toHaveLength(2);
    expect(bp.sections[0]!.beats[0]!.title).toBe("Audience");
    expect(bp.sections[3]!.beats.length).toBeGreaterThanOrEqual(2); // default filled for L4
  });

  test("coerceBeatTypeForLevel and parse allowlist (steps only L7; off-level → note)", () => {
    expect(coerceBeatTypeForLevel("steps", "L7")).toBe("steps");
    expect(coerceBeatTypeForLevel("steps", "L1")).toBe("note");
    expect(coerceBeatTypeForLevel("files", "L8")).toBe("files");
    expect(coerceBeatTypeForLevel("files", "L2")).toBe("note");
    expect(coerceBeatTypeForLevel("flow", "L9")).toBe("flow");
    expect(coerceBeatTypeForLevel("facts", "L1")).toBe("facts");
    expect(coerceBeatTypeForLevel("facts", "L10")).toBe("note");
    expect(coerceBeatTypeForLevel("bogus", "L4")).toBe("note");
    expect(coerceBeatTypeForLevel("quote", "L2")).toBe("note"); // phase-2 type not shipped

    const raw = `<html_blueprint>
  <title>T</title><core_noun>session</core_noun>
  <section id="L7">
    <kicker>L7</kicker><title>First minutes</title><intent>run</intent>
    <must_include>README.md</must_include><visual>code</visual>
    <beat type="steps" title="Install" prove="pnpm i"/>
    <beat type="term" title="Green" prove="dev log"/>
  </section>
  <section id="L1">
    <kicker>L1</kicker><title>What</title><intent>hook</intent>
    <must_include>README.md</must_include><visual>none</visual>
    <beat type="steps" title="Should coerce" prove="x"/>
    <beat type="facts" title="Glance" prove="lang"/>
  </section>
</html_blueprint>`;
    const bp = parseHtmlBlueprintXml(raw, "T");
    const l7 = bp.sections.find((s) => s.id === "L7")!;
    expect(l7.beats.some((b) => b.type === "steps")).toBe(true);
    const l1 = bp.sections.find((s) => s.id === "L1")!;
    expect(l1.beats.find((b) => b.title === "Should coerce")!.type).toBe("note");
    expect(l1.beats.find((b) => b.title === "Glance")!.type).toBe("facts");
  });

  test("default beats use MVP shapes on L1/L3/L7/L8/L9", () => {
    expect(defaultBeatsForLevel("L1").some((b) => b.type === "facts")).toBe(true);
    expect(defaultBeatsForLevel("L3").some((b) => b.type === "terms")).toBe(true);
    expect(defaultBeatsForLevel("L7").some((b) => b.type === "steps")).toBe(true);
    expect(defaultBeatsForLevel("L8").some((b) => b.type === "files")).toBe(true);
    expect(defaultBeatsForLevel("L9").some((b) => b.type === "flow")).toBe(true);
  });

  test("journey CSS owns MVP block roots (light+dark)", () => {
    const css = htmlJourneyTimelineCss();
    for (const root of [
      "path-chip",
      "callout",
      "callout-warning",
      "steps-entry",
      "files-entry",
      "flow-entry",
      "facts-entry",
      "terms-entry",
      "meta-strip",
      "file-path",
      "flow-node",
    ]) {
      expect(css).toContain(`.${root}`);
    }
    expect(css).toContain('html[data-theme="dark"] .steps-entry');
    expect(css).toContain('html[data-theme="dark"] .path-chip');
  });

  test("fallback and normalize produce required class roots for MVP shapes", () => {
    const bp = defaultHtmlBlueprint("Demo");
    const l7 = bp.sections.find((s) => s.id === "L7")!;
    const l8 = bp.sections.find((s) => s.id === "L8")!;
    const l9 = bp.sections.find((s) => s.id === "L9")!;
    const l1 = bp.sections.find((s) => s.id === "L1")!;
    const l3 = bp.sections.find((s) => s.id === "L3")!;

    expect(fallbackBlockHtml(l7)).toContain("steps-entry");
    expect(fallbackBlockHtml(l8)).toContain("files-entry");
    expect(fallbackBlockHtml(l9)).toContain("flow-entry");
    expect(fallbackBlockHtml(l1)).toContain("facts-entry");
    expect(fallbackBlockHtml(l3)).toContain("terms-entry");

    const multi = `
<article class="entry note"><p class="note-kicker">L7</p><h2 class="note-title">Run</h2><p class="note-body">Hook.</p></article>
<figure class="entry steps-entry"><ol class="steps"><li class="step"><span class="step-title">Clone</span><div class="step-body">git clone</div></li></ol></figure>
`;
    const out = normalizeJourneyBlockHtml(multi, "L7", 6);
    expect(out).toContain("steps-entry");
    expect(out).toContain("level-segment");
    // steps live on rail (no need for empty chain when only rich siblings)
    expect(out.indexOf("steps-entry")).toBeGreaterThan(out.indexOf("note-title"));
  });

  test("lintJourneyBlockHtml hard-fails L7/L8/L9/L3/L1 without required roots", () => {
    const bare = `<section class="level-segment"><article class="entry note"><p class="note-body">only text</p></article></section>`;
    expect(lintJourneyBlockHtml("L7", bare).hardFail).toMatch(/steps-entry/i);
    expect(lintJourneyBlockHtml("L8", bare).hardFail).toMatch(/files-entry/i);
    expect(lintJourneyBlockHtml("L9", bare).hardFail).toMatch(/flow-entry/i);
    expect(lintJourneyBlockHtml("L3", bare).hardFail).toMatch(/terms/i);
    expect(lintJourneyBlockHtml("L1", bare).hardFail).toMatch(/facts/i);
    expect(lintJourneyBlockHtml("L7", bare + `<figure class="entry steps-entry"></figure>`).hardFail).toBeNull();
    const twoCallouts =
      bare +
      `<article class="entry note callout callout-tip"></article><article class="entry note callout callout-warning"></article>`;
    expect(lintJourneyBlockHtml("L5", twoCallouts).softNotes.join(" ")).toMatch(/callout/i);
  });

  test("normalize flattens expand chains into linear scroll rail", () => {
    const buried = `
<section class="level-segment" data-level="L7" id="l7">
  <article class="entry note"><p class="note-kicker">L7</p><h2 class="note-title">Run</h2><p class="note-body">Hook.</p></article>
  <details class="entry note chain-toggle">
    <summary class="chain-summary">
      <span class="chain-summary-kicker">Expand</span>
      <span class="chain-summary-title">deep</span>
      <span class="chain-summary-meta">chain</span>
    </summary>
    <div class="chain-rail">
      <figure class="entry steps-entry"><ol class="steps"><li class="step"><span class="step-title">Clone</span><div class="step-body">git clone</div></li></ol></figure>
      <article class="entry note"><p class="note-kicker">Aside</p><h2 class="note-title">Extra</h2><p class="note-body">plain note</p></article>
    </div>
  </details>
</section>`;
    const out = normalizeJourneyBlockHtml(buried, "L7", 6);
    expect(out).toContain("steps-entry");
    expect(out).toContain("Extra");
    expect(out).not.toContain("chain-toggle");
    expect(out).not.toContain("chain-rail");
    expect(out).not.toContain("<details");
    expect(out).not.toContain("Expand");
  });

  test("normalize preserves callout-kicker and repairs broken rename", () => {
    const raw = `
<section class="level-segment" data-level="L2" id="l2">
  <article class="entry note callout callout-warning">
    <p class="callout-kicker">Watch</p>
    <p class="callout-body">Trap.</p>
  </article>
  <article class="entry note">
    <p class="callout-note-kicker">Broken</p>
  </article>
</section>`;
    const out = normalizeJourneyBlockHtml(raw, "L2", 1);
    expect(out).toContain("callout-kicker");
    expect(out).not.toContain("callout-note-kicker");
  });

  test("assembled defaults include MVP shapes and stay center-rail", () => {
    const bp = defaultHtmlBlueprint("OpenClaw");
    const blocks = bp.sections.map((s, i) => ({
      id: s.id,
      html: fallbackBlockHtml(s, i),
      rawText: "",
    }));
    const html = assembleHtmlJourney({
      title: "OpenClaw",
      coreNoun: "agent",
      blocks,
      sections: bp.sections,
      scope: "acme/openclaw",
    });
    expect(html).toContain("data-gw-journey");
    expect(html).toContain("steps-entry");
    expect(html).toContain("files-entry");
    expect(html).toContain("flow-entry");
    expect(html).toContain("facts-entry");
    expect(html).toContain("terms-entry");
    expect(html).toContain("path-chip");
    expect(html).not.toMatch(/class="wrap"/);
    expect(html).not.toMatch(/class="beat"/);
    expect(html).not.toMatch(/margin-left\s*:\s*50%/);
  });

  test("block prompt injects only planned contracts + audience voice + brief steering", () => {
    const bp = defaultHtmlBlueprint("Repo");
    const l7 = bp.sections.find((s) => s.id === "L7")!;
    const prompt = buildHtmlBlockPrompt({
      section: l7,
      blueprint: bp,
      brief: "Emphasize first-run for ops engineers.",
      genre: "tour",
      scope: "acme/repo",
      theme: "light",
    });
    expect(prompt).toContain("steps-entry");
    expect(prompt).toMatch(/HARD:.*steps-entry/i);
    expect(prompt).toContain(HTML_AUDIENCE_VOICE_REMINDER.split("\n")[0]!);
    expect(prompt).toContain("USER NOTE STEERING");
    expect(prompt).toMatch(/L1–L10 still all run|L1-L10 still all run/i);
    expect(prompt).toContain("day-to-day");
    // L7 plan does not include files — contract should not dump files-entry soup
    // (unless a planned beat is files; defaults are steps/term/callout only)
    expect(l7.beats.every((b) => b.type !== "files")).toBe(true);
    // Planned contracts list steps/term/callout only (template may mention files-entry as a rail shape option).
    const contracts = prompt.slice(prompt.indexOf("BEAT CONTRACTS"), prompt.indexOf("HARD:"));
    expect(contracts).toContain("steps-entry");
    expect(contracts).not.toMatch(/^- files:/m);

    const emptyBrief = buildHtmlBlockPrompt({
      section: l7,
      blueprint: bp,
      brief: "   ",
      genre: "tour",
      scope: "acme/repo",
      theme: "light",
    });
    expect(emptyBrief).not.toContain("USER NOTE STEERING");
  });

  test("blueprint prompt includes vocabulary, audience voice, and brief steering when set", () => {
    const withBrief = buildHtmlBlueprintPrompt({
      title: "Repo",
      brief: "Focus on multiplayer session edges.",
      genre: "tour",
      scope: "acme/repo",
    });
    expect(withBrief).toContain("steps");
    expect(withBrief).toContain("files");
    expect(withBrief).toContain("flow");
    expect(withBrief).toContain("USER NOTE STEERING");
    expect(withBrief).toContain("AUDIENCE VOICE");
    expect(htmlUserBriefSteeringReminder("")).toBe("");
    expect(htmlUserBriefSteeringReminder("hello")).toContain("USER NOTE STEERING");
  });
});
