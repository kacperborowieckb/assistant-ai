import { Effect } from "effect";

import { Journal } from "../journal/journal.ts";
import { Notes } from "../notes/notes.ts";
import { OwnerPreferences } from "../preferences/owner-preferences.ts";
import { ProactiveMessages } from "../proactive/proactive-messages.ts";
import { Profile } from "../profile/profile.ts";
import { Schedules } from "../schedule/schedules.ts";
import { Redactor } from "../tracing/redactor.ts";
import { TurnProgress } from "./turn-progress.ts";

export const agentToolServices = Effect.gen(
  function* agentToolServicesEffect() {
    return {
      journal: yield* Journal,
      notes: yield* Notes,
      profile: yield* Profile,
      proactiveMessages: yield* ProactiveMessages,
      preferences: yield* OwnerPreferences,
      schedules: yield* Schedules,
      progress: yield* TurnProgress,
      redactor: yield* Redactor,
    };
  }
);
