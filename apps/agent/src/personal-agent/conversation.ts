import type { ModelMessage } from "ai";
import { desc } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

import {
  ModelMessageJsonSchema,
  ModelMessageSchema,
} from "../model-gateway/model-message-schema.ts";
import { AgentStorage } from "./agent-storage.ts";
import { conversationMessages } from "./storage-schema.ts";

const recentMessageLimit = 20;

const encodeMessage = Schema.encodeSync(ModelMessageJsonSchema);
const decodeMessage = Schema.decodeUnknownEffect(ModelMessageJsonSchema);
const checkMessage = Schema.decodeUnknownEffect(ModelMessageSchema);

const startingAtOwnerMessage = (messages: readonly ModelMessage[]) => {
  const firstOwnerMessage = messages.findIndex(
    (message) => message.role === "user"
  );
  return firstOwnerMessage === -1 ? [] : messages.slice(firstOwnerMessage);
};

const makeConversation = Effect.gen(function* makeConversationEffect() {
  const { database } = yield* AgentStorage;

  const recent = database
    .select({ message: conversationMessages.message })
    .from(conversationMessages)
    .orderBy(desc(conversationMessages.sequence))
    .limit(recentMessageLimit)
    .pipe(
      Effect.flatMap((rows) =>
        Effect.forEach(rows.toReversed(), (row) => decodeMessage(row.message))
      ),
      Effect.orDie,
      Effect.map(startingAtOwnerMessage)
    );

  const append = (messages: readonly ModelMessage[]) =>
    Effect.gen(function* appendEffect() {
      const recordedAt = new Date().toISOString();
      for (const message of messages) {
        const checked = yield* checkMessage(message).pipe(Effect.orDie);
        yield* database
          .insert(conversationMessages)
          .values({ message: encodeMessage(checked), recordedAt });
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
