# why we built rlm-bun (and why it ended up building itself)

How do you actually give an AI agent the ability to explore code?

If you've built one, you know the answer. You define a set of tools — readFile, searchCode, listDirectory — and you wire them up so the LLM can call them. The LLM looks at a task, picks a tool, gets a result, picks another tool, gets another result. It's a loop. Tool call, response, tool call, response. Every agent framework works this way, and it makes total sense. You're giving the model capabilities one at a time, like handing someone a flashlight in a dark room.

I built agents this way too. It works. But after a while, something started bugging me. Every time I watched the agent work, it felt like watching someone navigate a city by asking a dispatcher for directions one intersection at a time. "What's at the corner of Main and 5th?" Wait. "Okay, now what's two blocks north?" Wait. The model clearly knew what it wanted to do — you could see it in the reasoning — but the tool-calling interface forced it to take one step, wait, take another step, wait. Five round trips for what a human developer would do in a single line of code.

So we tried something different with rlm-bun. What if the LLM didn't call tools at all? What if it just... wrote code?

Not pseudocode. Not a tool invocation dressed up as a function call. Actual JavaScript, running in a real Bun REPL. The model writes `await Promise.all(files.map(f => Bun.file(f).text()))` and it just runs. Try/catch with fallback strategies. Conditional branches. Loops that adapt based on what they find. All in a single turn, instead of narrating its way through five tool calls to accomplish the same thing. We gave the LLM a runtime instead of a menu, and the difference wasn't incremental. It was a completely different way of working.

But here's the part I wasn't expecting. Once the LLM is sitting inside a runtime — not above it, *inside* it — writing real programs, something strange happens to the topology. In a normal agent, the LLM is at the top, calling down into tools. In rlm-bun, the orchestrator runs a REPL. Inside that REPL, the LLM writes programs. And those programs can spawn full coding agents — Claude Code, gemini-cli — as subprocesses. The LLM didn't move up the stack. It moved *down*. Think of it less as a god-model dispatching tool calls from on high and more as a programmer sitting inside a runtime — one that's powerful enough to shell out to other autonomous agents when the situation calls for it.

Orchestrator runs a REPL. REPL runs programs. Programs spawn agents. The whole topology is inverted from what you'd expect. And once I saw it that way, I couldn't see it any other way. Every flat tool-calling agent started looking like a toy version of what an agent could actually be.

---
**Why this matters vs regular coding agents:**

- **Programs over tool calls** — one JS turn handles conditional logic, fallbacks, and error handling that would take a tool-calling agent 5+ round trips
- **Real async concurrency** — Promise.all() across dozens of files in one turn; tool schemas can't express parallelism
- **Persistent state kills context rot** — the REPL is a long-lived subprocess; variables defined in one turn survive into the next. The LLM stores results as JS variables (const files = await glob(...)) and reuses them across iterations without re-reading. Data stays in the runtime, not bloating the chat context window on every turn.
- **Inverted topology** — orchestrator runs a REPL, REPL spawns agents (Claude Code, gemini-cli); not the flat LLM→tools loop
- **JS is the LLM's native language** — models handle complex ambiguity and adaptive branching fluently in JS; doesn't map to tool schemas
- **Explore, don't load** — treats the codebase as an external environment; only loads what it needs; scales to massive repos and multi-repo workspaces without hitting context limits
- **LLMs calling LLMs from inside the REPL** — the sandbox exposes llmQuery() and llmQueryBatched() so the agent can spin up sub-LLM calls mid-execution. One agent runs the REPL, hits a complex section, fires off a batch of parallel semantic queries to another LLM, gets the answers back, and continues. Recursive intelligence, not a single monolithic LLM pass.
---

Here's the thing nobody talks about: LLMs are genuinely great at writing JavaScript. Models have seen more JS training data than almost any other language. When you give an LLM a REPL instead of a tool palette, it can express complex async logic, chaining, conditionals, error handling, try/catch with fallbacks — all in a single turn. A JS snippet in a REPL is a full program. The expressiveness gap compared to tool schemas is enormous, and it gets wider the more ambiguous and exploratory the task is.

The topology is inverted too. Normal agents call tools. In rlm-bun, the orchestrator agent runs a Bun REPL, and inside that REPL it can spawn other coding agents — Claude Code, gemini-cli — as subprocesses via run_agent(). It can also invoke sub-LLMs directly through llmQuery() and llmQueryBatched() for semantic analysis mid-execution — classify a batch of functions, summarize findings, make judgment calls — without spawning a full editing agent. The LLM isn't a tool-caller. It's a programmer running a runtime, and the runtime can spawn other agents or fire off LLM queries as needed. Orchestrator to REPL to subprocess agents, not the flat orchestrator-to-tools that everyone else does.

And because Bun is async-native, the LLM can write Promise.all(), parallel fetches, concurrent file reads — real concurrency. When you're analyzing a large codebase and want to scan dozens of files simultaneously, this matters enormously. A tool schema gives you sequential operations. A JS runtime gives you the event loop.

