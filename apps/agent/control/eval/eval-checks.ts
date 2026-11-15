import { Schema } from "effect";

import { NonEmptyString } from "../../eval/eval-contract.ts";
import type {
  AgentObservation,
  ObservedNote,
} from "../../eval/eval-contract.ts";
import {
  profileEntryKinds,
  trustLevels,
} from "../../src/personal-agent/storage-schema.ts";
import { OwnerLabelSchema } from "./owner-label.ts";
import { counted } from "./wording.ts";

const owner = { owner: Schema.optionalKey(OwnerLabelSchema) };

const Count = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));

const NoteCountCheckSchema = Schema.Struct({
  check: Schema.Literal("note_count"),
  ...owner,
  equals: Count,
});

const TextIncludesSchema = Schema.Array(NonEmptyString).pipe(
  Schema.check(Schema.isMinLength(1))
);

const NoteMatchesCheckSchema = Schema.Struct({
  check: Schema.Literal("note_matches"),
  ...owner,
  textIncludes: TextIncludesSchema,
  url: Schema.optionalKey(NonEmptyString),
  trustLevel: Schema.optionalKey(Schema.Literals(trustLevels)),
  forwardOrigin: Schema.optionalKey(NonEmptyString),
});

const LinkCountCheckSchema = Schema.Struct({
  check: Schema.Literal("link_count"),
  ...owner,
  equals: Count,
});

const NotesLinkedCheckSchema = Schema.Struct({
  check: Schema.Literal("notes_linked"),
  ...owner,
  noteIncludes: TextIncludesSchema,
  linkedNoteIncludes: TextIncludesSchema,
});

const ProfileEntryMatchesCheckSchema = Schema.Struct({
  check: Schema.Literal("profile_entry_matches"),
  ...owner,
  textIncludes: TextIncludesSchema,
  kind: Schema.optionalKey(Schema.Literals(profileEntryKinds)),
});

const ProfileEntryCountCheckSchema = Schema.Struct({
  check: Schema.Literal("profile_entry_count"),
  ...owner,
  equals: Count,
});

const ToolCallsCheckSchema = Schema.Struct({
  check: Schema.Literal("tool_calls"),
  ...owner,
  tool: NonEmptyString,
  min: Schema.optionalKey(Count),
  max: Schema.optionalKey(Count),
});

const ReplyJudgedCheckSchema = Schema.Struct({
  check: Schema.Literal("reply_judged"),
  ...owner,
  rubric: NonEmptyString,
});

export const CodeCheckSchema = Schema.Union([
  NoteCountCheckSchema,
  NoteMatchesCheckSchema,
  LinkCountCheckSchema,
  NotesLinkedCheckSchema,
  ProfileEntryCountCheckSchema,
  ProfileEntryMatchesCheckSchema,
  ToolCallsCheckSchema,
]);

export type CodeCheck = typeof CodeCheckSchema.Type;

export const EvalCheckSchema = Schema.Union([
  CodeCheckSchema,
  ReplyJudgedCheckSchema,
]);

export type EvalCheck = typeof EvalCheckSchema.Type;

export interface CheckOutcome {
  readonly label: string;
  readonly passed: boolean;
  readonly detail: string;
}

const listed = (
  word: string,
  values: readonly string[],
  pluralWord = `${word}s`
) =>
  values.length === 0
    ? `no ${pluralWord}`
    : `${counted(values.length, word, pluralWord)}: ${values.map((value) => `"${value}"`).join(", ")}`;

const includesIgnoringCase = (text: string, part: string) =>
  text.toLowerCase().includes(part.toLowerCase());

type NoteMatchesCheck = typeof NoteMatchesCheckSchema.Type;

const includesAll = (text: string, parts: readonly string[]) =>
  parts.every((part) => includesIgnoringCase(text, part));

const quotedParts = (parts: readonly string[]) =>
  parts.map((part) => `"${part}"`).join(", ");

const noteMatches = (check: NoteMatchesCheck) => (note: ObservedNote) =>
  includesAll(note.text, check.textIncludes) &&
  (check.url === undefined || note.url === check.url) &&
  (check.trustLevel === undefined || note.trustLevel === check.trustLevel) &&
  (check.forwardOrigin === undefined ||
    note.forwardOrigin === check.forwardOrigin);

const noteMatchesLabel = (check: NoteMatchesCheck) =>
  [
    `a Note includes ${quotedParts(check.textIncludes)}`,
    check.url === undefined ? [] : `with URL ${check.url}`,
    check.trustLevel === undefined
      ? []
      : `with trust level ${check.trustLevel}`,
    check.forwardOrigin === undefined ? [] : `from ${check.forwardOrigin}`,
  ]
    .flat()
    .join(" ");

