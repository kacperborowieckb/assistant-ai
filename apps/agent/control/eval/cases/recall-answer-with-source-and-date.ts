import type { EvalCaseFile } from "../eval-case.ts";

export default {
  description:
    "The Owner asks about a kept Note. The agent searches, answers from the Note, and names the source and the date that the Note was captured.",
  seed: { notes: [{ text: "Ana's birthday is on Friday" }] },
  events: [{ text: "when is Ana's birthday?" }],
  checks: [
    { check: "tool_calls", tool: "search_notes", min: 1 },
    { check: "note_count", equals: 1 },
    {
      check: "reply_judged",
      rubric: [
        "The reply says that the birthday of Ana is on Friday.",
        "It names the source of the Note (the message that the Owner sent) and the date when the Note was captured.",
        "It is short plain text, like a text message, with no markdown, headings, or lists.",
      ].join("\n"),
    },
  ],
} satisfies EvalCaseFile;
