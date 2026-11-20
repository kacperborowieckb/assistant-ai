import { Context } from "effect";
import type { Effect } from "effect";

import type { TypingNotShown } from "./typing-not-shown.ts";

export interface OutgoingMessage {
  readonly conversationId: string;
  readonly inReplyTo?: string;
  readonly text: string;
}

export type Delivery =
  | { readonly _tag: "Confirmed"; readonly channelMessageId: string }
  | { readonly _tag: "Failed"; readonly reason: string };

export class Channel extends Context.Service<
  Channel,
  {
    readonly send: (message: OutgoingMessage) => Effect.Effect<Delivery>;
    readonly showTyping: (
      conversationId: string
    ) => Effect.Effect<void, TypingNotShown>;
  }
>()("Channel") {}
