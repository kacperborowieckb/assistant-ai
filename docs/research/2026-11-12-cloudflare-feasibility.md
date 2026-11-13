# Open-source Boski-like personal agent on Cloudflare: feasibility

Date: 2026-11-12

Status: research source. The product decisions that follow from it are in [the vision](../product/vision.md), [the MVP](../product/mvp.md), [the architecture](../product/architecture.md), and [docs/decisions](../decisions/). Where a decision differs from this research, the decision is correct.

## Verdict

Yes, it is doable. A single-user, self-hosted Boski-like agent fits well on Cloudflare Workers + the Agents SDK (Durable Objects), with the Vercel AI SDK for the model loop and Effect for the service layer. The free Cloudflare plan covers the infrastructure for one person. The LLM bill does not: each user brings their own API key (Anthropic, OpenAI, or an AI Gateway key), or accepts the small Workers AI free quota.

Three Boski features do not carry over cheaply: iMessage (needs a Mac relay or a paid vendor), WhatsApp (needs Meta Business setup per user), and a heavy browser agent (Browser Rendering free time is small). Use Telegram + email + a web chat as the default channels, and keep the others as optional adapters.

Final check against the Cloudflare docs: the always-on design fits the free plan. Durable Objects (SQLite) are on the free plan, and an idle object sleeps without dropping clients and costs no time (pricing, WebSockets). Workflows are on the free plan, can sleep up to one year, and can wait for an event such as an owner approval (Workflows, limits). The Cloudflare chat agent is built on the AI SDK and uses `streamText` (chat agents).

Out of scope: a full computer per task. Containers and the Sandbox SDK need the Workers Paid plan ($5 per month) (Containers pricing, Sandbox). The capability ladder stops at the browser. A sandbox stays a far-future option at most, and the design must not depend on it.

## Recommended approach

All four sources (Boski, the Instinct teardown, the MEGA lessons, the always-on agents talk) agree on one shape: a thin channel layer, one stateful agent per owner that sleeps when idle, durable helpers for long work, and safety rules in code. The table merges their advice into one decision for each area.

| Area | Recommendation | Backed by |
| --- | --- | --- |
| Runtime | One stateful agent per owner. It sleeps when idle and wakes on any trigger. State lives on the server, never inside a sandbox. | Talk, Boski |
| Channels | Thin clients. Every channel is an adapter around one "send to owner" action, and the adapter shows drafts, approvals, forms and reactions in its own way. | Talk, Instinct |
| Input | Acknowledge at once, merge bursts into one turn, let owner messages go before background work, and drop duplicate retries. | Instinct, Talk |
| Long work | The main agent stays short and fast. Helpers run as durable workflows that resume at the failed step and return only results. | Instinct, Talk, MEGA |
| Capability order | Conversation, then integration, then web search, then browser. Ask the owner last. No full computer (out of scope). | Talk |
| Tools | Few native tools, discovery by name, honest results, errors that say what to do next, and a dedicated tool when one pattern dominates. | MEGA, Talk |
| Context and cost | Static prompt prefix in a fixed order, no tool changes during a turn, compaction while the cache is warm, large outputs to files. | Talk, MEGA |
| Memory | Notes that the agent builds, found by keyword search, in layers: core facts, dated logs, short-lived scratch notes, then files. | Instinct, MEGA, Talk |
| Safety | Guardrails in code. A reviewer model checks each action. The owner approves irreversible actions. Untrusted content is never an instruction. Secrets go through secure forms. | All four |
| Proactivity | Proactive by default: the agent starts the conversation when it can help and does not wait for a request. It wakes on events and self-set schedules, then decides if the owner needs to know. Daytime only, with a message and token budget. The right balance is still an open problem. | Instinct, MEGA, Talk |
| Quality loop | Trace every turn. Every failure becomes an eval case: fix, check the eval, then ship. | MEGA, Talk |
| Extensibility | Six primitives plus one behavior config. Build as little as possible, for the next model, because each new model makes some of the harness unnecessary. | MEGA, Talk |

## What Boski is

