import { Agent, getAgentByName } from "agents";
import { DateTime, Effect, Layer, ManagedRuntime, Option } from "effect";

import { defaultBehaviorConfig } from "../behavior/behavior-config.ts";
import type { Channel } from "../channels/channel.ts";
import type { Event } from "../event.ts";
import { Journal } from "../journal/journal.ts";
import { noTools } from "../model-gateway/agent-tool.ts";
import type { AgentTools } from "../model-gateway/agent-tool.ts";
import type { ModelGateway } from "../model-gateway/model-gateway.ts";
import { UsageLedger } from "../model-gateway/usage-ledger.ts";
import { Notes } from "../notes/notes.ts";
import { OwnerIdSchema } from "../owner-id.ts";
import type { OwnerId } from "../owner-id.ts";
import { OwnerPreferences } from "../preferences/owner-preferences.ts";
import { Profile } from "../profile/profile.ts";
import { Schedules } from "../schedule/schedules.ts";
import type { AlarmClock } from "../schedule/schedules.ts";
import type { OperatorMetrics } from "../tracing/operator-metrics.ts";
import type { Redactor } from "../tracing/redactor.ts";
import { TurnTraces } from "../tracing/turn-trace.ts";
import { AgentStorage } from "./agent-storage.ts";
import { Conversation } from "./conversation.ts";
import { fireDueSchedulesThen } from "./due-schedule-events.ts";
import { Inbox } from "./inbox.ts";
import { OwnerChannelConversation } from "./owner-channel-conversation.ts";
import { TurnProgress } from "./turn-progress.ts";
import { liveTurnServices } from "./turn-services.ts";
import { takeTurn } from "./turn.ts";

const personalAgentLayer = (
  storage: DurableObjectStorage,
  ownerId: OwnerId,
  alarmClock: AlarmClock
) => {
  const journal = Journal.layer(ownerId);
  const schedules = Schedules.layer(ownerId, alarmClock).pipe(
    Layer.provide(journal)
  );
  return Layer.mergeAll(
    schedules,
    Inbox.layer.pipe(Layer.provide(journal)),
    journal,
    Notes.layer(ownerId).pipe(Layer.provide(journal)),
    Profile.layer(ownerId).pipe(Layer.provide(journal)),
    OwnerPreferences.layer.pipe(Layer.provide(journal)),
    Conversation.layer,
    OwnerChannelConversation.layer,
    TurnProgress.layer,
    UsageLedger.layer(ownerId),
    TurnTraces.layer(ownerId)
  ).pipe(Layer.provideMerge(AgentStorage.layer(storage)));
};

export type TurnServices = Layer.Layer<
  Channel | ModelGateway | OperatorMetrics | Redactor,
  unknown,
  UsageLedger
>;

export type StoreConfirmation = "stored";

export class PersonalAgent extends Agent<Env> {
  readonly ownerId = OwnerIdSchema.make(this.name);

  protected readonly turnServices: (
    env: Env,
    ownerId: OwnerId
  ) => TurnServices = liveTurnServices;

  protected readonly turnTools: AgentTools = noTools;

  protected readonly alarmClock: AlarmClock = {
    setAt: (dueAt) => this.setAlarmAt(dueAt),
  };

  readonly runtime = ManagedRuntime.make(
    personalAgentLayer(this.ctx.storage, this.ownerId, this.alarmClock)
  );

  async receive(event: Event): Promise<StoreConfirmation> {
    await this.runtime.runPromise(
      Effect.gen(function* receiveEffect() {
        const inbox = yield* Inbox;
        const ownerConversation = yield* OwnerChannelConversation;
        if (event._tag === "OwnerMessage") {
          yield* ownerConversation.remember(event);
        }
        yield* inbox.store(event);
      })
    );
    await this.runTurnWhenEventsArePending();
    return "stored";
  }

  async fireDueSchedules(): Promise<void> {
    await this.runtime.runPromise(
      fireDueSchedulesThen(
        Effect.promise(() => this.runTurnWhenEventsArePending())
      )
    );
  }

  private async setAlarmAt(dueAt: Option.Option<DateTime.Utc>): Promise<void> {
    const sdkSchedules = await this.listSchedules();
    const armed = sdkSchedules.filter(
      (schedule) => schedule.callback === "fireDueSchedules"
    );
    const dueSeconds = dueAt.pipe(
      Option.map((instant) => Math.ceil(DateTime.toEpochMillis(instant) / 1000))
    );
    const [only] = armed;
    if (
      armed.length === 1 &&
      only !== undefined &&
      Option.contains(dueSeconds, only.time)
    ) {
      return;
    }
    await Promise.all(
      armed.map((schedule) => this.cancelSchedule(schedule.id))
    );
    if (Option.isSome(dueSeconds)) {
      await this.schedule(
        new Date(dueSeconds.value * 1000),
        "fireDueSchedules",
        undefined,
        { retry: { maxAttempts: 3 } }
      );
    }
  }

  private async runTurnWhenEventsArePending(): Promise<void> {
    const hasPendingEvents = await this.runtime.runPromise(
      Inbox.pipe(
        Effect.flatMap((inbox) => inbox.pending),
        Effect.map((events) => events.length > 0)
      )
    );
    if (hasPendingEvents) {
      await this.schedule(0, "runTurn", undefined, {
        retry: { maxAttempts: 1 },
      });
    }
  }

  async runTurn(): Promise<void> {
    await this.runtime.runPromise(
      takeTurn(this.ownerId, defaultBehaviorConfig, this.turnTools).pipe(
        Effect.provide(this.turnServices(this.env, this.ownerId))
      )
    );
  }
}

export const personalAgentFor = <Kind extends PersonalAgent>(
  namespace: DurableObjectNamespace<Kind>,
  ownerId: OwnerId
) => getAgentByName<Env, Kind>(namespace, ownerId);
