import { Effect } from "effect";

import { defaultBehaviorConfig } from "../src/behavior/behavior-config.ts";
import { UsageLedger } from "../src/model-gateway/usage-ledger.ts";
import type { UsageRecord } from "../src/model-gateway/usage-ledger.ts";
import type { NoteSource } from "../src/notes/note.ts";
import type { ListedNote } from "../src/notes/notes.ts";
import { Notes } from "../src/notes/notes.ts";
import { Inbox } from "../src/personal-agent/inbox.ts";
import { Profile } from "../src/profile/profile.ts";
import { TurnTraces } from "../src/tracing/turn-trace.ts";
import type { StoredTurnTrace } from "../src/tracing/turn-trace.ts";
import type {
  AgentObservation,
  ObservedNote,
  ObservedToolCall,
  ObservedUsage,
  SeedNote,
  SeedRequest,
  SeedResponse,
} from "./eval-contract.ts";

export const seedEventId = "eval-seed";

const seedNoteSource = (
  conversationId: string,
  note: SeedNote,
  position: number
): NoteSource => ({
  eventId: seedEventId,
  channel: "telegram",
  conversationId,
  channelMessageId: `${seedEventId}-${position}`,
  ...(note.forwardedFrom === undefined
    ? { trustLevel: "owner" }
    : {
        trustLevel: "untrusted",
        forwardOrigin: note.forwardedFrom,
        forwardedText: note.text,
      }),
});

export const seedOwnerState = Effect.fnUntraced(function* seedOwnerState(
  request: SeedRequest
) {
  const notes = yield* Notes;
  const profile = yield* Profile;
  yield* Effect.forEach(
    request.notes,
    (note, position) =>
      notes.capture({
        text: note.text,
        url: note.url,
        source: seedNoteSource(request.conversationId, note, position + 1),
      }),
    { discard: true }
  );
  yield* Effect.forEach(
    request.profile,
    (entry) =>
      profile.add({
        kind: entry.kind,
        text: entry.text,
        eventId: seedEventId,
        characterLimit: defaultBehaviorConfig.maxProfileCharacters,
      }),
    { discard: true }
  );
  return {
    seededNoteCount: request.notes.length,
    seededProfileEntryCount: request.profile.length,
  } satisfies SeedResponse;
});

const observedNote = (note: ListedNote): ObservedNote => ({
  noteId: note.noteId,
  text: note.text,
  trustLevel: note.trustLevel,
  linkedNoteIds: note.linkedNoteIds,
  ...(note.url === undefined ? {} : { url: note.url }),
  ...(note.source.forwardOrigin === undefined
    ? {}
    : { forwardOrigin: note.source.forwardOrigin }),
});

const observedToolCalls = (
  traces: readonly StoredTurnTrace[]
): ObservedToolCall[] =>
  traces.flatMap(({ trace }) =>
    trace.steps.flatMap((step) =>
      step.toolCalls.map((call) => ({
        eventId: trace.eventId,
        name: call.name,
        input: call.input,
        output: call.output,
        failed: call.failed,
      }))
    )
  );

const observedUsage = (record: UsageRecord): ObservedUsage => ({
  task: record.task,
  inputTokens: record.inputTokens,
  outputTokens: record.outputTokens,
  cachedInputTokens: record.cachedInputTokens,
  costUsd: record.costUsd,
});

export const observeOwnerState = Effect.gen(function* observeOwnerState() {
  const inbox = yield* Inbox;
  const notes = yield* Notes;
  const profile = yield* Profile;
  const traces = yield* TurnTraces;
  const usage = yield* UsageLedger;
  return {
    pendingEventCount: (yield* inbox.pending).length,
    notes: (yield* notes.list).map(observedNote),
    profile: (yield* profile.read).map(({ kind, text }) => ({ kind, text })),
    toolCalls: observedToolCalls(yield* traces.read),
    usage: (yield* usage.read).map(observedUsage),
  } satisfies AgentObservation;
});
