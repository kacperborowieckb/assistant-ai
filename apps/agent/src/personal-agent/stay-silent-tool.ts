import { Effect, Schema } from "effect";

import { Journal } from "../journal/journal.ts";
import type { JournalRecord } from "../journal/journal.ts";
import { effectInputSchema, outcomeTool } from "../model-gateway/agent-tool.ts";
import type { AgentTools } from "../model-gateway/agent-tool.ts";
import type { ModelStep } from "../model-gateway/model-step.ts";

export const staySilentToolName = "stay_silent";

export const silenceAfterChangeMessage =
  "Silence refused: this Turn changed Owner data. Answer the Owner with a short text that says what you did.";

export const silenceAfterFailureMessage =
  "Silence refused: a tool call that changes Owner data failed in this Turn. Answer the Owner with a text that says what did not work.";

export const unknownOutcomeToolMessage =
  "This tool is not available. Answer the Owner with a text.";

export const silenceAcceptedOutput = { outcome: "silent" } as const;

export const staySilentTool = outcomeTool({
  description:
    'End the Turn without sending anything. Use it only for small talk that needs no answer, such as "ok", "thanks", or a thumbs up. Never use it when you changed something in this Turn, when something failed, or when the Owner asked a question or asked for something. Code refuses it in those cases, and then you answer with text.',
  inputSchema: effectInputSchema(Schema.Struct({})),
});

export const staySilentSection = `When a message of the Owner is only small talk that needs no answer, such as "ok", "thanks", "got it", or a thumbs up, call ${staySilentToolName} instead of writing a reply, and write nothing else. Do not reply just to reply. Never call ${staySilentToolName} when you changed or tried to change something in this Turn, when the Owner asked a question or asked for something, or when something failed: then answer with text.`;

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
  readonly tools: AgentTools;
}

/**
 * Decides a call of an outcome tool. Returns undefined when the outcome is
 * accepted, or the refusal that the model gets as the tool result.
 *
 * The Journal is the record of what changed in the Turn, also across a reset.
 * A failed call of a tool that may change Owner data refuses silence too.
 */
export const refusalOfOutcomeTool = Effect.fnUntraced(
  function* refusalOfOutcomeTool({
    eventId,
    name,
    steps,
    tools,
  }: OutcomeToolCall) {
    if (name !== staySilentToolName) {
      return unknownOutcomeToolMessage;
    }
    const changeFailed = steps
      .flatMap((step) => step.toolCalls)
      .some((call) => call.failed && tools[call.name]?.readsOnly !== true);
    if (changeFailed) {
      return silenceAfterFailureMessage;
    }
    const journal = yield* Journal;
    const entries = yield* journal.readForEvent(eventId);
    return entries.some((entry) => ownerDataChanges.has(entry.record._tag))
      ? silenceAfterChangeMessage
      : undefined;
  }
);
