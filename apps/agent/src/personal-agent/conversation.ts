import { Context, Effect, Layer, Schema } from "effect";

import { AgentStorage } from "./agent-storage.ts";

export const conversationSchema = [
  `CREATE TABLE IF NOT EXISTS conversation_messages (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL CHECK (role IN ('owner', 'agent')),
    text TEXT NOT NULL,
    recorded_at TEXT NOT NULL
  )`,
];

export const ConversationMessageSchema = Schema.Struct({
  role: Schema.Literals(["owner", "agent"]),
  text: Schema.String,
});

export type ConversationMessage = typeof ConversationMessageSchema.Type;

const recentMessageLimit = 20;

const decodeMessageRows = Schema.decodeUnknownSync(
  Schema.Array(ConversationMessageSchema)
);

const makeConversation = Effect.gen(function* makeConversationEffect() {
  const { sql } = yield* AgentStorage;

  const recent = Effect.sync(() =>
    decodeMessageRows(
      sql
        .exec(
          `SELECT role, text FROM (
             SELECT sequence, role, text FROM conversation_messages
             ORDER BY sequence DESC LIMIT ?
           ) ORDER BY sequence`,
          recentMessageLimit
        )
        .toArray()
    )
  );

  const append = (messages: readonly ConversationMessage[]) =>
    Effect.sync(() => {
      const recordedAt = new Date().toISOString();
      for (const message of messages) {
        sql.exec(
          "INSERT INTO conversation_messages (role, text, recorded_at) VALUES (?, ?, ?)",
          message.role,
          message.text,
          recordedAt
        );
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
