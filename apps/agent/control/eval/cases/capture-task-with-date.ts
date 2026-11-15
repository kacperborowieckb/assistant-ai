import type { EvalCaseFile } from "../eval-case.ts";

export default {
  description:
    "The Owner sends a task with a date. The agent keeps it as one Note in the Owner's words and confirms it in one short reply.",
  events: [{ text: "buy a gift for Ana before Friday" }],
  checks: [
    { check: "note_count", equals: 1 },
    {
      check: "note_matches",
      textIncludes: ["gift", "Ana", "Friday"],
      trustLevel: "owner",
    },
    { check: "tool_calls", tool: "capture_note", min: 1 },
    { check: "profile_entry_count", equals: 0 },
    {
      check: "reply_judged",
      rubric: [
        "The reply confirms that the agent kept the task to buy a gift for Ana before Friday.",
        "It does not claim that it set a Reminder or kept anything else.",
        "It is short plain text, like a text message, with no markdown, headings, or lists.",
      ].join("\n"),
    },
  ],
} satisfies EvalCaseFile;
