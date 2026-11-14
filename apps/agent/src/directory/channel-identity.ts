import { Schema } from "effect";

export const ChannelIdentitySchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^telegram:\d+$/u)),
  Schema.brand("ChannelIdentity")
);

export type ChannelIdentity = typeof ChannelIdentitySchema.Type;

export const telegramIdentity = (telegramUserId: number): ChannelIdentity =>
  ChannelIdentitySchema.make(`telegram:${telegramUserId}`);
