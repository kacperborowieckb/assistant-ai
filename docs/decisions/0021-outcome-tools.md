# 0021: Outcome tools

Status: accepted

Date: 2026-11-20

Spec #119 (Chat replies), ticket #122. Builds on [0009](0009-agent-loop-and-client-boundaries.md), whose tool loop still runs inside the Model Gateway with the AI SDK loop. It supersedes none of it.

## Decision

- **Outcome tool.** An outcome tool is a tool that the model calls to end the Turn with an outcome other than a text reply. It has no `execute` function, so the AI SDK loop stops at its call. The Model Gateway returns the pending call as `endedWith` of the reply and adds no result for it. The first outcome tool is `stay_silent`. The reaction ticket (#121) adds `react` the same way.
- **Code decides the call.** After the loop, the Model Turn decides the pending call (`outcome-tools`). For `stay_silent` it refuses when the Journal of the Event has an Entry that changed Owner data, or when a call of a tool that is not marked read-only failed in the Turn. A refusal becomes the tool result of the call, and the Model Turn calls the Model Gateway again with the earlier steps and the refusal, within the step limit that is left. An accepted call gets a fixed result too, so the stored Conversation has no tool call without a result.
- **One step budget.** All Model Gateway calls of a Turn share the step limit of the Turn. When refusals use it up, the Turn fails with `StepLimitReached` and the honest failure text.
- **Read-only tools.** A tool marks itself `readsOnly` when it never changes Owner data (`search_notes`, `list_linked_notes`, `list_open_loops`, `list_schedules`, and every outcome tool). A failed call of any other tool counts as a failed change.

## Why

A tool with an `execute` function cannot see the other calls of its own step, which the AI SDK runs at the same time, so it cannot decide the guardrail correctly by itself. With no `execute`, the loop stops after every call of the step has finished, and code decides with the whole Turn in view. The Journal is the record of a change that survives a reset, so a Turn that runs again after a reset still refuses silence after a change.

## Revisit if

- The AI SDK gets a hook that decides a tool call after the other calls of its step and continues the loop. The decision can then move into the Model Gateway loop.
- A failed change before a reset must also refuse silence. Failed calls are not stored in Turn progress today.
