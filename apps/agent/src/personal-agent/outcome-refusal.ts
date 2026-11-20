import type { ModelMessage } from "ai";
import { Effect } from "effect";

import { Journal } from "../journal/journal.ts";
import type { JournalRecord } from "../journal/journal.ts";
import type { AgentTools } from "../model-gateway/agent-tool.ts";
import type { ModelStep } from "../model-gateway/model-step.ts";
import { reactToolName, reactionAfterFailureMessage } from "./react-tool.ts";
import {
  silenceAfterChangeMessage,
  silenceAfterFailureMessage,
  staySilentToolName,
} from "./stay-silent-tool.ts";

export const unknownOutcomeToolMessage =
  "This tool is not available. Answer the Owner with a text.";

const ownerDataChanges: ReadonlySet<JournalRecord["_tag"]> = new Set([
  "NoteCaptured",
  "NoteUpdated",
  "OpenLoopOpened",
  "OpenLoopChanged",
  "OpenLoopClosed",
  "ProfileEntryAdded",
  "ProfileEntryRemoved",
  "ScheduleSet",
  "ScheduleChanged",
  "ScheduleCancelled",
  "BriefCreated",
  "OwnerPreferenceChanged",
  "ProactiveMuteChanged",
]);

interface OutcomeToolCall {
  readonly eventId: string;
  readonly name: string;
  readonly steps: readonly ModelStep[];
  readonly earlierMessages: readonly ModelMessage[];
  readonly tools: AgentTools;
}

const failedToolNamesOf = (messages: readonly ModelMessage[]) =>
  messages.flatMap((message) =>
    message.role === "tool"
      ? message.content.flatMap((part) =>
          part.type === "tool-result" &&
          (part.output.type === "error-text" ||
            part.output.type === "error-json")
            ? [part.toolName]
            : []
        )
      : []
  );

export const refusalOfOutcomeTool = Effect.fnUntraced(
  function* refusalOfOutcomeTool({
    eventId,
    name,
    steps,
    earlierMessages,
    tools,
  }: OutcomeToolCall) {
    if (
      !(name in tools) ||
      (name !== staySilentToolName && name !== reactToolName)
    ) {
      return unknownOutcomeToolMessage;
    }
    const failedNames = [
      ...steps
        .flatMap((step) => step.toolCalls)
        .filter((call) => call.failed)
        .map((call) => call.name),
      ...failedToolNamesOf(earlierMessages),
    ];
    const changeFailed = failedNames.some(
      (failedName) => tools[failedName]?.readsOnly !== true
    );
    if (changeFailed) {
      return name === reactToolName
        ? reactionAfterFailureMessage
        : silenceAfterFailureMessage;
    }
    if (name === reactToolName) {
      return;
    }
    const journal = yield* Journal;
    const entries = yield* journal.readForEvent(eventId);
    return entries.some((entry) => ownerDataChanges.has(entry.record._tag))
      ? silenceAfterChangeMessage
      : undefined;
  }
);

export const defaultReactionAllowed = Effect.fnUntraced(
  function* defaultReactionAllowed(call: Omit<OutcomeToolCall, "name">) {
    const silenceRefusal = yield* refusalOfOutcomeTool({
      ...call,
      name: staySilentToolName,
    });
    const reactionRefusal = yield* refusalOfOutcomeTool({
      ...call,
      name: reactToolName,
    });
    return (
      silenceRefusal === silenceAfterChangeMessage &&
      reactionRefusal === undefined
    );
  }
);
