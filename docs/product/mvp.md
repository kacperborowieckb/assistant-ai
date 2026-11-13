# MVP

Terms follow [CONTEXT.md](../../CONTEXT.md). The reasons are in [the vision](vision.md) and [docs/decisions](../decisions/).

## First job

Capture, Recall, and a proactive Brief through Telegram, for one Owner on a self-hosted Instance.

The MVP proves one thing: an Owner uses the agent every day because it remembers for them and comes to them first.

## User journeys

1. **Set up.** The Operator clones the repository, runs one setup command, deploys to Cloudflare, and gets a Telegram reply in less than 10 minutes.
2. **Capture.** The Owner sends "buy a gift for Ana before Friday" or a link. The agent acknowledges at once, files Notes, links them, and creates a Reminder when the message asks for one.
3. **Burst.** The Owner sends three messages in five seconds. The agent answers them as one Turn. A later value replaces an earlier one.
4. **Recall.** The Owner asks "what was the name of the restaurant Tom liked?" The agent answers from its Notes and names the source and date, or says that it does not know.
5. **Reminder.** At the set time, the agent sends the Reminder.
6. **Brief.** Each morning, outside Quiet Hours, the agent sends a short Brief: due items, open items, and what it suggests next.
7. **Proactive follow-up.** The agent sets its own Schedules. It follows up on an item that stopped about a day later and merges small items into one message. It keeps to the Budget.
8. **Less of this.** The Owner replies "less of this" to a Proactive Message. The agent saves an Owner Preference and records the Outcome.
9. **Forget.** The Owner says "forget everything about project X." The agent shows what it will delete, deletes the content for good, and leaves Tombstones in the Journal.

## In scope

- `apps/agent`: one Cloudflare Worker with the Edge, the Directory, the Personal Agent Durable Object, and the Telegram Channel.
- Multi-owner design: Directory, Owner Id on all storage, Traces, Usage, and jobs. Closed Registration with one Owner from setup.
- Capture of text and links only.
- Memory: Notes in the Personal Agent's SQLite with keyword search, metadata on each Note, and a Profile in every Turn.
- Journal: append-only, with Tombstones for Forget.
- Schedules: Reminders, the Brief, and self-set proactive Schedules.
- Proactivity: Quiet Hours, a daily message Budget, a token Budget for background work, merged messages, Outcome records, and "less of this" preferences.
- Inbox behavior: Acknowledge within about 1 second, merged bursts, Owner messages first, and dropped duplicate webhook retries.
- Behavior Config: typed defaults for each Instance, overridden by Owner Preferences.
- Model Gateway: the provider behind one interface, with the Operator's own key.
- Usage metering for each Owner.
- Reliability base: a Trace for every Turn and a starter Eval set measured as pass^k.
- Setup: `packages/create-assistant`, one command that creates resources, writes config, and asks for secrets, plus a "Deploy to Cloudflare" button.

## Starter Eval set

- Capture: the right Notes, links, and Reminders from realistic messages.
- Recall: correct answers with sources, and an honest "I do not know".
- Burst: merged messages, and a later value replaces an earlier one.
- Brief: content is correct and fits the Behavior Config.
- Proactivity: no Proactive Message in Quiet Hours, keeps to the Budget, merges small items, respects "less of this".
- Forget: the content is gone from storage and Recall, and the Tombstone exists.
- Untrusted Content: an instruction inside a saved link or note is not followed.
- Isolation: an Event for one Owner never reads or writes another Owner's data.

## Out of scope

- Web chat and any web app for Owners.
- The mobile app, the marketing site, and `apps/platform` (accounts, billing, open Registration).
- Write tools, Approval, and Auto-review. Add them with the first write tool.
- MCP client, Google Mail and Calendar, and the email Channel.
- Voice memos, photos, files, R2, and Vectorize.
- Helpers and Workflows. The MVP has no long work.
- Skills as saved reusable work.
- Browser and web search.
- Scheduled self-reflection. Traces are recorded so it can come later.

## Success criteria

The MVP is done when all of these are true:

1. **Daily use.** The owner of this repository uses it every day for 14 days for Capture and Recall and reads the Brief on most days.
2. **Evals pass.** The starter Eval set passes on every one of k runs before each release.
3. **Fast setup.** On a clean Cloudflare account, `git clone` to the first Telegram reply takes less than 10 minutes.

## Open questions

- The default values for Quiet Hours, the message Budget, and the token Budget.
- The value of k for pass^k, and how many runs a release needs.
- The format of the Brief.
- How the Directory is stored: one dedicated Durable Object or D1. To decide during implementation, behind the Directory interface.
