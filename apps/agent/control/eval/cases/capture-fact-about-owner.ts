import type { EvalCaseFile } from "../eval-case.ts";

export default {
  description:
    "The Owner states a core fact about themselves. The agent adds it to the Profile as a fact, keeps no Note, and says what it added.",
  events: [{ text: "I am vegetarian, so never suggest meat dishes" }],
  checks: [
    {
      check: "profile_entry_matches",
      textIncludes: ["vegetarian"],
      kind: "fact",
    },
    { check: "tool_calls", tool: "update_profile", min: 1 },
    { check: "tool_calls", tool: "capture_note", max: 0 },
    { check: "note_count", equals: 0 },
    {
      check: "reply_judged",
      rubric: [
        "The reply says that the agent added to the Profile that the Owner is vegetarian.",
        "It is short plain text, like a text message, with no markdown, headings, or lists.",
      ].join("\n"),
    },
  ],
} satisfies EvalCaseFile;
