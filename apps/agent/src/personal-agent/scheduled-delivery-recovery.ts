import { Effect } from "effect";

import { Schedules } from "../schedule/schedules.ts";
import { deliveryStateOf } from "./delivery.ts";
import type { DeliveryState } from "./delivery.ts";
import type { ScheduleFiredEvent } from "./inbox.ts";

const completesScheduleOfReminder = (state: DeliveryState) =>
  state._tag === "SendFailed" ||
  state._tag === "Unconfirmed" ||
  state._tag === "FailedNoticePending" ||
  state._tag === "SendFailureRecorded" ||
  state._tag === "FailedNoticeRefused" ||
  state._tag === "FailedNoticeUnconfirmed";

const completesScheduleOfScheduledTask = (state: DeliveryState) =>
  state._tag === "FailedNoticePending";

export const completeScheduleOfFailedDelivery = Effect.fnUntraced(
  function* completeScheduleOfFailedDelivery(event: ScheduleFiredEvent) {
    const schedules = yield* Schedules;
    const state = yield* deliveryStateOf(event.eventId);
    const schedule = yield* schedules.byId(event.scheduleId);
    if (schedule._tag === "None") {
      return;
    }
    const completes =
      schedule.value.action._tag === "SendText"
        ? completesScheduleOfReminder(state)
        : completesScheduleOfScheduledTask(state);
    if (completes) {
      yield* schedules.complete(event.scheduleId, event.dueAt, event.eventId);
    }
  }
);
