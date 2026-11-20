# 0020: Follow-ups set by the agent

Status: accepted

Date: 2026-11-20

Spec #97 (Proactivity), ticket #103. Builds on [0019](0019-proactivity.md), which says that `set_schedule` with Open Loop ids, when the Owner did not ask for a Schedule in the Turn, gets `setBy: agent` from code. It supersedes none of it.

## Decision

- **Link table.** `schedule_open_loops` links a Schedule to the Notes (Open Loops) that it is about. The single `noteId` of a Schedule stays. `list_schedules` shows `setBy` and `openLoopIds`.
- **Who set it.** Code decides `setBy`, never the model. `set_schedule` has an optional input `ownerAskedForSchedule`, which the model sets to true only when the Owner asked for the Schedule in the message. In an owner message Turn, a call with Open Loop ids and without that flag is a follow-up: code stores `setBy: agent`, and it must have the `RunPrompt` Action. A call with no Open Loop ids, or with the flag, stores `setBy: owner`, with the Open Loop links when given. A proactive Turn never has an Owner request, so every call there is a follow-up. The model can set the flag wrongly, but the cost is limited to a Schedule that counts against the Owner limit and not the agent limit.
- **Deviation from the ticket wording.** In a proactive Turn, a call with no Open Loop ids or with a `SendText` Action fails with a message for the model. The ticket says that a call with no Open Loop ids stores `setBy: owner`. In a proactive Turn that would let the agent make a Schedule that skips the agent limit and the later gate, so code refuses it.
- **Active limit.** `maxActiveAgentSchedules` (default 20) counts active Schedules with `setBy: agent`, including the Brief. It is checked after the exactly-once lookup, so a repeated call after a reset stores one Schedule and is not refused. `maxActiveScheduledTasks` still counts only Schedules that the Owner set.
- **Exactly once.** The request key of a Schedule includes the sorted Open Loop ids when there are any, so a repeated call with the same Open Loops in the same Event stores one Schedule.
- **Tools.** A proactive Turn has `set_schedule` for its own next follow-up. A Turn for an untrusted Event still has no Schedule tool.
- **Prompt.** The system prompt and the tool description say when to set a follow-up: before the due time of an Open Loop, or once when it had no change for about a day. No code sweep looks for stopped Open Loops.

## Why

Code cannot read the intent of the Owner. In an owner message Turn the model states it with a flag, and code owns the result. In a proactive Turn the Owner is not present, so code needs no signal.

## Revisit if

- Evals or Outcomes show that the model sets `ownerAskedForSchedule` wrongly. Then code needs a stronger signal.
- Real Outcomes show that 20 active agent Schedules is wrong.
