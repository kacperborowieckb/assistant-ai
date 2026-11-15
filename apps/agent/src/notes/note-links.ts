import { and, eq, inArray, or } from "drizzle-orm";
import { Effect } from "effect";

import type { OwnerId } from "../owner-id.ts";
import { AgentStorage } from "../personal-agent/agent-storage.ts";
import { noteLinks, notes } from "../personal-agent/storage-schema.ts";
import { UnknownNotes } from "./unknown-notes.ts";

export const uniqueNoteIds = (noteIds: readonly string[] | undefined) =>
  noteIds === undefined ? [] : [...new Set(noteIds)];

const orderedPair = (noteId: string, otherNoteId: string) =>
  noteId < otherNoteId
    ? { fromNoteId: noteId, toNoteId: otherNoteId }
    : { fromNoteId: otherNoteId, toNoteId: noteId };

const linkedNoteIdOf = (noteId: string, link: typeof noteLinks.$inferSelect) =>
  link.fromNoteId === noteId ? link.toNoteId : link.fromNoteId;

export const makeNoteLinks = (ownerId: OwnerId) =>
  Effect.gen(function* makeNoteLinksEffect() {
    const { database } = yield* AgentStorage;

    const requireOwnNotes = (noteIds: readonly string[]) =>
      Effect.gen(function* requireOwnNotesEffect() {
        if (noteIds.length === 0) {
          return;
        }
        const rows = yield* database
          .select({ noteId: notes.noteId })
          .from(notes)
          .where(
            and(eq(notes.ownerId, ownerId), inArray(notes.noteId, noteIds))
          );
        const found = new Set(rows.map((row) => row.noteId));
        const missing = noteIds.filter((noteId) => !found.has(noteId));
        if (missing.length > 0) {
          return yield* new UnknownNotes({ noteIds: missing });
        }
      });

    const linkedNoteIdsOf = (noteId: string) =>
      database
        .select()
        .from(noteLinks)
        .where(
          or(eq(noteLinks.fromNoteId, noteId), eq(noteLinks.toNoteId, noteId))
        )
        .pipe(
          Effect.map((links) =>
            links.map((link) => linkedNoteIdOf(noteId, link)).toSorted()
          )
        );

    const addLinks = (noteId: string, otherNoteIds: readonly string[]) => {
      const createdAt = new Date().toISOString();
      const values = otherNoteIds
        .filter((otherNoteId) => otherNoteId !== noteId)
        .map((otherNoteId) => ({
          ...orderedPair(noteId, otherNoteId),
          createdAt,
        }));
      return values.length === 0
        ? Effect.void
        : database
            .insert(noteLinks)
            .values(values)
            .onConflictDoNothing()
            .pipe(Effect.asVoid);
    };

    const removeLinks = (noteId: string, otherNoteIds: readonly string[]) =>
      Effect.forEach(
        otherNoteIds,
        (otherNoteId) => {
          const { fromNoteId, toNoteId } = orderedPair(noteId, otherNoteId);
          return database
            .delete(noteLinks)
            .where(
              and(
                eq(noteLinks.fromNoteId, fromNoteId),
                eq(noteLinks.toNoteId, toNoteId)
              )
            );
        },
        { discard: true }
      );

    return { requireOwnNotes, linkedNoteIdsOf, addLinks, removeLinks };
  });
