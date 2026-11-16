import { Schema } from "effect";

export const ownerMessageFields = {
  channel: Schema.Literal("telegram"),
  channelUpdateId: Schema.String,
  conversationId: Schema.String,
  channelMessageId: Schema.String,
  text: Schema.String,
  forwardOrigin: Schema.optionalKey(Schema.String),
  sentAt: Schema.String,
};

export const scheduleFiredFields = {
  scheduleId: Schema.String,
  dueAt: Schema.String,
};

export const EventSchema = Schema.TaggedUnion({
  OwnerMessage: ownerMessageFields,
  ScheduleFired: scheduleFiredFields,
});

export const OwnerMessageSchema = EventSchema.cases.OwnerMessage;

export const ScheduleFiredSchema = EventSchema.cases.ScheduleFired;

export type Event = typeof EventSchema.Type;

export type OwnerMessage = typeof OwnerMessageSchema.Type;

export type ScheduleFired = typeof ScheduleFiredSchema.Type;
