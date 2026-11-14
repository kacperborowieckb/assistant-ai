import { Schema } from "effect";

export const AddOwnerRequestSchema = Schema.Struct({
  telegramUserId: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
});

export const AddOwnerResponseSchema = Schema.Struct({
  ownerId: Schema.String,
  channelIdentity: Schema.String,
  registration: Schema.Literals(["open", "closed"]),
});

export type AddOwnerResponse = typeof AddOwnerResponseSchema.Type;
