# 0022: Reaction outcome

Status: accepted

Date: 2026-11-20

Spec #119 (Chat replies), ticket #124. Builds on [0021](0021-outcome-tools.md): `react` is a second outcome tool, decided by code after the tool loop. It supersedes none of 0021.

## Decision

- **The `react` outcome tool.** In an Owner message Turn from the Owner, the model can end the Turn with `react` and one emoji instead of a text. The emoji has no fixed meaning, and the model picks it freely. `react` is absent from proactive Turns, Scheduled Task Turns, and Turns for an untrusted Event, like `stay_silent`.
- **Guardrail.** Code refuses `react` when a call of a tool that is not marked read-only failed in the Turn, so a reaction always means that the thing really happened. A change to Owner data does not refuse a reaction. The refusal is the tool result, as in 0021.
- **The Channel keeps the allowed list.** The Channel has a `react` operation and an `allowedReaction` check. Telegram implements `react` with `setMessageReaction` on the newest Owner message of the Burst, and its check drops variation selectors and skin tones, keeps an emoji on the list of reactions that Telegram allows bots to use, and else gives a close match from a small mapping. When the check gives nothing, code uses the Behavior Config `defaultReaction` (👍). The accepted tool result names the emoji that was used, so the model sees the replacement.
- **Default reaction when the model ends without an outcome.** When a Turn changed Owner data, no changing tool call failed, and the model ends with no text and no outcome tool call (for example after its `stay_silent` was refused), code reacts with `defaultReaction`. Any other Turn that ends with no text keeps the earlier behavior.
- **A reaction is one Delivery.** The Journal records `ReactionPlanned` with the emoji, then `SendStarted`, then `ReplySent` or `ReplyFailed`, as for a text. `setMessageReaction` sets the reaction rather than adding one, so a reaction that was not confirmed is sent again once. The Channel reports a reaction as unconfirmed when Telegram cannot be reached or answers with a body it cannot read, and as failed when Telegram refuses it (`ok: false`). In the Turn, an unconfirmed reaction is sent once more; after a reset, recovery sends a reaction that started and was not confirmed (`ReactionUnconfirmed`) once more. A reaction that is still unconfirmed after that is recorded as failed. The newest plan wins: a `ReactionPlanned` before a later `ReplyPlanned` is ignored, and the other way round. An unconfirmed text is still never sent again.
- **Records.** The Trace records the outcome `{ kind: "reaction", emoji }`, with `requestedEmoji` when code replaced the emoji. The turn metric has the result `reacted` and the outcome kind `reaction`.

## Why

A reaction is the lightest answer that still tells the Owner that the agent got it and did it. The check against the allowed list stays in the Channel because the list belongs to Telegram; another Channel can keep its own. Sending an unconfirmed reaction again is safe only because setting a reaction is idempotent; a text send is not, so text keeps the rule of 0021 and earlier decisions.

## Revisit if

- Telegram changes the reactions that bots may use, or the Owner sees replacements often in the Trace. Update the list and the mapping.
- A deploy is rolled back while an Event is pending with a `ReactionPlanned` Entry. An older version cannot read that Entry, so recovery of that Event fails until the new version is back.
- Two weeks of daily use show that the default reaction or the guardrails need tuning, as 0019 and spec #119 plan for the Behavior Config defaults.
