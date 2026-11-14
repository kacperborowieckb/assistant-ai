import { Data } from "effect";

import type { ChannelIdentity } from "./channel-identity.ts";

export class ChannelIdentityTaken extends Data.TaggedError(
  "ChannelIdentityTaken"
)<{ readonly channelIdentity: ChannelIdentity }> {}
