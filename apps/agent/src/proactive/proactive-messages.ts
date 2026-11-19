import { eq, isNull, and } from "drizzle-orm";
import { Context, DateTime, Effect, Layer, Schema } from "effect";

import { AgentStorage } from "../personal-agent/agent-storage.ts";
import { proactiveMessages } from "./proactive-schema.ts";

const OpenLoopIdsJsonSchema = Schema.fromJsonString(
  Schema.Array(Schema.String)
);

const encodeIds = Schema.encodeSync(OpenLoopIdsJsonSchema);
const decodeIds = Schema.decodeUnknownSync(OpenLoopIdsJsonSchema);

const makeProactiveMessages = Effect.gen(
  function* makeProactiveMessagesEffect() {
    const { database } = yield* AgentStorage;

    const forEvent = Effect.fnUntraced(function* forEvent(eventId: string) {
      const [row] = yield* database
        .select()
        .from(proactiveMessages)
        .where(eq(proactiveMessages.eventId, eventId));
      return row === undefined
        ? undefined
        : {
            eventId: row.eventId,
            sentMessageId: row.sentMessageId,
            openLoopIds: decodeIds(row.openLoopIds),
            outcome: row.outcome,
          };
    });

    const plan = Effect.fnUntraced(function* plan(
      eventId: string,
      openLoopIds: readonly string[]
    ) {
      yield* database
        .insert(proactiveMessages)
        .values({
          eventId,
          openLoopIds: encodeIds(openLoopIds),
          plannedAt: DateTime.formatIso(yield* DateTime.now),
        })
        .onConflictDoNothing();
      const planned = yield* forEvent(eventId);
      return planned?.openLoopIds ?? openLoopIds;
    });

    const recordSent = (eventId: string, sentMessageId: string) =>
      database
        .update(proactiveMessages)
        .set({ sentMessageId })
        .where(
          and(
            eq(proactiveMessages.eventId, eventId),
            isNull(proactiveMessages.sentMessageId)
          )
        )
        .returning({ eventId: proactiveMessages.eventId })
        .pipe(Effect.map((rows) => rows.length > 0));

    return { plan, recordSent, forEvent };
  }
);

export class ProactiveMessages extends Context.Service<
  ProactiveMessages,
  Effect.Success<typeof makeProactiveMessages>
>()("ProactiveMessages") {
  static readonly layer = Layer.effect(
    ProactiveMessages,
    makeProactiveMessages
  );
}
