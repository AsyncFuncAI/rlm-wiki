import { describe, expect, test } from "bun:test";
import { parseGithubUrl } from "./types.ts";
import { wikiSourceKey } from "./wiki-identity.ts";

describe("repository source refs", () => {
  test("parses GitHub tree URLs as branch plus folder scope", () => {
    const ref = parseGithubUrl("https://github.com/openai/codex/tree/main/codex-rs/app-server");

    expect(ref).toEqual({
      owner: "openai",
      repo: "codex",
      url: "https://github.com/openai/codex",
      branch: "main",
      sourcePath: "codex-rs/app-server",
    });
  });

  test("parses GitHub tree URLs with query strings and namespaced branches", () => {
    expect(parseGithubUrl("https://github.com/openai/codex/tree/main/codex-rs/app-server?tab=readme")).toMatchObject({
      owner: "openai",
      repo: "codex",
      url: "https://github.com/openai/codex",
      branch: "main",
      sourcePath: "codex-rs/app-server",
    });
    expect(parseGithubUrl("https://github.com/AsyncFuncAI/rlm-wiki/tree/feature/hotkey?tab=readme")).toMatchObject({
      owner: "AsyncFuncAI",
      repo: "rlm-wiki",
      url: "https://github.com/AsyncFuncAI/rlm-wiki",
      branch: "feature/hotkey",
      sourcePath: null,
    });
    expect(parseGithubUrl("https://github.com/AsyncFuncAI/rlm-wiki/tree/feature/hotkey/apps/desktop")).toMatchObject({
      owner: "AsyncFuncAI",
      repo: "rlm-wiki",
      url: "https://github.com/AsyncFuncAI/rlm-wiki",
      branch: "feature/hotkey",
      sourcePath: "apps/desktop",
    });
  });

  test("parses GitHub blob URLs as branch plus path scope", () => {
    expect(parseGithubUrl("https://github.com/openai/codex/blob/main/codex-rs/app-server/src/main.rs")).toMatchObject({
      owner: "openai",
      repo: "codex",
      url: "https://github.com/openai/codex",
      branch: "main",
      sourcePath: "codex-rs/app-server/src/main.rs",
    });
    expect(parseGithubUrl("https://github.com/AsyncFuncAI/rlm-wiki/blob/feature/hotkey/apps/desktop/src/main.ts")).toMatchObject({
      owner: "AsyncFuncAI",
      repo: "rlm-wiki",
      url: "https://github.com/AsyncFuncAI/rlm-wiki",
      branch: "feature/hotkey",
      sourcePath: "apps/desktop/src/main.ts",
    });
  });

  test("parses owner repo shorthand with branch and folder scope", () => {
    expect(parseGithubUrl("openai/codex@main:codex-rs/app-server")).toMatchObject({
      owner: "openai",
      repo: "codex",
      url: "https://github.com/openai/codex",
      branch: "main",
      sourcePath: "codex-rs/app-server",
    });
  });

  test("source identity includes folder scope", () => {
    const full = wikiSourceKey({
      owner: "openai",
      repo: "codex",
      url: "https://github.com/openai/codex",
      branch: "main",
      sourcePath: null,
    });
    const scoped = wikiSourceKey({
      owner: "openai",
      repo: "codex",
      url: "https://github.com/openai/codex",
      branch: "main",
      sourcePath: "codex-rs/app-server",
    });

    expect(full).toBe("openai/codex@main");
    expect(scoped).toBe("openai/codex@main#codex-rs/app-server");
  });
});
