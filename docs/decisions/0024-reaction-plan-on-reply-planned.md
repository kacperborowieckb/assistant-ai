# 0024: The reaction plan rides on ReplyPlanned

Status: accepted

Date: 2026-11-20

Spec #119 (Chat replies), ticket #124. Builds on [0023](0023-reaction-outcome.md). It supersedes only one rule of 0023: the `ReactionPlanned` Journal Entry (see Plan Entry). All other parts of 0023 stay.

## Decision

- **Plan Entry.** A reaction plan is a `ReplyPlanned` Entry with an empty `text` and a `reaction` field that holds the emoji and its target (the conversation and the message). There is no `ReactionPlanned` Entry. A `ReplyPlanned` with a `reaction` is a reaction plan; one without it is a text plan.
- **Reading plans.** The newest `ReplyPlanned` decides the Delivery state, as 0023 says for the newest plan. The failure notice text comes from the newest text plan only.
- **Rollback.** A version without reactions reads a reaction plan as an empty text plan, because a schema ignores a field that it does not know. After a rollback it settles a sent reaction as done and an unconfirmed one as failed, and it never stops on an Entry that it cannot read.

## Why

A new kind of Journal Entry cannot be read by an older version, so a deploy rolled back while a reaction was unfinished would stop recovery for that Owner, and with it their replies and Scheduled Tasks, until the new version was back. A field on an Entry that every version knows keeps a rollback safe at the cost of an empty `text` on reaction plans.

## Revisit if

- A later outcome needs its own plan data. Add it as another optional field on `ReplyPlanned`, or accept a new Entry kind with a rollback plan.
