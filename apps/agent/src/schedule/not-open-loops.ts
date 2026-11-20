import { Data, Effect } from "effect";

import { ToolFailed } from "../model-gateway/agent-tool.ts";

export class NotOpenLoops extends Data.TaggedError("NotOpenLoops")<{
  readonly noteIds: readonly string[];
}> {}

export const refuseNotOpenLoops = <A, E, R>(
  effect: Effect.Effect<A, E | NotOpenLoops, R>
): Effect.Effect<A, E | ToolFailed, R> =>
  effect.pipe(
    Effect.catchIf(
      (error): error is NotOpenLoops => error instanceof NotOpenLoops,
      ({ noteIds }) =>
        Effect.fail(
          new ToolFailed({
            message: `No Schedule was set. These Notes have no open Open Loop: ${noteIds.join(", ")}. Use ids from list_open_loops. Leave out openLoopIds only when the Owner asked for this Schedule.`,
          })
        )
    )
  );
