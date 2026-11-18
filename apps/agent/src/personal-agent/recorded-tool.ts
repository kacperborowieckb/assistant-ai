import type { JSONValue } from "ai";
import { Cause, Effect, Option } from "effect";
import type { Schema } from "effect";

import {
  agentTool,
  effectInputSchema,
  ToolFailed,
} from "../model-gateway/agent-tool.ts";
import type { AgentTool } from "../model-gateway/agent-tool.ts";
import type { Redactor } from "../tracing/redactor.ts";
import type { TurnProgress } from "./turn-progress.ts";

export interface RecordedToolServices {
  readonly eventId: string;
  readonly progress: TurnProgress["Service"];
  readonly redactor: Redactor["Service"];
}

export interface RecordedToolDefinition<
  Input extends JSONValue,
  Output extends JSONValue,
  Failure,
> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Schema.Codec<Input, unknown>;
  readonly failureMessage: string | ((cause: Cause.Cause<unknown>) => string);
  readonly recordedInput?: (input: Input) => JSONValue;
  readonly work: (input: Input) => Effect.Effect<Output, Failure>;
}

const toolFailedFrom =
  (
    failureMessage: RecordedToolDefinition<
      never,
      never,
      never
    >["failureMessage"]
  ) =>
  (cause: Cause.Cause<unknown>) =>
    Cause.findErrorOption(cause).pipe(
      Option.filter((error) => error instanceof ToolFailed),
      Option.getOrElse(
        () =>
          new ToolFailed({
            message:
              typeof failureMessage === "string"
                ? failureMessage
                : failureMessage(cause),
          })
      )
    );

export const recordedTool = <
  Input extends JSONValue,
  Output extends JSONValue,
  Failure,
>(
  { eventId, progress, redactor }: RecordedToolServices,
  definition: RecordedToolDefinition<Input, Output, Failure>
): AgentTool =>
  agentTool({
    description: definition.description,
    inputSchema: effectInputSchema(definition.inputSchema),
    execute: Effect.fnUntraced(
      function* recordedToolEffect(input, { toolCallId, modelStepKey }) {
        yield* progress.markModelStep(eventId, modelStepKey);
        return yield* progress.recordingToolCall(
          {
            eventId,
            toolCallId,
            toolName: definition.name,
            input: definition.recordedInput?.(input) ?? input,
            redactor,
          },
          definition.work(input)
        );
      },
      Effect.catchCause((cause) =>
        Effect.fail(toolFailedFrom(definition.failureMessage)(cause))
      )
    ),
  });
