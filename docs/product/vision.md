# Vision

Working name: assistant-ai. Choose a brand name before a public or paid launch.

Terms follow [CONTEXT.md](../../CONTEXT.md). The research source is [the Cloudflare feasibility study](../research/2026-11-12-cloudflare-feasibility.md).

## One sentence

A personal agent that you text like a colleague: it remembers everything you tell it, starts the conversation when it can help, and does the work for you, safely.

## Problem

- People keep their life in many places: notes apps, chats, reminders, email, and their own head. They lose things, and they forget to follow up.
- Notes apps and reminder apps are passive. You must remember to look, to search, and to set every reminder.
- Hosted AI assistants exist, but they keep your most private data on someone else's servers, and you cannot change how they behave.

## Users

1. **Self-hosters now.** Technical people who fork or clone the repository, deploy it to their own Cloudflare account, and bring their own model key. They own their data and can change the behavior.
2. **Non-technical Owners later.** People who cannot deploy software. They will use a paid hosted product with a native mobile app. The MVP does not build this product, but no MVP decision may block it.

## Value

For the Owner:

- **Nothing gets lost.** Capture is one message in a chat app you already use. Recall answers in plain language and names its source.
- **The agent comes to you.** A daily Brief and follow-ups on open items, without a request, within quiet hours and a budget.
- **Your data stays yours.** Each Owner has separate storage. Self-hosters run it on their own account. Forget really deletes.
- **It can be trusted.** It reports only what it can confirm. Safety rules live in code, not only in the prompt.

For the Operator:

- From `git clone` to the first Telegram reply in less than 10 minutes.
- The Cloudflare free plan covers the infrastructure for one Owner. The only real cost is the model, paid by the Operator.
- A fork can change behavior, add a Channel, or add a Skill without changes to the core.

For the future hosted business:

- The same code serves many Owners, with isolation by structure (one Personal Agent and one database for each Owner).
- Usage is measured for each Owner from day one, so paid plans can be priced and enforced.

## Principles

1. **Proactive by default.** The agent starts the conversation when it can help. Limits (quiet hours, budgets, merged messages, "less of this") keep it useful and not annoying. Each Proactive Message records its Outcome so the behavior can be tuned.
2. **Behaves like a person in a chat.** It acknowledges at once, merges bursts of messages, sends short messages without markdown, and keeps the chat free during long work.
3. **Honest results.** The agent never says "done" or "sent" when it cannot confirm it.
4. **Guardrails in code.** Allowlists, approvals, and blocked actions are code. Untrusted Content is never an instruction.
5. **Memory the Owner controls.** Memory is a small knowledge base that the agent builds and the Owner can read and delete.
6. **Few general primitives, not many features.** Channel, Event, Schedule, Document, Skill, and Journal, plus one Behavior Config. Build as little as possible, because each new model makes some of the harness unnecessary.
7. **Multi-owner by design, single-owner by configuration.** Every operation runs for one Owner. Self-hosting is the hosted product with one Owner and closed Registration.
8. **Reliability from the first version.** Every Turn has a Trace. Every failure becomes an Eval.
9. **The MVP limits scope, not quality.** The MVP builds fewer features. It does not take short paths. Each part it builds uses the design that the long-term product needs (many Owners, the hosted product, the mobile app). When the MVP choice and the long-term choice differ, use the long-term choice. A temporary solution is not permitted unless a decision record names it, gives the reason, and states when it is replaced.

## Direction (after the MVP)

These directions are valid but need more definition before we build them. The order can change.

- **Actions with Approval and Auto-review:** the agent drafts and does work (messages, bookings, forms). The Owner approves irreversible actions.
- **Integrations:** remote MCP servers, Google Mail and Calendar, with pointer Notes and no copies.
- **Inbox triage:** an email Channel, and the agent sorts mail and shows what matters.
- **More capture:** voice memos, photos, and files.
- **Helpers:** long work in durable workflows, so the chat stays free.
- **Native mobile app:** the main screen is chat, plus settings. The Owner chooses Telegram or the app.
- **Hosted paid product:** accounts, billing, and onboarding for non-technical Owners.
- **Capability ladder:** conversation, then integration, then web search, then browser. Ask the Owner last.

## Non-goals

- A web app for Owners. A web site exists only for marketing.
- A full computer or sandbox per task. Containers and the Sandbox SDK are out of scope, and the design must not depend on them.
- iMessage and WhatsApp as built-in Channels. They can come later as optional adapters.
- Two-way sync with other services. The agent stores pointers to data that other services keep.
- A vector store as the main memory. Keyword search comes first, and similarity search is a second signal later.
