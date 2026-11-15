import { and, asc, eq } from "drizzle-orm";
import { Context, DateTime, Effect, Layer } from "effect";

import { Journal } from "../journal/journal.ts";
import type { OwnerId } from "../owner-id.ts";
import { AgentStorage } from "../personal-agent/agent-storage.ts";
import { profileEntries } from "../personal-agent/storage-schema.ts";
import type { profileEntryKinds } from "../personal-agent/storage-schema.ts";
import { ProfileFull } from "./profile-full.ts";
import { UnknownProfileEntry } from "./unknown-profile-entry.ts";

export type ProfileEntryKind = (typeof profileEntryKinds)[number];

export interface ProfileEntry {
  readonly entryId: string;
  readonly kind: ProfileEntryKind;
  readonly text: string;
  readonly addedAt: string;
}

export interface AddRequest {
  readonly kind: ProfileEntryKind;
  readonly text: string;
  readonly eventId: string;
  readonly characterLimit: number;
}

export interface RemoveRequest {
  readonly entryId: string;
  readonly eventId: string;
}

export interface Addition {
  readonly entry: ProfileEntry;
  readonly alreadyKept: boolean;
  readonly charactersUsed: number;
}

const toProfileEntry = (
  row: typeof profileEntries.$inferSelect
): ProfileEntry => ({
  entryId: row.entryId,
  kind: row.kind,
  text: row.text,
  addedAt: row.addedAt,
});

export const charactersUsedBy = (entries: readonly ProfileEntry[]) =>
  entries.reduce((total, entry) => total + entry.text.length, 0);

const makeProfile = Effect.fnUntraced(function* makeProfile(ownerId: OwnerId) {
  const { database } = yield* AgentStorage;
  const journal = yield* Journal;

  const read = database
    .select()
    .from(profileEntries)
    .where(eq(profileEntries.ownerId, ownerId))
    .orderBy(asc(profileEntries.addedAt), asc(profileEntries.entryId))
    .pipe(Effect.map((rows) => rows.map(toProfileEntry)));

  const writeAdd = Effect.fnUntraced(function* writeAdd({
    kind,
    text,
    eventId,
    characterLimit,
  }: AddRequest) {
    const current = yield* read;
    const existing = current.find(
      (entry) => entry.kind === kind && entry.text === text
    );
    if (existing !== undefined) {
      return {
        entry: existing,
        alreadyKept: true,
        charactersUsed: charactersUsedBy(current),
      } satisfies Addition;
    }
    const charactersUsed = charactersUsedBy(current);
    if (charactersUsed + text.length > characterLimit) {
      return yield* new ProfileFull({ charactersUsed, characterLimit });
    }
    const [row] = yield* database
      .insert(profileEntries)
      .values({
        entryId: crypto.randomUUID(),
        ownerId,
        kind,
        text,
        sourceEventId: eventId,
        addedAt: DateTime.formatIso(yield* DateTime.now),
      })
      .returning();
    if (row === undefined) {
      return yield* Effect.die("The Profile entry is not written");
    }
    yield* journal.append({
      _tag: "ProfileEntryAdded",
      eventId,
      entryId: row.entryId,
      kind,
    });
    return {
      entry: toProfileEntry(row),
      alreadyKept: false,
      charactersUsed: charactersUsed + text.length,
    } satisfies Addition;
  });

  const add = (request: AddRequest) =>
    database.transaction(() => writeAdd(request));

  const writeRemove = Effect.fnUntraced(function* writeRemove({
    entryId,
    eventId,
  }: RemoveRequest) {
    const [row] = yield* database
      .delete(profileEntries)
      .where(
        and(
          eq(profileEntries.ownerId, ownerId),
          eq(profileEntries.entryId, entryId)
        )
      )
      .returning();
    if (row === undefined) {
      return yield* new UnknownProfileEntry({ entryId });
    }
    yield* journal.append({
      _tag: "ProfileEntryRemoved",
      eventId,
      entryId,
    });
    return toProfileEntry(row);
  });

  const remove = (request: RemoveRequest) =>
    database.transaction(() => writeRemove(request));

  return { read, add, remove };
});

export class Profile extends Context.Service<
  Profile,
  Effect.Success<ReturnType<typeof makeProfile>>
>()("Profile") {
  static readonly layer = (ownerId: OwnerId) =>
    Layer.effect(Profile, makeProfile(ownerId));
}
