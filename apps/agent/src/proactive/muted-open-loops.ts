import { Effect } from "effect";

import type { Notes } from "../notes/notes.ts";
import type { OwnerPreferences } from "../preferences/owner-preferences.ts";
import { isMuted } from "./proactive-mutes.ts";

export interface MutedOpenLoopServices {
  readonly preferences: OwnerPreferences["Service"];
  readonly notes: Notes["Service"];
}

export const openLoopsWithMutes = Effect.fnUntraced(
  function* openLoopsWithMutes(
    { preferences, notes }: MutedOpenLoopServices,
    noteIds: readonly string[]
  ) {
    const mutes = yield* preferences.proactiveMutes;
    const open = yield* notes.openLoopsAmong(noteIds);
    return {
      open,
      muted: open.filter((note) => isMuted(mutes, note)),
    };
  }
);

export const mutedAmong = Effect.fnUntraced(function* mutedAmong(
  services: MutedOpenLoopServices,
  noteIds: readonly string[]
) {
  const { muted } = yield* openLoopsWithMutes(services, noteIds);
  return muted.map(({ noteId }) => noteId);
});

export type MutedLookupFailed = Effect.Error<ReturnType<typeof mutedAmong>>;
