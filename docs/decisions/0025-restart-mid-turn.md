# 0025: Restart when a message arrives mid-Turn

Status: accepted

Date: 2026-11-21

Spec #119 (Chat replies), ticket #125. Builds on [0022](0022-chat-replies.md), [0021](0021-outcome-tools.md), and [0023](0023-reaction-outcome.md). It supersedes two rules of 0022: the "Messages during a Turn" rule, where a message that arrives before the send waits for its own Turn (it now restarts the Turn, within the limits below), and the reset recovery that answers a linked Burst at once (a linked Burst whose Delivery has not started now waits for its Quiet Gap, see Restart and reset). The rest of 0022 stands.

## Decision

- **Restart (Option A).** After the model call and before Delivery, the Turn of an Owner message checks the Inbox for a pending Owner message that arrived after the newest message of its Burst and has no Turn of its own. When there is one, the Turn sends nothing, writes a restart record (the Event ids that the next Turn covers and the new ones; see Rollback for how it is stored) and a Trace of the dropped answer with the same Event ids, and leaves the Events pending. The Entry and the Trace are written in one transaction, before any next Turn is planned. A new Turn starts after the Quiet Gap with every message of the Burst, including the new one, and the Owner gets one combined outcome. The check covers every outcome, so a dropped silence or failure notice restarts too. Scheduled Task Turns and proactive Turns never restart.
- **Finished work stays done.** A tool call that finished before a restart is in Turn progress, keyed by the Turn Event, which the restarted Turn keeps (the Burst keeps its first Event). The restarted Turn gets those calls and results as completed steps, the mechanism that recovery after a reset uses, so a write tool is not called again for the same work. The dropped answer writes nothing to the Conversation, and the restarted Turn writes it once. The system prompt of a restarted Turn says that some messages arrived while the agent worked and that the finished steps are done.
- **Step budget.** A restarted Turn shares the `maxToolSteps` budget of its Turn Event with the dropped one, as a Turn after a reset does. Each restart uses the model steps of the dropped answer.
- **Limits.** At most `burstMaxRestarts` (default 2) restarts for a Turn Event, counted from its restart records (see Rollback), and none once `burstMaxWaitMillis` has passed since the first message of the Burst. After that the Turn sends, and a later message gets its own Turn. A reply that was sent is not taken back: a message that arrives after the send, or while the send is in flight, gets its own Turn.
- **Restart and reset.** Everything that decides a restart is in storage: the pending Events, the `AnsweredByTurn` links, the count of restart records, and Turn progress. A linked Burst whose Delivery has not started waits for its Quiet Gap like a new one, where 0022 answered it at once after a reset. A message that arrived while the Durable Object was reset therefore joins it, and the Owner still gets one outcome. A Burst whose Delivery has started is still restored at once. A reset after the send started follows the Delivery rules: an unconfirmed text is not sent again.
- **Rollback.** The restart record (the `TurnSuperseded` Journal Entry of spec #119) is not its own Entry kind. It is an `EventReceived` Entry for the Turn Event with an optional `restart` field (the covered and the new Event ids), and the restart count is the number of such Entries. A version without restarts decodes it as a plain `EventReceived`, because a schema ignores a field that it does not know. Nothing reads `EventReceived` by kind, and the Delivery state and the `AnsweredByTurn` link ignore it, so after a rollback the Event stays `Unsent` and is not settled. That version answers a linked Burst at once, without the later message, which gets its own Turn: the Owner may get two answers, never none. Finished tool calls are in Turn progress, which it already reads, so no write is repeated. The Trace `restart` field and the `superseded` metric result are written only, and the earlier schema ignores the field. `test/restart-rollback.test.ts` decodes the stored Entry and the Trace with the earlier schema.
- **Records.** The Trace of a dropped answer has the field `restart` with the covered and new Event ids. The turn Operator metric has the result `superseded` for it, and every turn data point has the restart count of its Turn Event as the eighth double.
- **Defaults.** `burstMaxRestarts` 2, next to `burstQuietMillis` 2500 ms and `burstMaxWaitMillis` 10000 ms. They are first guesses.

## Why

A new kind of Journal Entry cannot be read by an older version, so a deploy rolled back while a restart was recorded would stop recovery for that Owner. A field on an Entry that every version knows is safe: the earlier version decodes it and ignores the field.

A person who writes again before an answer arrives expects one answer to everything. Dropping the stale answer, instead of sending it and answering the new message apart, avoids an outdated reply followed by a second one. Keeping finished tool calls means the Owner's data is not changed twice. The limits keep a steady stream of messages from delaying the answer without end.

## Revisit if

- Two weeks after this ships (2026-12-05): count the restarts in the Operator metrics. When more than one in five answered Bursts restarted, or restarts delay answers more than they help, lower `burstMaxRestarts` or `burstMaxWaitMillis`.
- The Quiet Gap is set to 5 seconds or more. Typing is shown again only when the next Turn starts, so the wait after a restart shows none.
- Restarts that use up `maxToolSteps` fail Turns in the Traces. Then give each restart its own step budget.
