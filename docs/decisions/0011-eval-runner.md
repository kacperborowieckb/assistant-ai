# 0011: Eval runner

Status: accepted

Date: 2026-11-15

Extends [0002](0002-agent-authority.md) and [0009](0009-agent-loop-and-client-boundaries.md). Issue #37.

## Decision

### Command and cost

- `pnpm control eval --k <n> [--case <name>]...` runs each Eval Case k times and reports pass^k. A case passes only when all k runs pass.
- It calls the real model through AI Gateway, so it costs money. It is not part of `pnpm verify`. An agent runs it only with the repository owner's approval (0002). It reads `AI_GATEWAY_URL` and `AI_GATEWAY_TOKEN` from the environment or `.dev.vars`.
- It loads and checks every selected case before it starts the Worker, then prints the range of expected model calls, and only then calls a model.

### What runs

- The runner starts the real Worker in the wrangler test harness, with temporary local storage and a fake Telegram API on `127.0.0.1`. The Worker entry is `apps/agent/eval/worker.ts`. It is the real Edge, Personal Agent, Turn, tools, and Model Gateway, plus three eval routes that only the eval entry has: seed, observation, and judge. The routes need the Operator token of the local run. The deployed Worker (`src/index.ts`) has none of this code.
- Each run adds a new Owner through the Operator route, so each run has its own Personal Agent storage. The runner seeds the Notes and Profile of the case through the `Notes` and `Profile` modules, sends each Owner Event as a Telegram update to the webhook, and waits until the Inbox has no pending Event. Then it reads the Notes with their links, the Profile, the tool calls from the Traces, and the Usage, through the modules that own them. No eval code runs SQL.
- The model routes come from `wrangler.jsonc`, so the Eval measures the configured agent.

### Cases and checks

- An Eval Case is one TypeScript file in `apps/agent/control/eval/cases`. Its name is the file name. Its default export has a description, optional seeded Notes and Profile entries, the Owner Events (text, or text forwarded from a named sender), and checks. `satisfies EvalCaseFile` types it in the editor, and an Effect Schema decodes it at load time, so an invalid file fails with the file name and the path of the bad field.
- Checks are data, not functions, so the report can name them and the schema can check them. Code checks read storage and the Trace: `note_count`, `note_matches`, `profile_entry_count`, and `tool_calls`. A new kind of check is a new schema member and a new branch of `evaluateCodeCheck`.
- `reply_judged` asks a judge model if the replies meet a fixed rubric written in the case. The judge is the `eval_judge` Model Task of the Model Gateway, with its own route (`EVAL_JUDGE_MODEL`, `EVAL_JUDGE_REASONING_EFFORT`). It sees the whole conversation of the run and answers with a JSON verdict. A judge answer that is not a verdict, or a judge model failure, fails the check. Judge Usage is collected for the report and is not written to the Owner's Usage.

### Report

- For each case: pass or fail, the number of passed runs of k, each failed check with its run and what the runner found, and the input, cached, and output tokens of the agent and of the judge. Cost shows as unknown until Usage records cost (#27).
- A Turn that does not finish within the worst case of the step limit and the model retries fails its run, not the command. A failure of the local Worker itself stops the command.

## Why

The quality of Capture and Recall is model behavior, and tests with a fake model cannot prove it. Running the real Worker, not a copy of the Turn, means that every later slice (Reminders, the Brief, Forget, Untrusted Content) is measured through the same path that the Owner uses, and new cases need no new runner code. Data checks keep the case files short, reviewable, and checked before money is spent. A separate Model Task keeps the judge on the one model interface, with its own model and thinking level.

## Revisit if

- A case needs a check that data cannot express, such as a check on the order of tool calls.
- The cost or duration of an Eval run needs concurrent runs.
- Usage records cost (#27): show the real cost and remove the unknown text.
- The judge model gives unstable verdicts for the same reply. Then pin a stronger model for `eval_judge` or score with code.
