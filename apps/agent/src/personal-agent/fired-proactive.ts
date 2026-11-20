import { Clock, Effect, Option } from "effect";

import type { BehaviorConfig } from "../behavior/behavior-config.ts";
import type { Journal } from "../journal/journal.ts";
import type { OwnerId } from "../owner-id.ts";
import { ProactiveMessages } from "../proactive/proactive-messages.ts";
import { lateProactiveMessageText } from "../schedule/lateness.ts";
import type { RunPrompt } from "../schedule/schedule-action.ts";
import type { Schedule } from "../schedule/schedule.ts";
import { Schedules } from "../schedule/schedules.ts";
import { ownerTimeZone } from "../time/owner-current-time.ts";
import { OperatorMetrics } from "../tracing/operator-metrics.ts";
import { agentToolServices } from "./agent-tool-services.ts";
import { deliveryStateOf, fail } from "./delivery.ts";
import { scheduledTaskInputMessage } from "./event-message.ts";
import { completeMergedSchedules, mergedSchedulesFor } from "./fired-merge.ts";
import type { MergedSchedule } from "./fired-merge.ts";
import { lateNoticeFor } from "./fired-schedule-lateness.ts";
import type { Inbox, ScheduleFiredEvent } from "./inbox.ts";
import { runModelTurn } from "./model-turn.ts";
import type { TurnPreparation } from "./model-turn.ts";
import { proactiveReach } from "./proactive-reach.ts";
import { proactiveSection } from "./proactive-section.ts";
import { proactiveTools } from "./proactive-tools.ts";
import { tokensSpentToday } from "./scheduled-task-budget.ts";
import { proactiveTraceOf } from "./turn-record.ts";

const uniqueNotes = <Item extends { readonly noteId: string }>(
  items: readonly Item[]
) => [...new Map(items.map((item) => [item.noteId, item])).values()];

const proactivePreparation = Effect.fnUntraced(function* proactivePreparation(
  behavior: BehaviorConfig,
  event: ScheduleFiredEvent,
  merged: readonly MergedSchedule[]
) {
  const { notes, preferences, journal } = yield* agentToolServices;
  const proactiveMessages = yield* ProactiveMessages;
  const lateNotice = yield* lateNoticeFor(behavior, event);
  const timeZone = yield* ownerTimeZone(behavior);
  const schedules = yield* Schedules;
  const schedule = yield* schedules.byId(event.scheduleId);
  const linkedIds = Option.isSome(schedule) ? schedule.value.openLoopIds : [];
  const services = {
    notes,
    preferences,
    journal,
    proactiveMessages,
    eventId: event.eventId,
  };
  const lead = yield* proactiveReach(services, linkedIds);
  const joined = yield* Effect.all(
    merged.map(({ schedule: other }) =>
      proactiveReach(services, other.openLoopIds)
    )
  );
  const inReach = uniqueNotes(
    [lead, ...joined].flatMap((part) => part.inReach)
  );
  const mutedIds =
    linkedIds.length > 0
      ? [...new Set([lead, ...joined].flatMap((part) => part.mutedIds))]
      : lead.mutedIds;
  const plannedIds = yield* proactiveMessages.plan(
    event.eventId,
    inReach.map((note) => note.noteId)
  );
  const recentOutcomes = yield* proactiveMessages.recentOutcomesOf(plannedIds);
  return {
    situation: [
      proactiveSection(
        inReach.filter((note) => plannedIds.includes(note.noteId)),
        timeZone,
        { recentOutcomes, mutedOpenLoopIds: mutedIds }
      ),
    ],
    lateText: (text: string) =>
      lateNotice._tag === "None"
        ? text
        : lateProactiveMessageText(
            text,
            lateNotice.value.dueAt,
            lateNotice.value.timeZone
          ),
  } satisfies TurnPreparation;
});

const mergedPromptOf = (
  leadPrompt: string,
  merged: readonly MergedSchedule[]
) =>
  merged.length === 0
    ? leadPrompt
    : [
        "These prompts are due together. Write one message that covers all of them.",
        ...[
          leadPrompt,
          ...merged.map(({ schedule }) => promptOf(schedule)),
        ].map((prompt) => `- ${prompt}`),
      ].join("\n");

