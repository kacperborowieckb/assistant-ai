import { asc, eq } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

import type { OwnerId } from "../owner-id.ts";
import { AgentStorage } from "../personal-agent/agent-storage.ts";
import { journalEntries } from "../personal-agent/storage-schema.ts";
import {
  noteChanges,
  openLoopClosedReasons,
  ownerPreferenceKeys,
  profileEntryKinds,
} from "../personal-agent/storage-values.ts";

export const JournalRecordSchema = Schema.TaggedUnion({
  EventReceived: { eventId: Schema.String },
  TurnFailed: { eventId: Schema.String, reason: Schema.String },
  ReplyPlanned: { eventId: Schema.String, text: Schema.String },
  SendStarted: { eventId: Schema.String },
  ReplySent: { eventId: Schema.String, channelMessageId: Schema.String },
  ReplyFailed: { eventId: Schema.String, reason: Schema.String },
  NoteCaptured: { eventId: Schema.String, noteId: Schema.String },
  NoteUpdated: {
    eventId: Schema.String,
    noteId: Schema.String,
    change: Schema.Literals(noteChanges),
  },
  OpenLoopOpened: {
    eventId: Schema.String,
    noteId: Schema.String,
    kind: Schema.String,
    dueAt: Schema.NullOr(Schema.String),
  },
  OpenLoopChanged: {
    eventId: Schema.String,
    noteId: Schema.String,
    kind: Schema.String,
    dueAt: Schema.NullOr(Schema.String),
  },
  OpenLoopClosed: {
    eventId: Schema.String,
    noteId: Schema.String,
    reason: Schema.Literals(openLoopClosedReasons),
  },
  ProfileEntryAdded: {
    eventId: Schema.String,
    entryId: Schema.String,
    kind: Schema.Literals(profileEntryKinds),
  },
  ProfileEntryRemoved: { eventId: Schema.String, entryId: Schema.String },
  ScheduleSet: { eventId: Schema.String, scheduleId: Schema.String },
  ScheduleChanged: { eventId: Schema.String, scheduleId: Schema.String },
  ScheduleCancelled: { eventId: Schema.String, scheduleId: Schema.String },
  ScheduleFired: {
    eventId: Schema.String,
    scheduleId: Schema.String,
    dueAt: Schema.String,
  },
  ReminderLate: {
    eventId: Schema.String,
    scheduleId: Schema.String,
    dueAt: Schema.String,
    lateByMillis: Schema.Number,
  },
  ScheduledTaskSkipped: {
    eventId: Schema.String,
    scheduleId: Schema.String,
    dueAt: Schema.String,
    dailyTokenBudget: Schema.Number,
    tokensSpent: Schema.Number,
  },
  BriefCreated: { eventId: Schema.String, scheduleId: Schema.String },
  ScheduleCompleted: { eventId: Schema.String, scheduleId: Schema.String },
  ScheduleRescheduled: {
    eventId: Schema.String,
    scheduleId: Schema.String,
    nextDueAt: Schema.String,
  },
  OwnerPreferenceChanged: {
    eventId: Schema.String,
    preference: Schema.Literals(ownerPreferenceKeys),
    value: Schema.String,
  },
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

    const readForEvent = (eventId: string) =>
      database
        .select()
        .from(journalEntries)
        .where(eq(journalEntries.eventId, eventId))
        .orderBy(asc(journalEntries.sequence))
        .pipe(Effect.map((rows) => rows.map(toJournalEntry)));

    const hasEntryOfKind = (kind: JournalRecord["_tag"]) =>
      database
        .select({ sequence: journalEntries.sequence })
        .from(journalEntries)
        .where(eq(journalEntries.kind, kind))
        .limit(1)
        .pipe(Effect.map((rows) => rows.length > 0));

    return { append, read, readForEvent, hasEntryOfKind };
  });

export class Journal extends Context.Service<
  Journal,
  Effect.Success<ReturnType<typeof makeJournal>>
>()("Journal") {
  static readonly layer = (ownerId: OwnerId) =>
    Layer.effect(Journal, makeJournal(ownerId));
}
