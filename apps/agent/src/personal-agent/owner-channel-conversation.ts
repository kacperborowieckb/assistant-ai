import { eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";

import type { OwnerMessage } from "../event.ts";
import { AgentStorage } from "./agent-storage.ts";
import { ownerChannelConversations } from "./storage-schema.ts";

const onlySlot = 0;

export interface OwnerChannelConversationRecord {
  readonly channel: OwnerMessage["channel"];
  readonly conversationId: string;
}

const makeOwnerChannelConversation = Effect.gen(
  function* makeOwnerChannelConversationEffect() {
    const { database } = yield* AgentStorage;

    const remember = (message: OwnerMessage) => {
      const conversation = {
        channel: message.channel,
        conversationId: message.conversationId,
        recordedAt: new Date().toISOString(),
      };
      return database
        .insert(ownerChannelConversations)
        .values({ slot: onlySlot, ...conversation })
        .onConflictDoUpdate({
          target: ownerChannelConversations.slot,
          set: conversation,
        })
        .pipe(Effect.asVoid);
    };

    const current = database
      .select({
        channel: ownerChannelConversations.channel,
        conversationId: ownerChannelConversations.conversationId,
      })
      .from(ownerChannelConversations)
      .where(eq(ownerChannelConversations.slot, onlySlot))
      .pipe(
        Effect.map((rows): OwnerChannelConversationRecord | undefined =>
          rows.at(0)
        )
      );

    return { remember, current };
  }
);

export class OwnerChannelConversation extends Context.Service<
  OwnerChannelConversation,
  Effect.Success<typeof makeOwnerChannelConversation>
>()("OwnerChannelConversation") {
  static readonly layer = Layer.effect(
    OwnerChannelConversation,
    makeOwnerChannelConversation
  );
}
