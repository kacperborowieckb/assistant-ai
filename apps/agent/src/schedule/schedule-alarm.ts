import { Context, Effect, Layer } from "effect";
import type { DateTime, Option } from "effect";

import { Schedules } from "./schedules.ts";

export interface AlarmClock {
  readonly setAt: (dueAt: Option.Option<DateTime.Utc>) => Promise<void>;
}

const makeScheduleAlarm = (clock: AlarmClock) =>
  Effect.gen(function* makeScheduleAlarmEffect() {
    const schedules = yield* Schedules;

    const rearm = schedules.earliestUnfiredDueAt.pipe(
      Effect.flatMap((dueAt) => Effect.promise(() => clock.setAt(dueAt)))
    );

    return { rearm };
  });

export class ScheduleAlarm extends Context.Service<
  ScheduleAlarm,
  Effect.Success<ReturnType<typeof makeScheduleAlarm>>
>()("ScheduleAlarm") {
  static readonly layer = (clock: AlarmClock) =>
    Layer.effect(ScheduleAlarm, makeScheduleAlarm(clock));
}
