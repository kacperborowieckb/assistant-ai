import { Clock, Effect } from "effect";

import type { BehaviorConfig } from "../behavior/behavior-config.ts";
import type { Journal } from "../journal/journal.ts";
import type { OwnerId } from "../owner-id.ts";
import { ProactiveMessages } from "../proactive/proactive-messages.ts";
import { lateProactiveMessageText } from "../schedule/lateness.ts";
import type { RunPrompt } from "../schedule/schedule-action.ts";
import { Schedules } from "../schedule/schedules.ts";
import { ownerTimeZone } from "../time/owner-current-time.ts";
import { OperatorMetrics } from "../tracing/operator-metrics.ts";
import { agentToolServices } from "./agent-tool-services.ts";
import { deliveryStateOf, fail } from "./delivery.ts";
import { scheduledTaskInputMessage } from "./event-message.ts";
import { lateNoticeFor } from "./fired-schedule-lateness.ts";
import type { Inbox, ScheduleFiredEvent } from "./inbox.ts";
import { runModelTurn } from "./model-turn.ts";
import type { TurnPreparation } from "./model-turn.ts";
import { proactiveSection } from "./proactive-section.ts";
import { proactiveTools } from "./proactive-tools.ts";
import { tokensSpentToday } from "./scheduled-task-budget.ts";
import { proactiveTraceOf } from "./turn-record.ts";

export const openLoopsInReach = 20;

const proactivePreparation = Effect.fnUntraced(function* proactivePreparation(
  behavior: BehaviorConfig,
  event: ScheduleFiredEvent
) {
  const { notes } = yield* agentToolServices;
  const proactiveMessages = yield* ProactiveMessages;
  const lateNotice = yield* lateNoticeFor(behavior, event);
  const timeZone = yield* ownerTimeZone(behavior);
  const page = yield* notes.listOpenLoops({
    offset: 0,
    limit: openLoopsInReach,
  });
  const plannedIds = yield* proactiveMessages.plan(
    event.eventId,
    page.notes.map((note) => note.noteId)
  );
  return {
    situation: [
      proactiveSection(
        page.notes.filter((note) => plannedIds.includes(note.noteId)),
        timeZone
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

interface SentProactiveMessage {
  readonly ownerId: OwnerId;
  readonly event: ScheduleFiredEvent;
  readonly startedAt: number;
}

const finishSentProactiveMessage = Effect.fnUntraced(
  function* finishSentProactiveMessage({
    ownerId,
    event,
    startedAt,
  }: SentProactiveMessage) {
    const schedules = yield* Schedules;
    const proactiveMessages = yield* ProactiveMessages;
    const metrics = yield* OperatorMetrics;

    const state = yield* deliveryStateOf(event.eventId);
    if (state._tag === "Sent") {
      yield* proactiveMessages.recordSent(
        event.eventId,
        state.channelMessageId
      );
    }
    yield* schedules.complete(event.scheduleId, event.dueAt, event.eventId);
    yield* metrics.record({
      kind: "proactive_message",
      ownerId,
      eventId: event.eventId,
      result: "sent",
      latencyMillis: (yield* Clock.currentTimeMillis) - startedAt,
    });
  }
);

const endUnsentProactiveMessage = Effect.fnUntraced(
  function* endUnsentProactiveMessage(
    event: ScheduleFiredEvent,
    reason: string | undefined
  ) {
    const schedules = yield* Schedules;

    if (reason !== undefined) {
      yield* fail(event, reason);
    }
    yield* schedules.complete(event.scheduleId, event.dueAt, event.eventId);
  }
);

interface ProactiveRun {
  readonly ownerId: OwnerId;
  readonly behavior: BehaviorConfig;
  readonly event: ScheduleFiredEvent;
  readonly action: RunPrompt;
}

export const runProactiveMessage = Effect.fnUntraced(
  function* runProactiveMessage({
    ownerId,
    behavior,
    event,
    action,
  }: ProactiveRun) {
    const toolServices = yield* agentToolServices;
    const hookServices = yield* Effect.context<
      Inbox | Journal | OperatorMetrics | ProactiveMessages | Schedules
    >();
    const startedAt = yield* Clock.currentTimeMillis;
    const tokensSpentBefore = yield* tokensSpentToday("proactive", behavior);

    yield* runModelTurn({
      ownerId,
      behavior,
      kind: {
        task: "proactive",
        event,
        input: scheduledTaskInputMessage(action.prompt),
        tools: proactiveTools(event.eventId, { ...toolServices, behavior }),
        prepare: proactivePreparation(behavior, event),
        traceOf: (model) =>
          proactiveTraceOf({
            event,
            dailyTokenBudget: behavior.proactiveDailyTokenBudget,
            tokensSpentBefore,
            ...model,
          }),
        whenSent: finishSentProactiveMessage({
          ownerId,
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
