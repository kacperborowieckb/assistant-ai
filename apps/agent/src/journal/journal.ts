import { Context, Effect, Layer, Schema } from "effect";

import { OwnerIdSchema } from "../owner-id.ts";
import type { OwnerId } from "../owner-id.ts";
import { AgentStorage } from "../personal-agent/agent-storage.ts";

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

export const journalSchema = [
  `CREATE TABLE IF NOT EXISTS journal_entries (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    kind TEXT NOT NULL,
    event_id TEXT NOT NULL,
    record TEXT NOT NULL
  )`,
  `CREATE TRIGGER IF NOT EXISTS journal_entries_no_update
    BEFORE UPDATE ON journal_entries
    BEGIN SELECT RAISE(ABORT, 'The Journal is append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS journal_entries_no_delete
    BEFORE DELETE ON journal_entries
    BEGIN SELECT RAISE(ABORT, 'The Journal is append-only'); END`,
];

const RecordJsonSchema = Schema.fromJsonString(JournalRecordSchema);

const EntryRowSchema = Schema.Struct({
  sequence: Schema.Number,
  owner_id: OwnerIdSchema,
  recorded_at: Schema.String,
  record: RecordJsonSchema,
});

const decodeEntryRows = Schema.decodeUnknownSync(Schema.Array(EntryRowSchema));

const toJournalEntry = (row: typeof EntryRowSchema.Type): JournalEntry => ({
  sequence: row.sequence,
  ownerId: row.owner_id,
  recordedAt: row.recorded_at,
  record: row.record,
});

const makeJournal = (ownerId: OwnerId) =>
  Effect.gen(function* makeJournalEffect() {
    const { sql } = yield* AgentStorage;

    const append = (record: JournalRecord) =>
      Effect.sync(() => {
        sql.exec(
          "INSERT INTO journal_entries (owner_id, recorded_at, kind, event_id, record) VALUES (?, ?, ?, ?, ?)",
          ownerId,
          new Date().toISOString(),
          record._tag,
          record.eventId,
          Schema.encodeSync(RecordJsonSchema)(record)
        );
      });

    const read = Effect.sync(() =>
      decodeEntryRows(
        sql
          .exec(
            "SELECT sequence, owner_id, recorded_at, record FROM journal_entries ORDER BY sequence"
          )
          .toArray()
      ).map(toJournalEntry)
    );

    return { append, read };
  });

export class Journal extends Context.Service<
  Journal,
  Effect.Success<ReturnType<typeof makeJournal>>
>()("Journal") {
  static readonly layer = (ownerId: OwnerId) =>
    Layer.effect(Journal, makeJournal(ownerId));
}