const promptOf = ({ action }: Schedule) =>
  action._tag === "RunPrompt" ? action.prompt : "";

interface SentProactiveMessage {
  readonly ownerId: OwnerId;
  readonly behavior: BehaviorConfig;
  readonly event: ScheduleFiredEvent;
  readonly startedAt: number;
}

export const recordProactiveMessageSent = Effect.fnUntraced(
  function* recordProactiveMessageSent(
    ownerId: OwnerId,
    eventId: string,
    latencyMillis: number
  ) {
    const metrics = yield* OperatorMetrics;
    yield* metrics.record({
      kind: "proactive_message",
      ownerId,
      eventId,
      result: "sent",
      latencyMillis,
    });
  }
);

const finishSentProactiveMessage = Effect.fnUntraced(
  function* finishSentProactiveMessage({
    ownerId,
    behavior,
    event,
    startedAt,
  }: SentProactiveMessage) {
    const schedules = yield* Schedules;
    const proactiveMessages = yield* ProactiveMessages;

    const state = yield* deliveryStateOf(event.eventId);
    if (state._tag === "Sent") {
      yield* proactiveMessages.recordSent(
        event.eventId,
        state.channelMessageId,
        behavior.proactiveResponseWindowMillis
      );
    }
    yield* completeMergedSchedules(event.eventId);
    yield* schedules.complete(event.scheduleId, event.dueAt, event.eventId);
    yield* recordProactiveMessageSent(
      ownerId,
      event.eventId,
      (yield* Clock.currentTimeMillis) - startedAt
    );
  }
);

const endUnsentProactiveMessage = Effect.fnUntraced(
  function* endUnsentProactiveMessage(
    event: ScheduleFiredEvent,
    reason: string | undefined
  ) {
    const schedules = yield* Schedules;

    yield* completeMergedSchedules(event.eventId);
    yield* schedules.complete(event.scheduleId, event.dueAt, event.eventId);
    if (reason !== undefined) {
      yield* fail(event, reason);
    }
  }
);

interface ProactiveRun {
  readonly ownerId: OwnerId;
  readonly behavior: BehaviorConfig;
  readonly event: ScheduleFiredEvent;
  readonly action: RunPrompt;
  readonly schedule: Schedule;
}

export const runProactiveMessage = Effect.fnUntraced(
  function* runProactiveMessage({
    ownerId,
    behavior,
    event,
    action,
    schedule,
  }: ProactiveRun) {
    const toolServices = yield* agentToolServices;
    const hookServices = yield* Effect.context<
      Inbox | Journal | OperatorMetrics | ProactiveMessages | Schedules
    >();
    const startedAt = yield* Clock.currentTimeMillis;
    const merged = yield* mergedSchedulesFor(behavior, event, schedule);
    const tokensSpentBefore = yield* tokensSpentToday("proactive", behavior);

    yield* runModelTurn({
      ownerId,
      behavior,
      kind: {
        task: "proactive",
        event,
        input: scheduledTaskInputMessage(mergedPromptOf(action.prompt, merged)),
        tools: proactiveTools(event.eventId, { ...toolServices, behavior }),
        prepare: proactivePreparation(behavior, event, merged),
        tracesSendFailure: true,
        traceOf: (model) =>
          proactiveTraceOf({
            event,
            dailyTokenBudget: behavior.proactiveDailyTokenBudget,
            tokensSpentBefore,
            ...model,
          }),
        whenSent: finishSentProactiveMessage({
          ownerId,
          behavior,
          event,
          startedAt,
        }).pipe(Effect.provideContext(hookServices)),
        whenFailed: (reason) =>
          endUnsentProactiveMessage(event, reason).pipe(
            Effect.provideContext(hookServices)
          ),
        whenSendFailed: endUnsentProactiveMessage(event, undefined).pipe(
          Effect.provideContext(hookServices)
        ),
      },
    });
  }
);