Boski is a hosted personal AI agent: you text it a task, it does the work, and it reports back. Free plan refills weekly; paid is $5 per week. Its privacy policy shows the stack: Vercel + Neon Postgres + Vercel AI Gateway (Anthropic and OpenAI, with a model router), Twilio/WhatsApp/iMessage, Resend, Exa and Apify.

- Channels: WhatsApp, iMessage, email, web and mobile apps.
- Memory: profile, preferences, contacts, notes, to-dos, journal; per-user embeddings for recall.
- Scheduled work: reminders, recurring tasks, daily briefings.
- Integrations: a directory of MCP servers (Notion, Linear, Todoist, Zapier, finance, travel, smart home) plus Google Mail and Calendar.
- Browser agent: logs in to sites with saved credentials and fills forms (cancel subscriptions, file claims).
- Approval step: purchases and bookings wait for the user to approve (use cases).

## Feature mapping

Every core Boski feature has a direct Cloudflare primitive; only the channels and the browser agent have real gaps.

| Boski feature | Cloudflare piece | Fit on free plan |
| --- | --- | --- |
| Chat + agent loop | Agents SDK Agent (one Durable Object per user) + AI SDK `streamText` with tools | Good |
| Memory (facts, notes, to-dos) | Durable Object SQLite notes with keyword search; Vectorize later for hybrid search | Good |
| Reminders, recurring tasks, briefings | Agents SDK `schedule()` (DO alarms); Workflows for long multi-step jobs | Good |
| Integrations | Agents SDK MCP client to remote MCP servers; OAuth tokens in DO storage | Good, OAuth per server is work |
| Google Mail and Calendar | Google OAuth + REST calls as AI SDK tools | Good, Google app verification is a hurdle |
| Email channel | Email Routing into a Worker `email()` handler; reply via `send_email` binding or Resend | Good, free sending limits unconfirmed |
| Telegram channel | Bot webhook into a Worker | Good, free |
| WhatsApp channel | Meta Cloud API webhook | Possible, each user needs a Meta Business app |
| iMessage channel | No Cloudflare path; needs a Mac relay or vendor | Poor |
| Browser agent | Browser Rendering + Puppeteer/Stagehand | Weak: 10 browser minutes per day |
| Approval before action | Tool returns "needs approval"; DO keeps pending action; user confirms in chat | Good |
| Files, voice memos | R2 for storage; Workers AI Whisper for speech to text | Good |

## Proposed architecture

Each owner gets one `PersonalAgent` Durable Object from the Agents SDK. It holds state, memory, schedules and MCP connections, so no separate server or database is needed.

A channel webhook hits the Worker, which checks the owner and forwards to the agent. Replies and scheduled briefings go back out through the same channel adapter.

## Always-on runtime

The agent behaves like a colleague: it sleeps when idle, wakes on any trigger, works in the background, and starts the conversation when it can help.

Proactive by default. Proactivity is a core goal, not an extra. The agent does not wait for the owner to ask. It starts the conversation when a deadline comes near, a task stops, an email needs a reply, a plan changes, or something it watches changes. It sends a short daily briefing, follows up on open tasks, and suggests the next step. Limits keep this useful and not annoying: quiet hours, a daily message budget and a token budget, one message for many small events, and a "less of this" reply that the agent saves as a preference. For each proactive message, record if the owner acted on it, ignored it, or muted it, and use that to tune the behavior.

