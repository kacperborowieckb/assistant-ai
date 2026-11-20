import { Effect, Option } from "effect";
import type { Layer } from "effect";

import type { OwnerId } from "../owner-id.ts";
import { ProactiveMessages } from "../proactive/proactive-messages.ts";
import type { RecordedOutcome } from "../proactive/proactive-outcomes.ts";
import { OperatorMetrics } from "../tracing/operator-metrics.ts";

export const recordOutcomeMetric = Effect.fnUntraced(
  function* recordOutcomeMetric(ownerId: OwnerId, recorded: RecordedOutcome) {
    const metrics = yield* OperatorMetrics;
    yield* metrics.record({
      kind: "outcome",
      ownerId,
      eventId: recorded.eventId,
      result: recorded.outcome,
      latencyMillis: recorded.responseMillis,
    });
  }
);

export const recordOutcomeOfConnectedTurn = Effect.fnUntraced(
  function* recordOutcomeOfConnectedTurn(
    ownerId: OwnerId,
    ownerMessageEventId: string
  ) {
    const proactiveMessages = yield* ProactiveMessages;
    const recorded =
      yield* proactiveMessages.recordOutcomeOfConnectedTurn(
        ownerMessageEventId
      );
    if (Option.isSome(recorded)) {
      yield* recordOutcomeMetric(ownerId, recorded.value);
    }
  }
);

export const recordOutcomesOfFinishedTurns = Effect.fnUntraced(
  function* recordOutcomesOfFinishedTurns(ownerId: OwnerId) {
    const proactiveMessages = yield* ProactiveMessages;
    const settled = yield* proactiveMessages.settleFinishedTurns();
    yield* Effect.forEach(
      settled,
      (recorded) => recordOutcomeMetric(ownerId, recorded),
      { discard: true }
    );
  }
);

export const recordOutcomesDueAtAlarm = <Services>(
  ownerId: OwnerId,
  metricsServices: Layer.Layer<OperatorMetrics, unknown, Services>
) =>
  Effect.gen(function* recordOutcomesDueAtAlarmEffect() {
    const proactiveMessages = yield* ProactiveMessages;
    const settled = yield* proactiveMessages.settleFinishedTurns();
    const ignored = yield* proactiveMessages.ignoreExpired();
    yield* Effect.forEach(
      [...settled, ...ignored],
      (recorded) => recordOutcomeMetric(ownerId, recorded),
      { discard: true }
    ).pipe(
      Effect.provide(metricsServices),
      Effect.catchCause((cause) =>
        Effect.logWarning(
          "The Operator metric of an Outcome was not written",
          cause
        )
      )
    );
  });