That's the core insight. Once I saw it, I couldn't unsee it. The REPL approach means the LLM only loads what it needs, when it needs it, using the same kind of exploratory programming I'd do myself — poking around, running things, checking what comes back.

First commit was February 27th. 41 files, 6,852 lines of JavaScript, already with a full test suite. The core idea was simple: point it at a codebase, let the LLM explore by running code against it.

Within three days it had grown into something bigger. Multi-repo workspace mode, file editing, LSP integration, hash-anchored edits. Once you can explore code programmatically, you immediately want to change it too. So we kept building tools for that.

On March 3rd, we used rlm-bun to migrate rlm-bun itself to TypeScript. Not a migration script — the tool running as an agent on its own source code. 13 modules converted. 1,378 lines of JS deleted, 2,870 lines of typed TS written with Zod schemas and proper interfaces. It worked. That was the moment I actually trusted the architecture.

Same day, agents inside rlm-bun started refining rlm-bun's own CLI. One session reformatted the output. Another redesigned the color system — progress indicators, spinner messages, a dark theme with purple keywords and green strings. The tool was using itself to improve the experience of using itself. Recursive self-improvement sounds like a buzzword until you watch it happen on your own repo.

Then we made the most important decision of the project: we deleted the entire file editing system. writeFile, editFile, multiEditFile, hash-anchored editing with fuzzy matching — all of it, gone. Replaced with a single run_agent() call that delegates to Claude Code. We'd spent days building that editing system, and the hash-anchored approach was genuinely clever. But after actually using it, we realized Claude Code already did file editing better than we were going to. Thousands of lines replaced by one delegation call. This was the inverted topology proving itself — the REPL doesn't need to reimplement what subprocess agents already do well. It just spawns them.

That deletion clarified what rlm-bun actually is. rlm-bun was never meant to replace an editor — that's Cursor and Claude Code's territory. What it actually does is sit one level up: orchestration, analysis, the stuff that requires computation rather than just editing. Cursor and Claude Code are great at reading and editing files inside a project. rlm-bun is better at the stuff they're not built for: exploring large codebases programmatically, running analysis across multiple repos, working with data files, asking questions that require computation rather than just pattern matching on source text. The REPL is what makes that possible — not because REPLs are magic, but because JavaScript is the one language where LLMs can reliably express complex async logic, and Bun is the one runtime where that logic runs fast with no setup overhead.

62% of commits in the git log were made by rlm-bun agents. You can check — the commit messages have Agent-Id fields. The tool wrote more of itself than we did.

The real thing I learned from dogfooding an agent tool is that you find out fast where your tool's actual value is. Not where you hoped it would be, not where your roadmap says it should be. You find out because the tool itself shows you, by being good at some things and mediocre at others. We built a whole file editing system, used it successfully to rewrite the entire codebase, and then deleted it because delegating was better. That's the kind of lesson you only get by running the thing on itself.

---

## what the REPL actually unlocks (four things nobody tells you about)

### why does your agent get dumber the longer it runs?

You've seen this. Turn one, the agent is sharp. It reads the right files, makes the right connections, gives you a crisp answer. Turn ten, it's slower. Turn twenty, it's repeating itself, re-reading files it already looked at, losing the thread of what it was doing. By turn thirty it's basically confused. You're not imagining this. It's context rot, and it's the dirty secret of every tool-calling agent architecture.

Here's what happens. Every time a tool-calling agent reads a file, the contents get pasted into the conversation context. Every tool result, every response, every piece of data — it all accumulates in the same context window the model uses to think. The context fills up. The model starts spending attention on old file contents it doesn't need anymore. Relevant information from earlier turns gets pushed further away. The signal-to-noise ratio degrades with every turn, and the model gets proportionally worse at its job. The model didn't get dumber — you just buried it in its own output.

rlm-bun sidesteps this entirely because data lives in the runtime, not in the chat. When the agent writes `const results = await glob("src/**/*.ts")`, that variable persists in the Bun REPL across turns. It doesn't need to re-read anything. It doesn't need to paste file contents back into the conversation to remember what it found. The context window stays clean — it holds the reasoning, the plan, the current question. The data stays in JavaScript variables where it belongs. The model references `results[3]` instead of re-running a search and re-ingesting the output.

This is a structural advantage, not a minor optimization. Imagine pointing an agent at a 10,000-file monorepo and asking it to do multi-session analysis — find patterns across the whole codebase, track them over time, build up a picture incrementally. With context rot, that's impossible. Every session starts degrading from the first turn. With persistent runtime state, the agent stays as sharp on turn fifty as it was on turn one. The ceiling on what a single agent session can accomplish goes from "maybe twenty turns before it gets confused" to "as long as you need."

### why do complex tasks make agents freeze up or hallucinate?

Give an agent a simple task — read this file, find this function — and it works great. Give it something complex — "refactor this module to use dependency injection, update all the call sites, and make sure the tests still pass" — and watch what happens. It tries to hold the entire plan in its head. It starts well, gets three steps in, then forgets step two, doubles back, overwrites something it already did. Or it just hallucinates the middle part, confidently telling you it updated files it never touched. The model isn't stupid. It's just trying to use natural language as a task runner, and natural language is terrible at that.

