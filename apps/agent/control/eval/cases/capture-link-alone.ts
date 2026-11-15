import type { EvalCaseFile } from "../eval-case.ts";

export default {
  description:
    "The Owner sends a link with no comment. The agent keeps one Note that has the link as its URL, and confirms it in one short reply.",
  events: [{ text: "https://example.com/sourdough-starter" }],
  checks: [
    { check: "note_count", equals: 1 },
    {
      check: "note_matches",
      textIncludes: ["sourdough"],
      url: "https://example.com/sourdough-starter",
      trustLevel: "owner",
    },
    { check: "tool_calls", tool: "capture_note", min: 1 },
    { check: "profile_entry_count", equals: 0 },
    {
      check: "reply_judged",
      rubric: [
        "The reply confirms that the agent kept the link.",
        "It does not invent a summary or a comment about the page, because the agent did not open it.",
        "It is short plain text, like a text message, with no markdown, headings, or lists.",
      ].join("\n"),
    },
  ],
} satisfies EvalCaseFile;
