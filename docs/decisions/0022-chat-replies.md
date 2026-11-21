# 0022: Chat replies

Status: accepted

Date: 2026-11-20

Spec #119 (Chat replies), ticket #123. Builds on [0009](0009-agent-loop-and-client-boundaries.md) and [0021](0021-outcome-tools.md). Ticket #125 adds the restart when a message arrives mid-Turn (Option A) here. The three outcomes (reply, reaction, silence) and their guardrails are in [0021](0021-outcome-tools.md) and [0023](0023-reaction-outcome.md).

## Decision

- **One outcome for each Burst.** Several Owner messages sent close together get one answer. This replaces the earlier behavior, where every Owner message got exactly one reply in its own Turn (the Problem Statement of #119). The Turn takes every pending Owner message of the Burst as its input, in arrival order, and delivers one outcome in reply to the newest message.
- **Quiet Gap.** An Owner message does not start a Turn at once. The Personal Agent stores the Event (a duplicate webhook retry is still dropped), shows the typing signal, and sets its alarm to the Quiet Gap after the newest pending Owner message. A new Owner message moves the alarm. The Turn starts when the gap passes with no new message.
- **Maximum wait.** The Turn starts no later than `burstMaxWaitMillis` after the first message of the Burst, so a steady stream of messages cannot delay the answer without end.
- **One alarm.** The Personal Agent has one alarm. The Schedules store arms it at the earliest of the Schedule instants and the instant when the pending Burst is due. A Schedule that is due during the gap fires on time, while the Burst keeps waiting.
- **Readiness from storage.** Whether a Burst is due comes from the stored `receivedAt` of the pending Owner messages and the Behavior Config. Nothing lives only in memory, so a Durable Object reset during the gap gives one outcome for the Burst when the alarm runs.
- **Messages during a Turn.** A Turn that ends while a Burst it did not take is due (its messages arrived during the Turn, or were still in their Quiet Gap when the Turn started) queues the next Turn at once. Before the send, the restart below applies; once the send has started, or when no restart is allowed, the message gets its own Turn.
- **Backstop.** Once the Burst is due, the alarm is armed again one minute ahead until its Events leave the Inbox, so a Turn that stopped is tried again and the alarm never loops on it.
- **Later value wins.** The system prompt says that a later message that changes a value replaces the earlier value ("actually Thursday, not Friday").
- **Owner messages first.** Owner messages that are due still come before `ScheduleFired` Events in a Turn.
- **Typing while the Burst waits.** Each stored Owner message of a waiting Burst shows typing once, after the Personal Agent confirms the store, so a slow `sendChatAction` never delays the webhook answer. Telegram shows it for about 5 seconds, and the Quiet Gap is shorter, so typing stays on until the Turn starts and repeats it every `typingRepeatMillis`.
- **Restart (Option A).** After the model call and before Delivery, the Turn of an Owner message checks the Inbox for a pending Owner message that arrived after the newest message of its Burst and has no Turn of its own. When there is one, the Turn sends nothing, writes a `TurnSuperseded` Journal Entry (the Event ids that the next Turn covers and the new ones) and a Trace of the dropped answer with the same Event ids, and leaves the Events pending. The Journal Entry is written, in one transaction with the Trace, before any next Turn is planned. A new Turn starts after the Quiet Gap with every message of the Burst, including the new one, and the Owner gets one combined outcome. The check covers every outcome, so a dropped silence or failure notice restarts too.
- **Finished work stays done.** A tool call that finished before a restart is in Turn progress, keyed by the Turn Event, which the restarted Turn keeps (the Burst keeps its first Event). The restarted Turn gets those calls and results as completed steps, the mechanism that recovery after a reset uses, so a write tool is not called again for the same work. The dropped answer writes nothing to the Conversation, and the restarted Turn writes it once. The system prompt of a restarted Turn says that some messages arrived while the agent worked and that the finished steps are done.
- **Limits.** At most `burstMaxRestarts` (default 2) restarts for a Turn Event, counted from its `TurnSuperseded` Entries, and none once `burstMaxWaitMillis` has passed since the first message of the Burst. After that the Turn sends, and a later message gets its own Turn. A reply that was sent is not taken back: a message that arrives after the send, or while the send is in flight, gets its own Turn.
- **Restart and reset.** Everything that decides a restart is in storage: the pending Events, the `AnsweredByTurn` links, the `TurnSuperseded` count, and Turn progress. A linked Burst whose Delivery has not started now waits for its Quiet Gap like a new one (it used to be answered at once after a reset), so a message that arrived while the Durable Object was reset joins it and the Owner still gets one outcome. A reset after the send started follows the Delivery rules: an unconfirmed text is not sent again.
- **Records.** The Trace of a dropped answer has the field `restart` with the covered and new Event ids, and the turn Operator metric has the result `superseded` for it. The turn metric of a Turn has its restart count as the eighth double.
- **Defaults.** `burstQuietMillis` 2500 ms, `burstMaxWaitMillis` 10000 ms, and `burstMaxRestarts` 2. They are first guesses.

## Why

A person who texts often sends a thought in several short messages. One answer for each message floods the chat and can answer an outdated value. Waiting for a short quiet gap keeps the answer close to the last message, and the maximum wait keeps it bounded.

## Revisit if

- Two weeks after this ships (2026-12-04): review the Traces of that period. Change `burstQuietMillis` or `burstMaxWaitMillis` when more than one in ten Bursts was followed by another Owner message within 10 seconds of the outcome, or the Owner reports a slow answer.
- The Quiet Gap is set to 5 seconds or more. Then the waiting Burst needs its own typing repeat on the alarm. After a restart, typing is shown again only when the next Turn starts, so the same holds for the wait that follows a restart.
- Two weeks after this ships: count the restarts in the Operator metrics. When more than one in five answered Bursts restarted, or the restarts delay answers more than they help, lower `burstMaxRestarts` or `burstMaxWaitMillis`.