const noteTexts = (notes: readonly ObservedNote[]) =>
  listed(
    "Note",
    notes.map((note) => note.text)
  );

const noteFields = (note: ObservedNote) =>
  [
    note.text,
    `trust level ${note.trustLevel}`,
    note.url === undefined ? [] : `URL ${note.url}`,
    note.forwardOrigin === undefined ? [] : `from ${note.forwardOrigin}`,
  ]
    .flat()
    .join(", ");

const noteDescriptions = (notes: readonly ObservedNote[]) =>
  listed("Note", notes.map(noteFields));

type NotesLinkedCheck = typeof NotesLinkedCheckSchema.Type;

const linkCountOf = (notes: readonly ObservedNote[]) =>
  notes.reduce((total, note) => total + note.linkedNoteIds.length, 0) / 2;

const notesAreLinked = (
  check: NotesLinkedCheck,
  notes: readonly ObservedNote[]
) => {
  const linkedNoteIds = new Set(
    notes
      .filter((note) => includesAll(note.text, check.linkedNoteIncludes))
      .map((note) => note.noteId)
  );
  return notes.some(
    (note) =>
      includesAll(note.text, check.noteIncludes) &&
      note.linkedNoteIds.some((noteId) => linkedNoteIds.has(noteId))
  );
};

const linkedPairs = (notes: readonly ObservedNote[]) => {
  const textOf = new Map(notes.map((note) => [note.noteId, note.text]));
  return notes.flatMap((note) =>
    note.linkedNoteIds
      .filter((noteId) => note.noteId < noteId)
      .map((noteId) => `${note.text} <-> ${textOf.get(noteId) ?? noteId}`)
  );
};

type ToolCallsCheck = typeof ToolCallsCheckSchema.Type;

const toolCallBounds = ({ min, max }: ToolCallsCheck) => ({
  min: min ?? (max === undefined ? 1 : 0),
  max: max ?? Number.POSITIVE_INFINITY,
});

const toolCallBoundsLabel = (check: ToolCallsCheck) => {
  const { min, max } = toolCallBounds(check);
  if (max === Number.POSITIVE_INFINITY) {
    return `at least ${counted(min, "time")}`;
  }
  return min === max
    ? `exactly ${counted(min, "time")}`
    : `${min} to ${max} times`;
};

export const evaluateCodeCheck = (
  check: CodeCheck,
  observation: AgentObservation
): CheckOutcome => {
  switch (check.check) {
    case "note_count": {
      return {
        label: `note_count: ${counted(check.equals, "Note")}`,
        passed: observation.notes.length === check.equals,
        detail: noteTexts(observation.notes),
      };
    }
    case "note_matches": {
      return {
        label: `note_matches: ${noteMatchesLabel(check)}`,
        passed: observation.notes.some(noteMatches(check)),
        detail: noteDescriptions(observation.notes),
      };
    }
    case "link_count": {
      return {
        label: `link_count: ${counted(check.equals, "link")}`,
        passed: linkCountOf(observation.notes) === check.equals,
        detail: listed("link", linkedPairs(observation.notes)),
      };
    }
    case "notes_linked": {
      return {
        label: `notes_linked: a Note that includes ${quotedParts(check.noteIncludes)} links to a Note that includes ${quotedParts(check.linkedNoteIncludes)}`,
        passed: notesAreLinked(check, observation.notes),
        detail: listed("link", linkedPairs(observation.notes)),
      };
    }
    case "profile_entry_matches": {
      return {
        label: `profile_entry_matches: a Profile entry${check.kind === undefined ? "" : ` of kind ${check.kind}`} includes ${quotedParts(check.textIncludes)}`,
        passed: observation.profile.some(
          (entry) =>
            (check.kind === undefined || entry.kind === check.kind) &&
            includesAll(entry.text, check.textIncludes)
        ),
        detail: listed(
          "Profile entry",
          observation.profile.map((entry) => `${entry.kind}: ${entry.text}`),
          "Profile entries"
        ),
      };
    }
    case "profile_entry_count": {
      return {
        label: `profile_entry_count: ${counted(check.equals, "Profile entry", "Profile entries")}`,
        passed: observation.profile.length === check.equals,
        detail: listed(
          "Profile entry",
          observation.profile.map((entry) => entry.text),
          "Profile entries"
        ),
      };
    }
    case "tool_calls": {
      const count = observation.toolCalls.filter(
        (call) => call.name === check.tool
      ).length;
      const { min, max } = toolCallBounds(check);
      return {
        label: `tool_calls: ${check.tool} called ${toolCallBoundsLabel(check)}`,
        passed: count >= min && count <= max,
        detail: listed(
          "tool call",
          observation.toolCalls.map((call) => call.name)
        ),
      };
    }
    default: {
      return check satisfies never;
    }
  }
};