- Sleep and wake. The Durable Object sleeps between events and reloads its state on the next one. A sandbox or browser starts only when a task needs it and stops after. The agent loop never runs inside the sandbox, so you can rebuild the sandbox at any time.
- Triggers and router. Messages, mail, webhooks, finished helpers and schedules all enter one inbox. A router drops duplicates, merges bursts into one turn, and decides if the owner needs to hear about it.
- Priority. A direct message from the owner stops the current turn and goes first. Group chats, webhooks and routines wait in line.
- Durable workflows, not plain queues. After a crash, a plain queue replays every step. A durable workflow resumes at the failed step. Each helper is its own durable workflow, so a crash loses no progress.
- Main agent and helpers. The main agent keeps a short context and a to-do list of helpers. It can check, message or stop a helper. Helpers do the expensive work in a fresh context and return only the result. Use a fast model for the main agent; helpers can use slower, cheaper models.
- One send action. The agent reaches the owner through one action. Each channel adapter decides how to show it: text, a reaction, an approval draft, a sign-in form, a payment step.
- Capability ladder. Try the cheapest reliable source first: conversation, integration, web search, browser. A full computer is out of scope. Ask the owner only when all of these fail. In a browser, read the accessibility tree before taking screenshots, and click by pixel position last.
- Cache discipline. Keep tool definitions and the system prompt static, in a fixed section order. Do not add or remove tools during a turn; give tool names only and load schemas on demand. A cache miss is a bug. When the owner goes idle, compact the conversation before the provider cache expires; a Durable Object alarm can trigger this. Where a channel shows typing, warm the cache early.

## Core primitives

Build a few general blocks, not many features. The agent combines them to handle cases nobody designed for, and a fork extends them without core changes.

| Primitive | What it is | Where it lives |
| --- | --- | --- |
| Channel | The agent's only way to reach the owner | Channel adapters in the Worker |
| Event | A signal from any source: a message, a mail, a webhook | Inbox table in the Durable Object |
| Schedule | A wake-up that the agent sets for itself | Durable Object alarms |
| Document | All that the agent writes, for itself or for the owner | Notes in Durable Object SQLite, files in R2 |
| Skill | Repeated work saved for reuse, with the tools it names | Skill files, loaded only when needed |
| Journal | Append-only log of every action and its result | Durable Object SQLite. The agent reads it but cannot edit it. |

An event can start a skill, a schedule can target a group of documents, and every step writes to the journal. In a daily reflection, the agent reads its journal to decide when to wake next, what to save as a skill, and what to tell the owner.

Design rules for the agent core:

- Principles with reasons, not procedures. The core prompt states principles and why they exist. Owner preferences extend the core; they do not replace it.
- State in, not everything in. At the start of a turn, inject the current state (open tasks, pending approvals, next wake-ups). During a turn, inject only what changed.
- Stable prompt prefix. Keep the start of the context the same between turns so the provider cache hits. Put changing data last and track the cache hit rate.
- Few tools, honest results. Keep a small set of native tools. Each tool returns real success or failure, because many APIs report success when the action failed. Large results go to a file, and the model gets a reference.
- One provider gateway. All model providers sit behind one interface, with a main model and a cheaper second model for each task type.
- Durable runs. An approval can wait for days. A run must pause, survive a crash, and resume.
- Agent to agent, later. When it talks to other people's agents, it shares no internals, sends all needed context in each request, and never takes instructions that change its own data.

## Memory as a knowledge base

Treat memory as a small knowledge base that the agent builds and maintains, not as a vector store. At personal size, keyword search plus a short index and profile is enough. Add similarity search later as a second signal, because "similar in meaning" is not the same as "relevant".

- Four parts, each designed on purpose: structure, extraction (what gets saved), retrieval (how it is found), and context (how it is shown to the agent).
- One inbox. Every new item (message, voice memo, mail, webhook) enters through one inbox. The agent files it and links it to existing notes.
- The agent builds the structure. Give it the purpose and a clear "good enough" definition. It proposes folders and note templates, tests them, and improves them as the base grows.
- Layers of context. A global profile (who the owner is, tools, active projects), a work board (planned, active, done, archived) for the broader picture, then linked notes.
- Metadata on every note: source, trust level, and date last checked.
- One source of truth. The base owns only its own notes. For data that other services keep well (calendar, mail), store a pointer note, not a copy. No two-way sync.
- Contradictions and time. A newer fact replaces an older one but keeps the history. An unclear fact (two people with the same name) stays a temporary note until it is resolved.
- Scheduled upkeep. Merge duplicates daily; fix structure and fill gaps weekly. Every change goes to the journal and can be undone.

