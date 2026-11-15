import type { OwnerId } from "../src/owner-id.ts";
import {
  PersonalAgent,
  personalAgentFor,
} from "../src/personal-agent/personal-agent.ts";
import type {
  AgentObservation,
  SeedRequest,
  SeedResponse,
} from "./eval-contract.ts";
import { observeOwnerState, seedOwnerState } from "./owner-state.ts";

export class EvalPersonalAgent extends PersonalAgent {
  seed(request: SeedRequest): Promise<SeedResponse> {
    return this.runtime.runPromise(seedOwnerState(request));
  }

  observe(): Promise<AgentObservation> {
    return this.runtime.runPromise(observeOwnerState);
  }
}

export const evalPersonalAgentFor = (env: Env, ownerId: OwnerId) =>
  personalAgentFor(
    env.PERSONAL_AGENT as unknown as DurableObjectNamespace<EvalPersonalAgent>,
    ownerId
  );
