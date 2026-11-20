import { Effect } from "effect";

import type { Journal } from "../journal/journal.ts";
import type { Note, Notes } from "../notes/notes.ts";
import type { OwnerPreferences } from "../preferences/owner-preferences.ts";
import { openLoopsWithMutes } from "../proactive/muted-open-loops.ts";
import type { ProactiveMessages } from "../proactive/proactive-messages.ts";

export const openLoopsInReach = 20;

interface ReachServices {
  readonly notes: Notes["Service"];
  readonly preferences: OwnerPreferences["Service"];
  readonly journal: Journal["Service"];
  readonly proactiveMessages: ProactiveMessages["Service"];
  readonly eventId: string;
}

const foldedOpenLoops = Effect.fnUntraced(function* foldedOpenLoops({
  notes,
  journal,
  proactiveMessages,
  eventId,
}: ReachServices) {
  const entries = yield* journal.readOfKind("ProactiveMessageFolded");
  const planned = yield* proactiveMessages.plannedOpenLoops(eventId);
  const notYetInAMessage = entries.flatMap(({ record, recordedAt }) =>
    record._tag === "ProactiveMessageFolded"
      ? record.openLoopIds.filter(
          (noteId) =>
            !planned.some(
              (message) =>
                message.plannedAt > recordedAt &&
                message.openLoopIds.includes(noteId)
            )
        )
      : []
  );
  return yield* notes.openLoopsAmong([...new Set(notYetInAMessage)]);
});

const briefOpenLoops = Effect.fnUntraced(function* briefOpenLoops(
  services: ReachServices
) {
  const folded = yield* foldedOpenLoops(services);
  const page = yield* services.notes.listOpenLoops({
    offset: 0,
    limit: openLoopsInReach,
  });
  const foldedIds = new Set(folded.map(({ noteId }) => noteId));
  const rest = page.notes.filter(({ noteId }) => !foldedIds.has(noteId));
  return [...folded, ...rest].slice(0, openLoopsInReach);
});

const followUpOpenLoops = Effect.fnUntraced(function* followUpOpenLoops(
  services: ReachServices,
  linkedIds: readonly string[]
) {
  const { open, muted } = yield* openLoopsWithMutes(services, linkedIds);
  return {
    inReach: open.filter((note) => !muted.includes(note)),
    mutedIds: muted.map(({ noteId }) => noteId),
  };
});

export const proactiveReach = Effect.fnUntraced(function* proactiveReach(
  services: ReachServices,
  linkedIds: readonly string[]
) {
  if (linkedIds.length > 0) {
    return yield* followUpOpenLoops(services, linkedIds);
  }
  return {
    inReach: (yield* briefOpenLoops(services)) satisfies readonly Note[],
    mutedIds: [] as readonly string[],
  };
});
