import { desc } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

import { AgentStorage } from "./agent-storage.ts";
import { conversationMessages } from "./storage-schema.ts";

export const ConversationMessageSchema = Schema.Struct({
  role: Schema.Literals(["owner", "agent"]),
  text: Schema.String,
});

export type ConversationMessage = typeof ConversationMessageSchema.Type;

const recentMessageLimit = 20;

const makeConversation = Effect.gen(function* makeConversationEffect() {
  const { database } = yield* AgentStorage;

  const recent = Effect.sync(() =>
    database
      .select({
        role: conversationMessages.role,
        text: conversationMessages.text,
      })
      .from(conversationMessages)
      .orderBy(desc(conversationMessages.sequence))
      .limit(recentMessageLimit)
      .all()
      .toReversed()
  );

  const append = (messages: readonly ConversationMessage[]) =>
    Effect.sync(() => {
      const recordedAt = new Date().toISOString();
      for (const message of messages) {
        database
          .insert(conversationMessages)
          .values({ role: message.role, text: message.text, recordedAt })
          .run();
      }
    });

  return { recent, append };
});

export class Conversation extends Context.Service<
  Conversation,
  Effect.Success<typeof makeConversation>
>()("Conversation") {
  static readonly layer = Layer.effect(Conversation, makeConversation);
}
