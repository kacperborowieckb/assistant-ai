import type { EvalCaseFile } from "../eval-case.ts";

export default {
  description:
    "The Owner asks about a topic and then asks a follow-up about the result. The agent answers the follow-up from the result of its first search, with no second search.",
  seed: {
    notes: [
      { text: "Ana likes the colour red" },
      {
        text: "Gift idea for Ana: a red scarf",
        url: "https://example.com/red-scarf",
      },
    ],
  },
  events: [
    { text: "what do I know about Ana?" },
    { text: "which of those has a link?" },
  ],
  checks: [
    { check: "tool_calls", tool: "search_notes", min: 1, max: 1 },
    { check: "note_count", equals: 2 },
    {
      check: "reply_judged",
      rubric: [
        "The reply to the second message points to the gift idea for Ana (the red scarf) as the Note that has a link.",
        "It gives the link https://example.com/red-scarf, or says that the gift idea Note has it.",
        "It does not claim that the colour red Note has a link.",
        "It is short plain text, like a text message, with no markdown, headings, or lists.",
      ].join("\n"),
    },
  ],
} satisfies EvalCaseFile;
