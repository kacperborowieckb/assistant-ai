import type { TurnProgress } from "../personal-agent/turn-progress.ts";
import type { Redactor } from "../tracing/redactor.ts";
import type { Profile } from "./profile.ts";

export interface ProfileToolServices {
  readonly profile: Profile["Service"];
  readonly progress: TurnProgress["Service"];
  readonly redactor: Redactor["Service"];
  readonly characterLimit: number;
}
