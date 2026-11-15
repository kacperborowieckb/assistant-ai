import type { TurnProgress } from "../personal-agent/turn-progress.ts";
import type { Redactor } from "../tracing/redactor.ts";
import type { Notes } from "./notes.ts";

export interface NoteToolServices {
  readonly notes: Notes["Service"];
  readonly progress: TurnProgress["Service"];
  readonly redactor: Redactor["Service"];
}
