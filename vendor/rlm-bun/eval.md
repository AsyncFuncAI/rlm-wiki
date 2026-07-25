# RLM-Bun Evaluation Harness

## Overview

The RLM-Bun eval harness is a systematic evaluation framework for measuring the quality of RLM-Bun as a generalist code analysis agent. It tests the agent against **real open-source repositories** using scored rubrics, trajectory analysis, and LLM-as-judge evaluation.

Inspired by evaluation approaches like [SWE-bench](https://www.swebench.com/), the harness focuses on **code understanding** rather than code editing — measuring how well the agent can explore, comprehend, and explain codebases in response to natural language queries.

Each eval problem points the agent at a real GitHub repository, asks a code analysis question, and scores the response against a weighted rubric judged by a separate LLM. Beyond answer quality, the harness also measures **trajectory efficiency** — how many steps the agent took, how quickly it found relevant files, whether it hit dead ends, and how much it cost.

## Quick Start

```bash
# Run all 10 evals (requires ANTHROPIC_API_KEY by default)
bun run tests/evals/run-evals.ts

# List available eval problems
bun run tests/evals/run-evals.ts --list

# Run specific problems
bun run tests/evals/run-evals.ts --problems gateway-auth-flow,gemini-state-mgmt

# Verbose output (see step-by-step progress)
bun run tests/evals/run-evals.ts --verbose
```

**API Key Requirements:** Set the appropriate environment variable for your chosen provider:

| Provider | Environment Variable |
|----------|---------------------|
| Anthropic (default) | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Google Gemini | `GEMINI_API_KEY` |

## CLI Reference

```
Usage: bun run tests/evals/run-evals.ts [options]
```

### Options

| Flag | Argument | Default | Description |
|------|----------|---------|-------------|
| `--problems` | `<id1,id2,...>` | all | Filter to specific problem IDs (comma-separated) |
| `--model` | `<model>` | `claude-opus-4-7` | LLM model for the agent |
| `--provider` | `<provider>` | `anthropic` | LLM provider: `anthropic`, `openai`, or `gemini` |
| `--judge-model` | `<model>` | same as `--model` | LLM model for the judge |
| `--judge-provider` | `<provider>` | same as `--provider` | LLM provider for the judge |
| `--concurrency` | `<n>` | `1` | Number of evals to run in parallel |
| `--output` | `<dir>` | `./eval-results` | Output directory for result JSON files |
| `--verbose` | — | off | Show detailed progress and per-step logs |
| `--list` | — | — | List all available problems and exit |
| `--compare` | `<file1,file2>` | — | Compare two or more previous run result JSON files |
| `--report` | `<file>` | — | Generate a detailed markdown report from a run JSON file |
| `-h`, `--help` | — | — | Show help text |

### Examples

```bash
# Use GPT-4o as the agent, Anthropic as the judge
bun run tests/evals/run-evals.ts --model gpt-4o --provider openai --judge-model claude-opus-4-7 --judge-provider anthropic

# Run 3 evals in parallel with verbose output
bun run tests/evals/run-evals.ts --concurrency 3 --verbose

# Save results to a custom directory
bun run tests/evals/run-evals.ts --output ./my-eval-results

# Run only easy problems
bun run tests/evals/run-evals.ts --problems gemini-state-mgmt,github-tools-api-surface,agent-skills-architecture

# Compare two runs
bun run tests/evals/run-evals.ts --compare eval-results/run-abc123.json,eval-results/run-def456.json

# Generate a detailed report
bun run tests/evals/run-evals.ts --report eval-results/run-abc123.json
```

## Eval Problems

### Problem Table

| ID | Repository | Category | Difficulty | Description |
|----|-----------|----------|------------|-------------|
| `gateway-auth-flow` | ai-chatbot-gateway | architecture | medium | Trace the complete authentication flow from login to session validation |
| `gateway-streaming` | ai-chatbot-gateway | data-flow | hard | Trace the streaming response pipeline end-to-end from user input to streamed LLM response |
| `gemini-generative-ui` | gemini-chatbot | feature-understanding | hard | Explain the generative UI system for rendering dynamic React components in AI responses |
| `gemini-state-mgmt` | gemini-chatbot | architecture | easy | How is chat history and conversation state managed and stored? |
| `openreview-review-pipeline` | openreview | data-flow | medium | Trace the code review pipeline from webhook receipt to posted review comment |
| `openreview-security` | openreview | security | medium | Audit the security posture: webhook verification, secret management, input validation |
| `github-tools-api-surface` | github-tools | api-surface | easy | Catalog all AI SDK tools: names, parameters, and underlying GitHub API endpoints |
| `github-tools-error-handling` | github-tools | bug-finding | medium | Analyze error handling patterns across all tools for silent failures and edge cases |
| `agent-skills-architecture` | agent-skills | architecture | easy | Explain the skill packaging architecture: structure, discovery, loading, injection |
| `agent-skills-cross-cutting` | agent-skills | cross-cutting | hard | Compare and contrast 3+ skills for shared patterns, differences, and inconsistencies |

### Target Repositories

The eval harness tests against 5 real Vercel Labs open-source repositories:

1. **[vercel-labs/ai-chatbot-gateway](https://github.com/vercel-labs/ai-chatbot-gateway)** — Full-stack Next.js AI chatbot with multi-provider gateway. Tests architecture tracing and streaming data flow analysis.

2. **[vercel-labs/gemini-chatbot](https://github.com/vercel-labs/gemini-chatbot)** — Generative UI chatbot powered by Google Gemini. Tests understanding of dynamic component rendering and state management.

3. **[vercel-labs/openreview](https://github.com/vercel-labs/openreview)** — AI code review bot that processes GitHub webhooks. Tests pipeline tracing and security auditing.

4. **[vercel-labs/github-tools](https://github.com/vercel-labs/github-tools)** — GitHub API wrapped as AI SDK tools. Tests API surface cataloging and error handling analysis.

5. **[vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills)** — Collection of agent skills for coding agents. Tests architecture understanding and cross-cutting comparison.

### Distribution

- **3 easy** problems: `gemini-state-mgmt`, `github-tools-api-surface`, `agent-skills-architecture`
- **4 medium** problems: `gateway-auth-flow`, `openreview-review-pipeline`, `openreview-security`, `github-tools-error-handling`
- **3 hard** problems: `gateway-streaming`, `gemini-generative-ui`, `agent-skills-cross-cutting`

The 10 problems span **10 distinct categories**: architecture, data-flow, feature-understanding, security, api-surface, bug-finding, cross-cutting (plus refactoring, performance, and dependency-analysis available for future problems).

## Scoring System

### 1. Weighted Rubric

Each eval problem defines 3-4 rubric items, each with:

| Field | Type | Description |
|-------|------|-------------|
| `criterion` | string | What is being evaluated (e.g., "Auth provider identified") |
| `weight` | number | Maximum points for this criterion (typically 2-4) |
| `description` | string | What constitutes a good score |

Example rubric:

```typescript
rubric: [
  { criterion: "Auth provider identified", weight: 3, description: "Identifies NextAuth/Auth.js or similar" },
  { criterion: "Session storage mechanism", weight: 3, description: "Explains cookie/JWT/database session" },
  { criterion: "Middleware chain traced", weight: 2, description: "Shows how middleware.ts protects routes" },
  { criterion: "Code references", weight: 2, description: "References specific files and functions" },
]
```

The maximum possible score for this problem is 3 + 3 + 2 + 2 = **10 points**.

### 2. LLM-as-Judge

A separate LLM instance (the "judge") scores the agent's answer against the rubric. The judge receives:

- The original query
- The rubric criteria with max scores
- Expected key findings (ground truth facts)
- Expected vs. actual source files referenced
- The agent's full answer

The judge is instructed to:
- Score each criterion from 0 to its maximum weight
- Consider whether findings were **discovered and evidence-based**, not hallucinated
- Evaluate the quality and depth of explanation
- Verify that referenced source files match expectations

The judge returns structured JSON with per-criterion scores and rationales. Scores are clamped to `[0, maxWeight]` to prevent inflation.

### 3. Normalized Scores

Each problem's total score is normalized to a **0-1 scale**:

```
normalizedScore = totalScore / maxPossibleScore
```

This enables cross-problem comparison regardless of differing max scores. The aggregate score across all problems is the **mean of normalized scores**.

### 4. Expected Key Findings

Each problem lists ground truth facts the agent should discover. These are provided to the judge as reference but are not mechanically checked — the judge uses them to assess whether the agent's findings are genuine discoveries vs. hallucinations.

### 5. Expected Source Files

Each problem lists files the agent should examine. The harness tracks which files the agent actually referenced and provides both lists to the judge for comparison.

## Trajectory Metrics

Beyond answer quality, the harness computes metrics about the agent's exploration process:

| Metric | Type | What It Measures | What "Good" Looks Like |
|--------|------|-----------------|----------------------|
| `totalSteps` | number | Number of think-act-observe iterations | Proportional to problem complexity; 5-12 typical |
| `stepsToFirstRelevantFile` | number | How quickly the agent finds a relevant source file | **Low is better** — 1-3 means efficient navigation |
| `uniqueFilesExamined` | number | Breadth of file exploration | Moderate — enough to answer but not excessive wandering |
| `uniqueToolsUsed` | string[] | Diversity of tools used (readFile, grep, glob, bash, etc.) | **High diversity is better** — agents using 3+ tool types tend to find better answers |
| `deadEndSteps` | number | Wasted iterations (errors, empty output) | **0 is ideal** — dead ends suggest prompt or tool issues |
| `redundantSteps` | number | Steps that re-read files already examined | **0 is ideal** — redundancy wastes tokens and time |
| `avgOutputLength` | number | Average character length of output per step | Moderate — too short means shallow exploration, too long means verbose output |
| `totalTokensUsed` | number | Total LLM token consumption | Lower is more efficient (for same quality) |
| `totalCostUsd` | number | Estimated cost using the pricing module | Depends on model; useful for budget planning |
| `wallClockMs` | number | Total wall clock time | Depends on concurrency and API latency |

### How Metrics Are Computed

- **File detection**: Tool calls like `readFile("path")`, `grep("pattern", "path")`, and `glob("pattern")` are parsed from the agent's code output using regex matching.
- **Dead ends**: Steps where output is empty, `"(no output...)"`, or starts with `"Error"`.
- **Redundancy**: Steps where every `readFile` call targets a file already read in a prior step.
- **Cost**: Computed via the `calculateCost` function from `src/llm/pricing.ts`, using per-model token pricing.

## Comparing Runs

Compare performance across different models, providers, or prompt changes:

```bash
# Run with Claude Sonnet
bun run tests/evals/run-evals.ts --model claude-opus-4-7 --output ./eval-results

# Run with GPT-4o
bun run tests/evals/run-evals.ts --model gpt-4o --provider openai --output ./eval-results

# Run with Gemini
bun run tests/evals/run-evals.ts --model gemini-2.0-flash --provider gemini --output ./eval-results

# Compare the runs
bun run tests/evals/run-evals.ts --compare eval-results/run-abc123.json,eval-results/run-def456.json
```

The comparison table shows:
- **Per-problem normalized scores** for each run, side by side
- **Delta columns** showing score changes relative to the first run (e.g., `+0.15` or `-0.08`)
- **Aggregate row** summarizing overall performance difference

You can compare more than two runs by providing additional comma-separated file paths.

## Generating Reports

Generate a detailed markdown report from any completed run:

```bash
bun run tests/evals/run-evals.ts --report eval-results/run-abc123.json
```

The report includes:

- **Summary statistics**: Run ID, model, timestamp, aggregate score, total cost, total time
- **Score by category**: Average normalized score per category (architecture, data-flow, security, etc.)
- **Score by difficulty**: Average normalized score per difficulty level (easy, medium, hard)
- **Per-problem details**: For each problem:
  - The original query
  - Total and normalized score
  - Judge's overall rationale
  - Per-criterion score table with rationales
  - Trajectory stats (steps, dead ends, files examined, tools used, tokens, cost, time)
  - Error message (if the eval failed)

## Adding New Eval Problems

### Step-by-Step

1. Open `tests/evals/dataset.ts`
2. Add a new `EvalProblem` object to the `EVAL_PROBLEMS` array
3. (Optional) Add a new repo URL to the `REPOS` object if targeting a new repository

### Field Reference

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique kebab-case identifier (e.g., `"my-new-eval"`) |
| `repo` | string | Full GitHub URL of the target repository |
| `query` | string | The natural language question to ask the agent |
| `difficulty` | `"easy" \| "medium" \| "hard"` | Difficulty rating |
| `category` | string | One of: `architecture`, `bug-finding`, `cross-cutting`, `data-flow`, `security`, `performance`, `api-surface`, `dependency-analysis`, `refactoring`, `feature-understanding` |
| `rubric` | `RubricItem[]` | 3-4 scoring criteria with weights |
| `expectedKeyFindings` | `string[]` | Ground truth facts the answer should contain |
| `expectedSourceFiles` | `string[]` | Files/directories the agent should examine |
| `maxIterations` | number | Maximum think-act-observe loops (8-12 typical) |
| `timeoutMs` | number | Total timeout in milliseconds (90000-180000 typical) |

### Template

```typescript
{
  id: "my-new-eval",
  repo: "https://github.com/org/repo",
  category: "architecture",
  difficulty: "medium",
  query: "How does feature X work end-to-end?",
  rubric: [
    { criterion: "Core mechanism identified", weight: 3, description: "Identifies the main implementation approach" },
    { criterion: "Data flow traced", weight: 3, description: "Shows how data moves through the system" },
    { criterion: "Edge cases noted", weight: 2, description: "Mentions error handling or edge cases" },
    { criterion: "Code references", weight: 2, description: "References specific files and functions" },
  ],
  expectedKeyFindings: [
    "Key fact 1 the agent should discover",
    "Key fact 2",
    "Key fact 3",
  ],
  expectedSourceFiles: [
    "src/main-file.ts",
    "src/related-file.ts",
  ],
  maxIterations: 10,
  timeoutMs: 120000,
},
```

### Tips

- **Choose queries with verifiable answers** — the judge needs objective criteria to score against. Avoid subjective questions like "Is this code good?"
- **Set appropriate iteration budgets** — easy problems need 8 iterations, hard problems may need 12. Setting too low causes incomplete exploration; too high wastes cost.
- **Write objective rubric items** — criteria like "Identifies NextAuth usage" are better than "Good understanding of auth." Each criterion should be independently scorable.
- **Include expected source files** — this enables the `stepsToFirstRelevantFile` metric to work correctly.
- **Test your problem** — run it once with `--verbose` to verify the agent can reasonably answer it within the iteration budget.

## Architecture

### File Structure

```
tests/evals/
├── types.ts        — Type definitions (EvalProblem, EvalScore, TrajectoryMetrics, EvalResult, EvalRunSummary)
├── dataset.ts      — The 10 eval problems with rubrics and 5 target repositories
├── judge.ts        — LLM-as-judge scoring (builds prompt, parses JSON scores, handles failures)
├── metrics.ts      — Trajectory quality metrics (parses tool calls via regex, detects dead ends and redundancy)
├── runner.ts       — Orchestrator (creates RLM instance, runs query, invokes judge, computes metrics)
├── report.ts       — Report generation (summary tables, detailed markdown reports, comparison tables)
└── run-evals.ts    — CLI entrypoint (arg parsing, dispatches to runner/report/compare modes)
```

### Data Flow

```
run-evals.ts (CLI)
    │
    ▼
runner.ts (runAllEvals)
    │
    ├─ Creates LLM client (agent) and LLM client (judge)
    ├─ Filters problems by --problems flag
    │
    ├─ For each problem (batched by --concurrency):
    │   │
    │   ├─ Creates RLM instance with problem.repo as source
    │   ├─ Calls rlm.query(problem.query)
    │   │   └─ Returns: answer, sources, trajectory, tokenUsage
    │   │
    │   ├─ judge.ts: judgeAnswer(problem, answer, sources, judgeLLM)
    │   │   ├─ Builds judge prompt with rubric + expected findings
    │   │   ├─ Calls judge LLM for JSON scoring
    │   │   └─ Returns: EvalScore (per-criterion scores, normalized score)
    │   │
    │   └─ metrics.ts: computeTrajectoryMetrics(trajectory, sources, ...)
    │       ├─ Parses tool calls from trajectory code
    │       ├─ Detects dead ends and redundancy
    │       └─ Returns: TrajectoryMetrics
    │
    ├─ Aggregates results by category and difficulty
    ├─ Saves run JSON to --output directory
    │
    └─ report.ts: printSummary(summary)
        └─ Renders color-coded terminal table
```

## Interpreting Results

### Aggregate Score

| Score Range | Interpretation |
|-------------|---------------|
| **> 0.7** | Strong performance — the agent reliably understands and explains codebases |
| **0.4 – 0.7** | Moderate — answers are partially correct but miss key findings or lack depth |
| **< 0.4** | Significant gaps — the agent struggles with the task type or exploration strategy |

### What to Look For

- **Category breakdowns** reveal weak areas. If `security` scores 0.3 but `architecture` scores 0.8, the agent's security analysis prompt needs work.
- **Difficulty breakdowns** show scaling behavior. A big drop from easy to hard suggests the agent struggles with multi-step reasoning.
- **`stepsToFirstRelevantFile`** across problems — consistently high values (> 5) mean the agent explores inefficiently and needs better file navigation heuristics.
- **`deadEndSteps` > 0** suggests prompt issues (the agent is generating invalid tool calls) or tool problems (tools are returning errors).
- **`redundantSteps` > 0** means the agent is re-reading files it already examined — a sign of poor memory or context management.
- **Tool diversity** — agents that use only `readFile` tend to score lower than those that combine `grep`, `glob`, `readFile`, and `bash`.
- **Cost vs. score** — compare models on a cost-efficiency basis. A model scoring 0.7 at $1 may be preferable to one scoring 0.75 at $5.

## Cost Estimation

Rough cost estimates for running the full 10-problem eval suite:

| Configuration | Estimated Cost |
|--------------|---------------|
| `claude-opus-4-7` (agent + judge) | ~$2–5 |
| `gpt-4o` (agent + judge) | ~$1–3 |
| `gemini-2.0-flash` (agent + judge) | ~$0.50–1.50 |
| Judge scoring overhead | ~10–20% of agent cost |

Actual costs depend on iteration count, answer length, and API pricing changes.

**Cost-saving tips:**
- Use `--problems` to run a subset: `--problems gateway-auth-flow,gemini-state-mgmt` runs 2 evals instead of 10
- Use a cheaper judge model: `--judge-model gpt-4o-mini --judge-provider openai`
- Lower iteration budgets mean fewer API calls but potentially lower scores

## CI Integration

### Basic Setup

Add a script to `package.json`:

```json
{
  "scripts": {
    "eval": "bun run tests/evals/run-evals.ts",
    "eval:smoke": "bun run tests/evals/run-evals.ts --problems gemini-state-mgmt,github-tools-api-surface --verbose"
  }
}
```

### CI Workflow Example

```yaml
# .github/workflows/eval.yml
name: Eval Harness
on:
  push:
    branches: [main]
  pull_request:

jobs:
  eval:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2

      - name: Install dependencies
        run: bun install

      # Smoke test: 2 cheap evals
      - name: Run eval smoke test
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: bun run tests/evals/run-evals.ts --problems gemini-state-mgmt,github-tools-api-surface --output ./eval-results --verbose

      # Save results as artifact
      - name: Upload eval results
        uses: actions/upload-artifact@v4
        with:
          name: eval-results
          path: ./eval-results/

      # Optional: compare with baseline
      - name: Compare with baseline
        if: hashFiles('eval-results/baseline.json') != ''
        run: bun run tests/evals/run-evals.ts --compare eval-results/baseline.json,eval-results/run-*.json
```

### Regression Detection

1. Run a full eval and save the result as your baseline: `cp eval-results/run-xxx.json eval-results/baseline.json`
2. In CI, run the same evals after code changes
3. Use `--compare` to detect score regressions
4. Alert if aggregate score drops by more than 0.05 from baseline

### Budget Considerations

- **Smoke tests** (2 easy evals): ~$0.20–0.50 per run — safe for every PR
- **Full suite** (10 evals): ~$2–5 per run — suitable for nightly or release branches
- Consider running the full suite only on `main` branch merges and using smoke tests for PRs