The problem is that tool-calling agents decompose tasks mentally. The model writes itself a plan in English, then tries to execute that plan step by step through individual tool calls. But the plan only exists as text in the context. There's no execution structure, no checkpointing, no way to say "I finished step 3 of 7, here's the state so far." If the model loses track — and it will, because context is finite and attention is imperfect — the plan is just gone.

In rlm-bun, the decomposition IS the code. When the agent needs to break a complex task into sub-steps, it writes a program. Loops, conditionals, try/catch blocks, intermediate variables — the task breakdown is expressed as executable structure. `PLAN()` lets it register steps and track progress explicitly. A for loop over modules with a try/catch inside each iteration is a better task decomposition than any English-language plan, because the runtime enforces the structure. The agent can't skip a step or forget where it was. The code is the plan, and the code runs.

This unlocks something that current agents genuinely can't do: multi-phase tasks that span significant complexity without losing coherence. Think about agents that plan, execute, checkpoint their state into variables, hit an error, recover, and keep going — not because they're smarter, but because the execution substrate supports it. A program with a loop and a try/catch is more reliable than a model trying to remember what step it's on. That's not a knock on models. It's just using the right tool for the right job.

### why does analyzing a large codebase feel like watching paint dry?

You point an agent at a codebase with 200 files and ask it to find all the places where error handling is inconsistent. You know what happens next. It reads file one, responds. Reads file two, responds. Reads file three, responds. Each file is a full round trip — model generates a tool call, tool executes, result goes back to model, model processes it, generates the next tool call. Two hundred files, two hundred round trips. You go make coffee. You come back. It's on file forty-seven.

This is an inherent limitation of the tool-calling loop. Tool schemas don't have a concept of "do these fifty things at the same time." Every tool call is one operation, one response. Some frameworks batch them, but even batched tool calls are still fundamentally sequential in how the model plans them — it can't express "fan out across all files matching this pattern and process them concurrently" in a tool schema. The schema wasn't designed for that. It was designed for one thing at a time.

In rlm-bun, concurrency is just JavaScript. `Promise.all(files.map(f => analyzeFile(f)))` in a single REPL turn. The agent writes the fan-out pattern, Bun's event loop handles the parallelism, and results come back as an array. `llmQueryBatched()` fires off fifty semantic queries in parallel — "classify this function," "summarize this module," "is this error handling correct" — across fifty files simultaneously, in one turn. Not fifty turns. One. The agent gets back an array of answers and keeps working.

Now scale that up. Full-repo semantic audits across a monorepo. Security scans that check every endpoint in a microservices workspace. Dependency analysis across twenty repositories. These aren't theoretical use cases — they're just for loops with async bodies. The difference between "this takes two hours" and "this takes four minutes" is the difference between sequential tool calls and `Promise.all()`. And when something takes four minutes instead of two hours, you actually do it. That's the real unlock — not just speed, but making analysis practical enough that people bother running it.

### what happens to all the work your agent did in the last turn?

This one bothers me more than any of the others. Watch a tool-calling agent carefully. In turn three, it does something genuinely useful — parses a bunch of files, extracts function signatures, builds up a mental model of the dependency structure. Good work. Expensive work, lots of tool calls. Then turn four arrives, you ask a follow-up question, and... it's gone. The agent has no memory of what it computed. It has the text of the conversation, sure, but the actual data — the parsed results, the structures, the intermediate computations — none of that persists. Every turn starts cold. Every turn rebuilds from scratch.

This is the stateless tool-calling problem. Tools execute, results get pasted into context as text, and that's it. There's no runtime to hold state between turns. The model can't say "remember that dependency map I built earlier" because there's no dependency map — there was a blob of text in the context that described one, and by now it's been pushed out by newer content or compressed into a summary that lost the details. The agent is like a developer who closes their terminal after every command.

In rlm-bun, the REPL is a long-lived subprocess. `const depMap = buildDependencyMap()` in turn three is still `depMap` in turn fifteen. The agent accumulates state like a developer who keeps their terminal open. It builds an index in one turn, queries it in the next, refines it in the turn after that. Each turn builds on real computed state, not on the model's recollection of what it computed. You can watch the agent get more capable as the session progresses — not because the model is learning, but because the runtime state is getting richer.

This is maybe the most underappreciated thing about the REPL architecture. Persistent state means the agent can build up indexes, caches, computed graphs, intermediate results — and then operate on that state with increasing sophistication as the session goes on. Early turns are exploration. Middle turns are structuring. Late turns are querying and reasoning over pre-computed data. The session has an arc to it, a progression, like an actual working session with a developer who's building up understanding over time. That doesn't happen when every turn is a blank slate.

The REPL isn't just a different tool interface. It's a different model of what an agent session can be. Tool-calling gives you a conversation with a helpful assistant. A persistent runtime gives you a working session with a programmer who accumulates state, expresses complex logic as code, processes work in parallel, and never loses the thread. Once you see the difference, the old way feels like typing commands into a walkie-talkie.
