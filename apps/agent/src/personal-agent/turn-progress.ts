import type { JSONValue, ModelMessage } from "ai";
import { asc, countDistinct, eq } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

import {
  ModelMessageJsonSchema,
  ModelMessageSchema,
} from "../model-gateway/model-message-schema.ts";
import type { Redactor } from "../tracing/redactor.ts";
import { AgentStorage } from "./agent-storage.ts";
import { turnProgress } from "./storage-schema.ts";

const encodeMessage = Schema.encodeSync(ModelMessageJsonSchema);
const decodeMessage = Schema.decodeUnknownEffect(ModelMessageJsonSchema);
const checkMessage = Schema.decodeUnknownEffect(ModelMessageSchema);

export interface ToolCallProgress {
  readonly eventId: string;
  readonly toolCallId: string;
  readonly modelStepKey: number;
  readonly toolName: string;
  readonly input: JSONValue;
  readonly redactor: Redactor["Service"];
}

const messagesOfToolCall = (
  { toolCallId, toolName, input }: ToolCallProgress,
  output: JSONValue
): readonly ModelMessage[] => [
  {
    role: "assistant",
    content: [{ type: "tool-call", toolCallId, toolName, input }],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId,
        toolName,
        output: { type: "json", value: output },
      },
    ],
  },
];

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
          Effect.all(rows.map((row) => decodeMessage(row.message))).pipe(
            Effect.orDie
          )
        )
      );

  const finishedStepCount = (eventId: string) =>
    database
      .select({ steps: countDistinct(turnProgress.modelStepKey) })
      .from(turnProgress)
      .where(eq(turnProgress.eventId, eventId))
      .pipe(Effect.map(([row]) => row?.steps ?? 0));

  const record = (call: ToolCallProgress, messages: readonly ModelMessage[]) =>
    Effect.gen(function* recordEffect() {
      const recordedAt = new Date().toISOString();
      for (const message of messages) {
        const checked = yield* checkMessage(
          call.redactor.redactMessage(message)
        ).pipe(Effect.orDie);
        yield* database.insert(turnProgress).values({
          eventId: call.eventId,
          modelStepKey: call.modelStepKey,
          message: encodeMessage(checked),
          recordedAt,
        });
      }
    });

  const recordingToolCall = <Output extends JSONValue, Failure, Needs>(
    call: ToolCallProgress,
    run: Effect.Effect<Output, Failure, Needs>
  ) =>
    database.transaction(() =>
      run.pipe(
        Effect.tap((output) => record(call, messagesOfToolCall(call, output)))
      )
    );

  return { completedFor, finishedStepCount, recordingToolCall };
});

export class TurnProgress extends Context.Service<
  TurnProgress,
  Effect.Success<typeof makeTurnProgress>
>()("TurnProgress") {
  static readonly layer = Layer.effect(TurnProgress, makeTurnProgress);
}
