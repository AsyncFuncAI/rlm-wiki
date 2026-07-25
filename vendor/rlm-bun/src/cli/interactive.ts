import { createInterface } from "readline";
import type { RLM } from "../rlm.ts";
import type { RLMQueryResult } from "../rlm.ts";
import { SkillRegistry } from "../skills/index.ts";

interface InteractiveColors {
  muted: string;
  accent: string;
  reset: string;
}

export async function handleSlashCommand(
  input: string,
  skillRegistry: SkillRegistry,
  rlm: RLM,
  C: InteractiveColors,
): Promise<"handled" | string> {
  const parts = input.slice(1).trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase() ?? "";
  const subCmd = parts[1]?.toLowerCase() ?? "";
  const arg = parts.slice(2).join(" ");

  if (cmd === "skill" || cmd === "s") {
    if (subCmd === "add" || subCmd === "a") {
      if (!arg) {
        console.error(`${C.muted}  Usage: /skill add <owner/repo[@skill]|./local/path>${C.reset}`);
        return "handled";
      }
      console.error(`${C.muted}  ○ Loading skill: ${arg}${C.reset}`);
      try {
        const loaded = await skillRegistry.add(arg);
        if (loaded.length === 0) {
          console.error(`${C.muted}  ✗ No skills found in: ${arg}${C.reset}`);
        } else {
          for (const s of loaded) {
            console.error(`${C.accent}  ✓ Skill loaded: ${s.name}${C.reset}`);
            console.error(`${C.muted}    ${s.description}${C.reset}`);
          }
          rlm.setSkillsPromptText(skillRegistry.formatForPrompt());
          skillRegistry.saveManifest();
        }
      } catch (e: unknown) {
        console.error(`${C.muted}  ✗ Failed: ${e instanceof Error ? e.message : String(e)}${C.reset}`);
      }
      return "handled";
    }
    if (subCmd === "list" || subCmd === "ls" || subCmd === "l") {
      const skills = skillRegistry.list();
      if (skills.length === 0) {
        console.error(`${C.muted}  No skills loaded. Use /skill add <source> to load one.${C.reset}`);
      } else {
        console.error(`${C.muted}  Loaded skills (${skills.length}):${C.reset}`);
        for (const s of skills) {
          console.error(`${C.accent}    • ${s.name}${C.reset} ${C.muted}— ${s.description}${C.reset}`);
        }
      }
      return "handled";
    }
    if (subCmd === "remove" || subCmd === "rm" || subCmd === "r") {
      const name = parts.slice(2).join(" ");
      if (!name) { console.error(`${C.muted}  Usage: /skill remove <skill-name>${C.reset}`); return "handled"; }
      const removed = skillRegistry.remove(name);
      if (removed) {
        console.error(`${C.muted}  ✓ Removed skill: ${name}${C.reset}`);
        rlm.setSkillsPromptText(skillRegistry.formatForPrompt());
      } else {
        console.error(`${C.muted}  Skill not found: ${name}${C.reset}`);
      }
      return "handled";
    }
    if (subCmd === "clear" || subCmd === "c") {
      skillRegistry.clear();
      rlm.setSkillsPromptText("");
      skillRegistry.saveManifest();
      console.error(`${C.muted}  ✓ All skills cleared${C.reset}`);
      return "handled";
    }
    console.error(`${C.muted}  Skill commands:${C.reset}`);
    console.error(`${C.muted}    /skill add <source>     Load a skill (owner/repo@name or ./path)${C.reset}`);
    console.error(`${C.muted}    /skill list             Show loaded skills${C.reset}`);
    console.error(`${C.muted}    /skill remove <name>    Remove a skill${C.reset}`);
    console.error(`${C.muted}    /skill clear            Remove all skills${C.reset}`);
    return "handled";
  }

  if (cmd === "help" || cmd === "h" || cmd === "?") {
    console.error(`${C.muted}  Slash commands:${C.reset}`);
    console.error(`${C.muted}    /skill add <source>    Load a skill into context${C.reset}`);
    console.error(`${C.muted}    /skill list            List loaded skills${C.reset}`);
    console.error(`${C.muted}    /skill remove <name>   Remove a skill${C.reset}`);
    console.error(`${C.muted}    /skill clear           Clear all skills${C.reset}`);
    console.error(`${C.muted}    /help                  Show this help${C.reset}`);
    return "handled";
  }

  return input;
}

export async function runInteractive(
  rlm: RLM,
  query: string,
  promptMode: boolean,
  skillRegistry: SkillRegistry,
  C: InteractiveColors,
  displayAnswer: (result: RLMQueryResult) => void,
): Promise<void> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });

  const promptForFollowUp = (): Promise<string | null> =>
    new Promise((resolve) => {
      console.error(`${C.muted}  enter to exit · type a question or /help for commands${C.reset}`);
      rl.question(`\n${C.accent}❯${C.reset} `, async (answer: string) => {
        const trimmed = answer.trim();
        if (!trimmed) { resolve(null); return; }
        if (trimmed.startsWith("/")) {
          const result = await handleSlashCommand(trimmed, skillRegistry, rlm, C);
          if (result === "handled") {
            resolve(await promptForFollowUp());
          } else {
            resolve(result);
          }
          return;
        }
        resolve(trimmed);
      });
    });

  rl.on("close", () => {
    console.error(`\n  ${C.muted}👋 bye${C.reset}`);
    process.exit(0);
  });

  // If promptMode with no query, prompt for the initial query
  if (promptMode && !query) {
    query = await new Promise<string>((resolve) => {
      rl.question(`\n${C.accent}❯${C.reset} `, (answer: string) => {
        resolve(answer.trim());
      });
    });
    if (!query) {
      rl.close();
      process.exit(0);
    }
  }

  await rlm.queryInteractive(query!, promptForFollowUp, (res: RLMQueryResult) => {
    displayAnswer(res);
  });

  rl.close();
}
