import { Schema } from "effect";

export const OwnerMessageSchema = Schema.Struct({
  channel: Schema.Literal("telegram"),
  channelUpdateId: Schema.String,
  conversationId: Schema.String,
  channelMessageId: Schema.String,
  text: Schema.String,
  sentAt: Schema.String,
});

export type OwnerMessage = typeof OwnerMessageSchema.Type;
