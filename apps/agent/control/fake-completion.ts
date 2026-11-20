import { Schema } from "effect";

export const ChatCompletionBodySchema = Schema.Struct({
  model: Schema.String,
  messages: Schema.Array(
    Schema.Struct({ role: Schema.String, content: Schema.Unknown })
  ),
});

export const lastOwnerText = (
  messages: (typeof ChatCompletionBodySchema.Type)["messages"]
) => {
  const content = messages.findLast(
    (message) => message.role === "user"
  )?.content;
  return typeof content === "string" ? content : "";
};

export const systemTextOf = (
  messages: (typeof ChatCompletionBodySchema.Type)["messages"]
) => {
  const content = messages.find(
    (message) => message.role === "system"
  )?.content;
  return typeof content === "string" ? content : "";
};

export const toolResultOf = (
  messages: (typeof ChatCompletionBodySchema.Type)["messages"]
) => {
  const last = messages.at(-1);
  return last?.role === "tool" && typeof last.content === "string"
    ? last.content
    : undefined;
};
