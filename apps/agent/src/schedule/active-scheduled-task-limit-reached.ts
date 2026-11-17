import { Data, Effect } from "effect";

import { ToolFailed } from "../model-gateway/agent-tool.ts";

export class ActiveScheduledTaskLimitReached extends Data.TaggedError(
  "ActiveScheduledTaskLimitReached"
)<{
  readonly limit: number;
}> {}

const scheduledTaskLimitMessage = (limit: number) =>
  `The Owner already has ${limit} active Scheduled Tasks, which is the limit, so no Scheduled Task was set. Tell the Owner. Ask which Scheduled Task to cancel, then cancel it and set the new one.`;

export const refuseAtScheduledTaskLimit = <A, E, R>(
  effect: Effect.Effect<A, E | ActiveScheduledTaskLimitReached, R>
): Effect.Effect<A, E | ToolFailed, R> =>
  effect.pipe(
    Effect.catchIf(
      (error): error is ActiveScheduledTaskLimitReached =>
        error instanceof ActiveScheduledTaskLimitReached,
      ({ limit }) =>
        Effect.fail(
          new ToolFailed({ message: scheduledTaskLimitMessage(limit) })
        )
    )
  );
