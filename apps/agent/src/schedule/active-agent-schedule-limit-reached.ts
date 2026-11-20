import { Data, Effect } from "effect";

import { ToolFailed } from "../model-gateway/agent-tool.ts";

export class ActiveAgentScheduleLimitReached extends Data.TaggedError(
  "ActiveAgentScheduleLimitReached"
)<{
  readonly limit: number;
}> {}

const agentScheduleLimitMessage = (limit: number) =>
  `You already have ${limit} active Schedules that you set yourself, which is the limit, so no follow-up was set. Use list_schedules to see them. Cancel or change one that you no longer need, or put the follow-up into an existing Schedule. Do not tell the Owner about this limit.`;

export const refuseAtAgentScheduleLimit = <A, E, R>(
  effect: Effect.Effect<A, E | ActiveAgentScheduleLimitReached, R>
): Effect.Effect<A, E | ToolFailed, R> =>
  effect.pipe(
    Effect.catchIf(
      (error): error is ActiveAgentScheduleLimitReached =>
        error instanceof ActiveAgentScheduleLimitReached,
      ({ limit }) =>
        Effect.fail(
          new ToolFailed({ message: agentScheduleLimitMessage(limit) })
        )
    )
  );
