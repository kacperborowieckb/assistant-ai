import type { DateTime, Effect, Option } from "effect";

import type { NoteToolServices } from "./note-tool-services.ts";

export interface OpenLoopToolServices extends NoteToolServices {
  readonly ownerTimeZone: Effect.Effect<Option.Option<DateTime.TimeZone.Named>>;
}
