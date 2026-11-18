import { Effect } from "effect";

import { Notes } from "../notes/notes.ts";
import { OwnerPreferences } from "../preferences/owner-preferences.ts";
import { Profile } from "../profile/profile.ts";
import { Schedules } from "../schedule/schedules.ts";
import { Redactor } from "../tracing/redactor.ts";
import { TurnProgress } from "./turn-progress.ts";

export const agentToolServices = Effect.gen(
  function* agentToolServicesEffect() {
    return {
      notes: yield* Notes,
      profile: yield* Profile,
      preferences: yield* OwnerPreferences,
      schedules: yield* Schedules,
      progress: yield* TurnProgress,
      redactor: yield* Redactor,
    };
  }
);
