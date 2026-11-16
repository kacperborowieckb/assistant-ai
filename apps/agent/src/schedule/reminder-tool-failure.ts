import { Cause, Effect, Option } from "effect";

import { ToolFailed } from "../model-gateway/agent-tool.ts";

export const failWithToolMessage = (otherwise: string) =>
  Effect.catchCause((cause: Cause.Cause<unknown>) =>
    Effect.fail(
      Cause.findErrorOption(cause).pipe(
        Option.filter((error) => error instanceof ToolFailed),
        Option.getOrElse(() => new ToolFailed({ message: otherwise }))
      )
    )
  );