Context layers per turn. (1) Core facts about the owner, in every prompt; a style rule such as "lowercase only" must never drop out. (2) Dated logs of past work, found by search ("what did I do last week?"). (3) Short-lived scratch notes for the current task, removed after a few hours. (4) All other data, in files the agent searches when it needs them. Compaction loses detail, so core facts stay outside the summary and are added again on every turn.

## Free tier limits

For one user, the free plan is far above need, except browser minutes. A heavy user sends maybe 200 messages a day; each message costs a few Worker and DO requests.

| Service | Free limit | One-user impact |
| --- | --- | --- |
| Workers | 100,000 requests/day, 10 ms CPU per request, 5 cron triggers | Fine. Waiting on the LLM is I/O, not CPU. Keep JSON and Effect work light. |
| Durable Objects | 100,000 requests/day, 13,000 GB-s/day, 5 GB SQLite | Fine. SQLite-backed DOs are on the free plan. |
| D1 | 5M rows read, 100k written/day, 5 GB | Optional; DO SQLite is enough. |
| Vectorize | 30M queried dims/month, 5M stored dims | About 6,500 memories at 768 dims. Enough for years of notes. |
| Workers AI | 10,000 neurons/day | Enough for embeddings and Whisper. Too small to be the main chat model. |
| Browser Rendering | 10 browser minutes/day, 3 concurrent | The one hard limit. A few short web tasks per day. |
| Queues | 10,000 ops/day | Fine for retries and fan-out. |
| Workflows | 3,000 steps/day, state kept 3 days | Fine for long tasks. |
| R2 | 10 GB, 1M writes, 10M reads per month | Fine. |

The real running cost is the LLM. Each deploy sets its own provider key as a Worker secret. At typical use, that is a few dollars per month with a small model for routing and a strong model for hard tasks.

## Risks and hard parts

The hard parts are setup friction and trust, not compute.

- AI SDK and Effect overlap. Both have a model layer (`ai` and `@effect/ai`). Pick one owner: AI SDK for the model loop, tools and streaming (the Agents SDK chat agent is built on it); Effect for services, config, errors, retries and the tool implementations. Wrap each AI SDK tool execute in `Effect.runPromise` with a shared runtime. Do not use both model layers.
- Effect on Workers. Effect is a good fit, used in the right place. Use it for services, config, typed errors, retries, timeouts, channel adapters, tool code and schema checks. Let the AI SDK own the model loop, and do not use Effect's own AI modules next to it. Build the runtime once per Durable Object, not per request. No public benchmark exists for Effect on Workers, so measure bundle size and CPU time on the free plan in the first week.
- OAuth per integration. Google needs a verified app for Gmail scopes, else each self-hoster makes their own Google Cloud project. Document it as an optional step.
- Channels. Telegram and email are free and simple. WhatsApp needs a Meta Business app per deploy. iMessage has no clean path.
- Browser agent. 10 minutes per day is enough for a demo, not for Boski-style bill negotiation. Make the browser provider pluggable (Browser Rendering, Browserbase, or none).
- Secrets and safety. Saved site passwords and payment actions are high risk. Use Workers secrets + encrypted DO fields, an approval gate on every write action, and an allowlist of who may message the bot.
- Prompt injection. Email and web content reach the model. Keep write tools behind approval and never let tool output change the allowlist.
- Agents SDK churn. The SDK moves fast. Pin versions and keep the agent core behind your own interfaces.

## Reliability: guardrails, tracing, evals

You cannot debug a model call like code, so guardrails, tracing and evals go into the first version, not after launch.

- Guardrails in code first. Allowlists, approval rules and blocked actions live in code. A prompt rule only changes the odds.
- Untrusted input and output. Clean incoming text (hidden Unicode, encoded payloads). Check outgoing text for secrets and personal data. Tools may reach only known network targets.
- Trace the full context. For each turn, record the prompt, injected state, tool calls, results, cost, latency and cache hits. You must be able to replay any turn.
- Self-reflection. A scheduled job reads traces and the journal, and proposes fixes: shorter paths, cheaper models, silent failures.
- Heartbeat. Long tasks report progress. A task with no heartbeat is marked stuck, and the owner is told.
- Evals in the repo. Start with 10 to 20 general cases (approvals, batching, memory recall, honest failure). Score the full sequence of steps, not only the final answer. Measure pass^k (pass on every one of k runs), because results change between runs. Each fork runs the same evals on its own changes.

