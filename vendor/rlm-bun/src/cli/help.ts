import { listGoals } from "../prompts/workspace-meta.js";

export function printHelp(): never {
  const goalList = listGoals().map((g: { id: string; label: string }) => `    ${g.id.padEnd(12)} ${g.label}`).join("\n");
  const BOLD_H = "\x1b[1m";
  const DIM_H = "\x1b[38;5;240m";
  const TEXT_H = "\x1b[38;5;33m";
  const RESET_H = "\x1b[0m";
  const GRAYS_H = ["\x1b[38;5;248m", "\x1b[38;5;244m", "\x1b[38;5;240m", "\x1b[38;5;236m"];
  console.log();
  const wordmark = "rlm-bun";
  wordmark.split("").forEach((ch, i) => {
    process.stdout.write((GRAYS_H[Math.min(i, GRAYS_H.length - 1)] || GRAYS_H[3]) + ch);
  });
  process.stdout.write(RESET_H + "\n");
  console.log(`${DIM_H}Query codebases and data files with a Recursive Language Model${RESET_H}\n`);
  console.log(`${BOLD_H}Usage:${RESET_H}
  ${DIM_H}$${RESET_H} ${TEXT_H}rlm ${DIM_H}<source> <query>${RESET_H}                            ${DIM_H}Single source${RESET_H}
  ${DIM_H}$${RESET_H} ${TEXT_H}rlm --sources ${DIM_H}id=url ... --goal <goal>${RESET_H}          ${DIM_H}Multi-repo workspace${RESET_H}
  `);
  console.log(`${BOLD_H}Arguments:${RESET_H}
  ${TEXT_H}source              ${DIM_H}GitHub URL, local git repo, file, or directory${RESET_H}
  ${TEXT_H}query               ${DIM_H}Question about the codebase/data (quote it)${RESET_H}
  `);
  console.log(`${BOLD_H}Workspace Options:${RESET_H}
  ${TEXT_H}--sources ${DIM_H}<specs>    Multiple repos: id=url pairs${RESET_H}
  ${TEXT_H}--goal    ${DIM_H}<goal>     Workspace goal — generates the right analysis query:${RESET_H}
  ${goalList}
  `);
  console.log(`${BOLD_H}Options:${RESET_H}
  ${TEXT_H}--mode ${DIM_H}<mode>        ${RESET_H}auto (default), repo, file, workspace, or rlm
  ${TEXT_H}--provider ${DIM_H}<name>    ${RESET_H}anthropic (default), openai, gemini, codex, codex-cli, or claude-cli
  ${TEXT_H}--model ${DIM_H}<id>         ${RESET_H}Model ID (default: claude-opus-4-7, gpt-4o, gemini-2.5-flash)
  ${TEXT_H}--base-url ${DIM_H}<url>     ${RESET_H}Override API base URL (OpenAI-compatible)
  ${TEXT_H}--sub-model ${DIM_H}<id>     ${RESET_H}Sub-LLM model for llmQuery
  ${TEXT_H}--sub-provider ${DIM_H}<name>  ${RESET_H}Sub-LLM provider (defaults to --provider)
  ${TEXT_H}--sub-base-url ${DIM_H}<url>   ${RESET_H}Sub-LLM API base URL (defaults to --base-url)
  ${TEXT_H}--max-iter ${DIM_H}<n>       ${RESET_H}Max iterations (default: 20)
  ${TEXT_H}--max-llm ${DIM_H}<n>        ${RESET_H}Max sub-LLM calls (default: 5000)
  ${TEXT_H}--branch ${DIM_H}<name>      ${RESET_H}Git branch to checkout (repo mode only)
  ${TEXT_H}--no-cache              ${DIM_H}Disable repo caching for GitHub clones${RESET_H}
  ${TEXT_H}--sandbox-timeout       ${DIM_H}Per-step sandbox timeout in ms (default: 30 minutes)${RESET_H}
  ${TEXT_H}--github-token ${DIM_H}<token>  ${RESET_H}GitHub token for PR review (or set GITHUB_TOKEN env var)
  ${TEXT_H}--prompt${DIM_H}, -p        ${RESET_H}Generalist mode — no source needed, just ask anything
  ${TEXT_H}--interactive${DIM_H}, -i   ${RESET_H}Stay alive after SUBMIT for follow-up questions
  ${TEXT_H}--verbose               ${DIM_H}Show reasoning steps in real-time${RESET_H}
  ${TEXT_H}--optimizer             ${DIM_H}Mildly auto-optimize your query before analysis${RESET_H}
  ${TEXT_H}--json                  ${DIM_H}Output result as JSON${RESET_H}
  ${TEXT_H}--session-dir ${DIM_H}<dir>    ${RESET_H}Directory for session files (default: .rlm-sessions)
  ${TEXT_H}--resume-session ${DIM_H}<id> ${RESET_H}Resume a previous session by ID
  ${TEXT_H}-h${DIM_H}, --help          ${RESET_H}Show this help
  `);
  console.log(`${BOLD_H}Examples:${RESET_H}
  ${DIM_H}$${RESET_H} ${TEXT_H}rlm ${DIM_H}./my-project${RESET_H} "How does authentication work?"
  ${DIM_H}$${RESET_H} ${TEXT_H}rlm ${DIM_H}https://github.com/expressjs/express${RESET_H} "Explain the middleware chain"

  ${DIM_H}$${RESET_H} ${TEXT_H}rlm ${DIM_H}data.csv${RESET_H} "Find and categorize executable insights from feedback"

  ${DIM_H}$${RESET_H} ${TEXT_H}rlm ${DIM_H}https://github.com/owner/repo/pull/123${RESET_H} "Review this PR"

  ${DIM_H}$${RESET_H} ${TEXT_H}rlm --sources ${DIM_H}express=https://github.com/expressjs/express koa=https://github.com/koajs/koa${RESET_H} --goal compare
  ${DIM_H}$${RESET_H} ${TEXT_H}rlm --sources ${DIM_H}source=.../repoA target=./my-project${RESET_H} --goal steal "focus on auth"
  ${DIM_H}$${RESET_H} ${TEXT_H}rlm --sources ${DIM_H}a=./repo-a b=./repo-b${RESET_H} --goal understand "how do they handle caching?"

  ${DIM_H}$${RESET_H} ${TEXT_H}rlm -p ${DIM_H}"What is the weather in SF?"${RESET_H}
  ${DIM_H}$${RESET_H} ${TEXT_H}rlm --prompt ${DIM_H}"Help me write a script"${RESET_H}
  ${DIM_H}$${RESET_H} ${TEXT_H}rlm -p${RESET_H}                                                   ${DIM_H}Interactive prompt mode${RESET_H}
  `);
  process.exit(0);
}
