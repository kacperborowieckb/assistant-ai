import type { DateTime, Effect, Option } from "effect";

import type { TurnProgress } from "../personal-agent/turn-progress.ts";
import type { Redactor } from "../tracing/redactor.ts";
import type { ScheduleAlarm } from "./schedule-alarm.ts";
import type { Schedules } from "./schedules.ts";

export interface ReminderToolServices {
  readonly schedules: Schedules["Service"];
  readonly alarm: ScheduleAlarm["Service"];
  readonly ownerTimeZone: Effect.Effect<Option.Option<DateTime.TimeZone.Named>>;
  readonly progress: TurnProgress["Service"];
  readonly redactor: Redactor["Service"];
}