Auto-review over approval fatigue. A separate reviewer model checks every action before it runs. The owner approves only irreversible actions, money, and messages sent in the owner's name. This is safer than asking the owner to approve hundreds of small steps.

Failure-to-eval loop. Every wrong action becomes an eval case. Fix the prompt or the harness, confirm that the eval passes, then ship. Mail, web pages and webhooks are data and never instructions, and the evals include injection cases to check this.

## Lessons from Instinct

Users judge a texting agent by how it behaves, not only by what it can do. A user's measured teardown of Instinct, a similar text-based assistant, gives these rules to build in from day one.

| Lesson | What to build |
| --- | --- |
| Acknowledge at once | Mark the message as received or react within about 1 second, before the model runs. |
| Batch bursts of messages | Wait a short window, merge messages that arrive together, and let a later value replace an earlier one. |
| Keep chat free during long tasks | The chat agent gives long jobs to a separate task runner, which reports back when done. Quick questions get answers while the job runs. |
| Text like a person | Short messages, no markdown, each reply linked to the message it answers, links in their own message. Put these rules in the channel layer, not only in the prompt. |
| Show before acting, check after | Every send, form or purchase reaches the owner first as a draft or a price. After the action, verify the result (final price, bounced email) and report problems. |
| Report only what the channel confirms | Tool results carry the real delivery status. The agent never says "sent" when it cannot confirm it. |
| Memory the owner can read and delete | Small linked notes plus a short profile summary in each turn, a daily cleanup job, and a "forget" command that really deletes. |
| Proactive, but polite | Follow up on dropped tasks about a day later, only in daytime. Give background runs a token budget, because they cost more than chat. |
| Keep sensitive data out of chat | Card and ID numbers go through a one-time secure form, never through the message thread. |

These behavior rules are what each fork will tune. Keep them in one config file, so a user changes how the agent texts without touching the core.

## Clone-and-deploy plan and MVP

The target: `git clone`, one setup command, `wrangler deploy`, and the user talks to the agent on Telegram in under 10 minutes.

1. Deploy path. A "Deploy to Cloudflare" button plus `npm run setup`, which creates the Vectorize index, R2 bucket and Queues, writes `wrangler.jsonc`, and asks for secrets (`LLM_API_KEY`, `TELEGRAM_BOT_TOKEN`, `OWNER_ID`).
2. MVP scope.
   - Web chat + Telegram channel.
   - One `PersonalAgent` Durable Object with memory (notes in SQLite, keyword search first) and a journal.
   - Reminders and a daily briefing through `schedule()`.
   - MCP client with a config file of servers.
   - Auto-review plus owner approval for irreversible tools, message batching, and helpers as durable workflows that keep chat free during long jobs, idle compaction, turn tracing, and a starter eval set.
3. Version 2. Email channel, Google Mail and Calendar, voice memos, Workflows for long tasks, a pluggable browser tool, hybrid memory search, scheduled self-reflection.
4. Plugin seam. Two small interfaces keep it easy to extend: Channel (receive, send) and Skill (tools + prompts + optional schedule). Each is an Effect Layer, so a fork adds a channel or skill without touching the core.

Open question: one agent per deploy (simplest, best privacy) or multi-user per deploy (shares one Cloudflare account, hits free limits sooner). Recommendation: one owner per deploy.

## Sources

- boski.com, privacy policy, MCP servers, use cases
- Cloudflare docs: Workers limits, Durable Objects pricing, Agents SDK, Browser Rendering pricing
- Not checked: free-plan quotas for sending email from Workers; LLM cost per month is an estimate.
- MEGA course lessons S01E03 (knowledge systems), S01E05 (security), S02E01 to S02E05 (agents), local course material.
- Lee Robinson, How always-on agents work, Stanford CS146S lecture (transcript).
