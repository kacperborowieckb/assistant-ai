import { Agent, getAgentByName } from "agents";
import { Effect, Layer, ManagedRuntime } from "effect";

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
import type { OperatorMetrics } from "../tracing/operator-metrics.ts";
import type { Redactor } from "../tracing/redactor.ts";
import { TurnTraces } from "../tracing/turn-trace.ts";
import { AgentStorage } from "./agent-storage.ts";
import { Conversation } from "./conversation.ts";
import { Inbox } from "./inbox.ts";
import { OwnerChannelConversation } from "./owner-channel-conversation.ts";
import { TurnProgress } from "./turn-progress.ts";
import { liveTurnServices } from "./turn-services.ts";
import { takeTurn } from "./turn.ts";

const personalAgentLayer = (
  storage: DurableObjectStorage,
  ownerId: OwnerId
) => {
  const journal = Journal.layer(ownerId);
  return Layer.mergeAll(
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

  readonly runtime = ManagedRuntime.make(
    personalAgentLayer(this.ctx.storage, this.ownerId)
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
    return "stored";
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
