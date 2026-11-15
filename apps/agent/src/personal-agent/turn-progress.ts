import type { ModelMessage } from "ai";
import { asc, eq } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

import {
  ModelMessageJsonSchema,
  ModelMessageSchema,
} from "../model-gateway/model-message-schema.ts";
import { AgentStorage } from "./agent-storage.ts";
import { turnProgress } from "./storage-schema.ts";

const encodeMessage = Schema.encodeSync(ModelMessageJsonSchema);
const decodeMessage = Schema.decodeUnknownEffect(ModelMessageJsonSchema);
const checkMessage = Schema.decodeUnknownEffect(ModelMessageSchema);

const makeTurnProgress = Effect.gen(function* makeTurnProgressEffect() {
  const { database } = yield* AgentStorage;

  const completedFor = (eventId: string) =>
    database
      .select({ message: turnProgress.message })
      .from(turnProgress)
      .where(eq(turnProgress.eventId, eventId))
      .orderBy(asc(turnProgress.sequence))
      .pipe(
        Effect.flatMap((rows) =>
          Effect.all(rows.map((row) => decodeMessage(row.message)))
        ),
        Effect.orDie
      );

  const recordToolStep = (eventId: string, messages: readonly ModelMessage[]) =>
    Effect.gen(function* recordToolStepEffect() {
      const recordedAt = new Date().toISOString();
      for (const message of messages) {
        const checked = yield* checkMessage(message).pipe(Effect.orDie);
        yield* database
          .insert(turnProgress)
          .values({ eventId, message: encodeMessage(checked), recordedAt });
      }
    }).pipe(Effect.orDie);

  return { completedFor, recordToolStep };
});

export class TurnProgress extends Context.Service<
  TurnProgress,
  Effect.Success<typeof makeTurnProgress>
>()("TurnProgress") {
  static readonly layer = Layer.effect(TurnProgress, makeTurnProgress);
}
