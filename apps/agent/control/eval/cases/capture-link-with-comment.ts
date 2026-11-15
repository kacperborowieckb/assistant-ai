import type { EvalCaseFile } from "../eval-case.ts";

export default {
  description:
    "The Owner sends a link with a comment. The agent keeps one Note that has the link as its URL and the comment as its text, and confirms it in one short reply.",
  events: [
    {
      text: "https://example.com/rust-async this explains async Rust well, read it before the Monday review",
    },
  ],
  checks: [
    { check: "note_count", equals: 1 },
    {
      check: "note_matches",
      textIncludes: ["async", "Monday"],
      url: "https://example.com/rust-async",
      trustLevel: "owner",
    },
    { check: "tool_calls", tool: "capture_note", min: 1 },
    { check: "profile_entry_count", equals: 0 },
    {
      check: "reply_judged",
      rubric: [
        "The reply confirms that the agent kept the link with the comment.",
        "It does not claim that it set a Reminder or kept anything else.",
        "It is short plain text, like a text message, with no markdown, headings, or lists.",
      ].join("\n"),
    },
  ],
} satisfies EvalCaseFile;
