export interface FakeModelCall {
  readonly model: string;
  readonly gatewayId: string | undefined;
  readonly metadata: string | undefined;
  readonly collectLogPayload: string | undefined;
  readonly lastUserMessage: string;
  readonly toolCalls: readonly string[];
}

export const toolCallNamesOf = (message: object): readonly string[] =>
  "tool_calls" in message && Array.isArray(message.tool_calls)
    ? message.tool_calls.map(
        (call: { function: { name: string } }) => call.function.name
      )
    : [];
