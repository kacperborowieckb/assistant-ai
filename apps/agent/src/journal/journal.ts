import { asc } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

import type { OwnerId } from "../owner-id.ts";
import { AgentStorage } from "../personal-agent/agent-storage.ts";
import { journalEntries } from "../personal-agent/storage-schema.ts";

export const JournalRecordSchema = Schema.TaggedUnion({
  EventReceived: { eventId: Schema.String },
  ReplyPlanned: { eventId: Schema.String, text: Schema.String },
  ReplySent: { eventId: Schema.String, channelMessageId: Schema.String },
  ReplyFailed: { eventId: Schema.String, reason: Schema.String },
});

export type JournalRecord = typeof JournalRecordSchema.Type;

export interface JournalEntry {
  readonly sequence: number;
  readonly ownerId: OwnerId;
  readonly recordedAt: string;
  readonly record: JournalRecord;
}

const RecordJsonSchema = Schema.fromJsonString(JournalRecordSchema);

const decodeRecord = Schema.decodeUnknownSync(RecordJsonSchema);

const toJournalEntry = (
  row: typeof journalEntries.$inferSelect
): JournalEntry => ({
  sequence: row.sequence,
  ownerId: row.ownerId,
  recordedAt: row.recordedAt,
  record: decodeRecord(row.record),
});

const makeJournal = (ownerId: OwnerId) =>
  Effect.gen(function* makeJournalEffect() {
    const { database } = yield* AgentStorage;

    const append = (record: JournalRecord) =>
      database
        .insert(journalEntries)
        .values({
          ownerId,
          recordedAt: new Date().toISOString(),
          kind: record._tag,
          eventId: record.eventId,
          record: Schema.encodeSync(RecordJsonSchema)(record),
        })
        .pipe(Effect.asVoid);

    const read = database
      .select()
      .from(journalEntries)
      .orderBy(asc(journalEntries.sequence))
      .pipe(Effect.map((rows) => rows.map(toJournalEntry)));

    return { append, read };
  });

export class Journal extends Context.Service<
  Journal,
  Effect.Success<ReturnType<typeof makeJournal>>
>()("Journal") {
  static readonly layer = (ownerId: OwnerId) =>
    Layer.effect(Journal, makeJournal(ownerId));
}
