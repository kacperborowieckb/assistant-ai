import { Schema } from "effect";

import { NonEmptyString } from "../../eval/eval-contract.ts";
import type {
  AgentObservation,
  ObservedNote,
} from "../../eval/eval-contract.ts";
import { trustLevels } from "../../src/personal-agent/storage-schema.ts";

const Count = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));

const NoteCountCheckSchema = Schema.Struct({
  check: Schema.Literal("note_count"),
  equals: Count,
});

const NoteMatchesCheckSchema = Schema.Struct({
  check: Schema.Literal("note_matches"),
  textIncludes: Schema.Array(NonEmptyString).pipe(
    Schema.check(Schema.isMinLength(1))
  ),
  url: Schema.optionalKey(NonEmptyString),
  trustLevel: Schema.optionalKey(Schema.Literals(trustLevels)),
  forwardOrigin: Schema.optionalKey(NonEmptyString),
});

const ProfileEntryCountCheckSchema = Schema.Struct({
  check: Schema.Literal("profile_entry_count"),
  equals: Count,
});

const ToolCallsCheckSchema = Schema.Struct({
  check: Schema.Literal("tool_calls"),
  tool: NonEmptyString,
  min: Schema.optionalKey(Count),
  max: Schema.optionalKey(Count),
});

const ReplyJudgedCheckSchema = Schema.Struct({
  check: Schema.Literal("reply_judged"),
  rubric: NonEmptyString,
});

export const CodeCheckSchema = Schema.Union([
  NoteCountCheckSchema,
  NoteMatchesCheckSchema,
  ProfileEntryCountCheckSchema,
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

const counted = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

const listed = (word: string, values: readonly string[]) =>
  values.length === 0
    ? `no ${word}s`
    : `${counted(values.length, word)}: ${values.map((value) => `"${value}"`).join(", ")}`;

const includesIgnoringCase = (text: string, part: string) =>
  text.toLowerCase().includes(part.toLowerCase());

type NoteMatchesCheck = typeof NoteMatchesCheckSchema.Type;

const noteMatches = (check: NoteMatchesCheck) => (note: ObservedNote) =>
  check.textIncludes.every((part) => includesIgnoringCase(note.text, part)) &&
  (check.url === undefined || note.url === check.url) &&
  (check.trustLevel === undefined || note.trustLevel === check.trustLevel) &&
  (check.forwardOrigin === undefined ||
    note.forwardOrigin === check.forwardOrigin);

const noteMatchesLabel = (check: NoteMatchesCheck) =>
  [
    `a Note includes ${check.textIncludes.map((part) => `"${part}"`).join(", ")}`,
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
        detail: noteTexts(observation.notes),
      };
    }
    case "profile_entry_count": {
      return {
        label: `profile_entry_count: ${counted(check.equals, "Profile entry")}`,
        passed: observation.profile.length === check.equals,
        detail: listed(
          "Profile entry",
          observation.profile.map((entry) => entry.text)
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
