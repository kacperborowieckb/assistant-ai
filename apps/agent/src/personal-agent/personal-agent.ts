import { Agent, getAgentByName } from "agents";
import { Layer, ManagedRuntime } from "effect";

import type { OwnerId } from "../owner-id.ts";
import { AgentStorage } from "./agent-storage.ts";

const makeRuntime = (storage: DurableObjectStorage) =>
  ManagedRuntime.make(Layer.succeed(AgentStorage, { sql: storage.sql }));

export class PersonalAgent extends Agent<Env> {
  readonly runtime = makeRuntime(this.ctx.storage);
}

export const personalAgentFor = (
  namespace: DurableObjectNamespace<PersonalAgent>,
  ownerId: OwnerId
) => getAgentByName(namespace, ownerId);
