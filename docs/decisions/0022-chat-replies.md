# 0022: Chat replies

Status: accepted

Date: 2026-11-20

Spec #119 (Chat replies), ticket #123. Builds on [0009](0009-agent-loop-and-client-boundaries.md) and [0021](0021-outcome-tools.md). Later tickets of #119 add their rules here: the restart when a message arrives mid-Turn (Option A), and the three outcomes (reply, reaction, silence) with their guardrails.

## Decision

- **One outcome for each Burst.** Several Owner messages sent close together get one answer. This replaces the earlier behavior, where every Owner message got exactly one reply in its own Turn (the Problem Statement of #119). The Turn takes every pending Owner message of the Burst as its input, in arrival order, and delivers one outcome in reply to the newest message.
- **Quiet Gap.** An Owner message does not start a Turn at once. The Personal Agent stores the Event (a duplicate webhook retry is still dropped), shows the typing signal, and sets its alarm to the Quiet Gap after the newest pending Owner message. A new Owner message moves the alarm. The Turn starts when the gap passes with no new message.
- **Maximum wait.** The Turn starts no later than `burstMaxWaitMillis` after the first message of the Burst, so a steady stream of messages cannot delay the answer without end.
- **One alarm.** The Personal Agent has one alarm. The Schedules store arms it at the earliest of the Schedule instants and the instant when the pending Burst is due. A Schedule that is due during the gap fires on time, while the Burst keeps waiting.
- **Readiness from storage.** Whether a Burst is due comes from the stored `receivedAt` of the pending Owner messages and the Behavior Config. Nothing lives only in memory, so a Durable Object reset during the gap gives one outcome for the Burst when the alarm runs.
- **Messages during a Turn.** A Turn that ends while a Burst it did not take is due (its messages arrived during the Turn, or were still in their Quiet Gap when the Turn started) queues the next Turn at once. Option A (a later ticket) changes the case where they arrive before the send.
- **Backstop.** Once the Burst is due, the alarm is armed again one minute ahead until its Events leave the Inbox, so a Turn that stopped is tried again and the alarm never loops on it.
- **Later value wins.** The system prompt says that a later message that changes a value replaces the earlier value ("actually Thursday, not Friday").
- **Owner messages first.** Owner messages that are due still come before `ScheduleFired` Events in a Turn.
- **Typing while the Burst waits.** Each stored Owner message of a waiting Burst shows typing once, after the Personal Agent confirms the store, so a slow `sendChatAction` never delays the webhook answer. Telegram shows it for about 5 seconds, and the Quiet Gap is shorter, so typing stays on until the Turn starts and repeats it every `typingRepeatMillis`.
- **Defaults.** `burstQuietMillis` 2500 ms and `burstMaxWaitMillis` 10000 ms. They are first guesses.

## Why

A person who texts often sends a thought in several short messages. One answer for each message floods the chat and can answer an outdated value. Waiting for a short quiet gap keeps the answer close to the last message, and the maximum wait keeps it bounded.

## Revisit if

- Two weeks after this ships (2026-12-04): review the Traces of that period. Change `burstQuietMillis` or `burstMaxWaitMillis` when more than one in ten Bursts was followed by another Owner message within 10 seconds of the outcome, or the Owner reports a slow answer.
- The Quiet Gap is set to 5 seconds or more. Then the waiting Burst needs its own typing repeat on the alarm.
