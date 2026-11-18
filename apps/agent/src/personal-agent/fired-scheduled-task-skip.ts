import type { ModelMessage } from "ai";
import { Clock, Effect } from "effect";

import type { BehaviorConfig } from "../behavior/behavior-config.ts";
import { Journal } from "../journal/journal.ts";
import type { OwnerId } from "../owner-id.ts";
import type { RunPrompt } from "../schedule/schedule-action.ts";
import { Schedules } from "../schedule/schedules.ts";
import { Redactor } from "../tracing/redactor.ts";
import { Conversation } from "./conversation.ts";
import { fail, recordOutcome, send } from "./delivery.ts";
import { scheduledTaskInputMessage } from "./event-message.ts";
import { nameOfPrompt } from "./fired-scheduled-task-name.ts";
import { Inbox } from "./inbox.ts";
import type { ScheduleFiredEvent } from "./inbox.ts";
import { scheduledTaskTokensSpentToday } from "./scheduled-task-budget.ts";

const scheduledTaskSkipText = (redactedPrompt: string) =>
  `Your Scheduled Task "${nameOfPrompt(redactedPrompt)}" was skipped because of the daily limit for Scheduled Tasks.`;

interface SkipNotice {
  readonly input: ModelMessage;
  readonly text: string;
}

const skipNoticeOf = Effect.fnUntraced(function* skipNoticeOf(prompt: string) {
  const redactor = yield* Redactor;
  return {
    input: redactor.redactMessage(scheduledTaskInputMessage(prompt)),
    text: scheduledTaskSkipText(redactor.redact(prompt)),
  } satisfies SkipNotice;
});

const finishSkippedScheduledTask = Effect.fnUntraced(
  function* finishSkippedScheduledTask(
    event: ScheduleFiredEvent,
    { input, text }: SkipNotice
  ) {
    const inbox = yield* Inbox;
    const schedules = yield* Schedules;
    const conversation = yield* Conversation;

    yield* schedules.complete(event.scheduleId, event.dueAt, event.eventId);
    const delivery = yield* send(event, text);
    if (delivery._tag === "Failed") {
      yield* fail(event, delivery.reason);
      return;
    }
    yield* conversation.append(event.eventId, [
      input,
      { role: "assistant", content: text },
    ]);
    yield* inbox.markDone([event]);
  }
);

interface SkipRecord {
  readonly ownerId: OwnerId;
  readonly event: ScheduleFiredEvent;
  readonly text: string;
  readonly dailyTokenBudget: number;
  readonly tokensSpent: number;
  readonly latencyMillis: number;
}

const recordSkip = Effect.fnUntraced(function* recordSkip({
  ownerId,
  event,
  text,
  dailyTokenBudget,
  tokensSpent,
  latencyMillis,
}: SkipRecord) {
  yield* recordOutcome({
    trace: {
      eventId: event.eventId,
      task: "scheduled_task_skip",
      result: "scheduled_task_skipped",
      scheduleId: event.scheduleId,
      dueAt: event.dueAt,
      dailyTokenBudget,
      tokensSpent,
      text,
    },
    metric: {
      kind: "scheduled_task_skipped",
      ownerId,
      eventId: event.eventId,
      result: "daily_token_budget_spent",
      latencyMillis,
    },
  });
});

interface ScheduledTaskSkip {
  readonly ownerId: OwnerId;
  readonly event: ScheduleFiredEvent;
  readonly action: RunPrompt;
  readonly dailyTokenBudget: number;
  readonly tokensSpent: number;
  readonly startedAt: number;
}

const skipScheduledTask = Effect.fnUntraced(function* skipScheduledTask({
  ownerId,
  event,
  action,
  dailyTokenBudget,
  tokensSpent,
  startedAt,
}: ScheduledTaskSkip) {
  const journal = yield* Journal;

  const notice = yield* skipNoticeOf(action.prompt);
  yield* journal.append({
    _tag: "ScheduledTaskSkipped",
    eventId: event.eventId,
    scheduleId: event.scheduleId,
    dueAt: event.dueAt,
    dailyTokenBudget,
    tokensSpent,
  });
  yield* recordSkip({
    ownerId,
    event,
    text: notice.text,
    dailyTokenBudget,
    tokensSpent,
    latencyMillis: (yield* Clock.currentTimeMillis) - startedAt,
  });
  yield* finishSkippedScheduledTask(event, notice);
});

interface BudgetCheck {
  readonly ownerId: OwnerId;
  readonly behavior: BehaviorConfig;
  readonly event: ScheduleFiredEvent;
  readonly action: RunPrompt;
  readonly startedAt: number;
}

export const skipOverBudget = Effect.fnUntraced(function* skipOverBudget({
  ownerId,
  behavior,
  event,
  action,
  startedAt,
}: BudgetCheck) {
  const tokensSpent = yield* scheduledTaskTokensSpentToday(behavior);
  if (tokensSpent < behavior.scheduledTaskDailyTokenBudget) {
    return "Proceed" as const;
  }
  yield* skipScheduledTask({
    ownerId,
    event,
    action,
    dailyTokenBudget: behavior.scheduledTaskDailyTokenBudget,
    tokensSpent,
    startedAt,
  });
  return "Stopped" as const;
});

interface SkippedRun {
  readonly ownerId: OwnerId;
  readonly event: ScheduleFiredEvent;
  readonly action: RunPrompt;
}

export const resumeSkippedScheduledTask = Effect.fnUntraced(
  function* resumeSkippedScheduledTask(
    { ownerId, event, action }: SkippedRun,
    skipped: Pick<ScheduledTaskSkip, "dailyTokenBudget" | "tokensSpent">
  ) {
    const notice = yield* skipNoticeOf(action.prompt);
    yield* recordSkip({
      ownerId,
      event,
      text: notice.text,
      latencyMillis: 0,
      ...skipped,
    });
    yield* finishSkippedScheduledTask(event, notice);
  }
);
