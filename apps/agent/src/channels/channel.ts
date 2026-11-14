import { Context } from "effect";
import type { Effect } from "effect";

export interface OutgoingReply {
  readonly conversationId: string;
  readonly inReplyTo: string;
  readonly text: string;
}

export type Delivery =
  | { readonly _tag: "Confirmed"; readonly channelMessageId: string }
  | { readonly _tag: "Failed"; readonly reason: string };

export class Channel extends Context.Service<
  Channel,
  { readonly send: (reply: OutgoingReply) => Effect.Effect<Delivery> }
>()("Channel") {}
