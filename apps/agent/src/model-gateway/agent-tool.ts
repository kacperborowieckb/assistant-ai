import { tool } from "ai";
import type { FlexibleSchema, Tool } from "ai";
import { Data, Effect } from "effect";

export class ToolFailed extends Data.TaggedError("ToolFailed")<{
  readonly message: string;
}> {}

export const unexpectedToolFailureMessage = "The tool failed unexpectedly";

export type RunToolEffect = <Output>(
  effect: Effect.Effect<Output, ToolFailed>
) => Promise<Output>;

export interface AgentTool {
  readonly toAiSdkTool: (runEffect: RunToolEffect) => Tool;
}

export type AgentTools = Readonly<Record<string, AgentTool>>;

export const noTools: AgentTools = {};

interface AgentToolDefinition<Input, Output> {
  readonly description: string;
  readonly inputSchema: FlexibleSchema<Input>;
  readonly execute: (input: Input) => Effect.Effect<Output, ToolFailed>;
}

export const agentTool = <Input, Output>(
  definition: AgentToolDefinition<Input, Output>
): AgentTool => ({
  toAiSdkTool: (runEffect) =>
    tool<Input, unknown, Record<string, unknown>>({
      description: definition.description,
      inputSchema: definition.inputSchema,
      execute: (input: Input) => runEffect(definition.execute(input)),
    }),
});

export const runToolEffect =
  (
    runPromise: <Output>(effect: Effect.Effect<Output>) => Promise<Output>
  ): RunToolEffect =>
  async (effect) => {
    const outcome = await runPromise(
      effect.pipe(
        Effect.map((value) => ({ _tag: "Succeeded", value }) as const),
        Effect.catchTag("ToolFailed", (failure) =>
          Effect.succeed({ _tag: "Failed", message: failure.message } as const)
        ),
        Effect.catchCause(() =>
          Effect.succeed({
            _tag: "Failed",
            message: unexpectedToolFailureMessage,
          } as const)
        )
      )
    );
    if (outcome._tag === "Failed") {
      throw new Error(outcome.message);
    }
    return outcome.value;
  };
