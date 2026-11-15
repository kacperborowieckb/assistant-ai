import type { EvalCaseFile } from "../eval-case.ts";

export default {
  description:
    "The Owner sends two related messages. The agent keeps two Notes and links the second to the first.",
  events: [
    { text: "Ana likes the colour red" },
    { text: "Ana's birthday is on Friday" },
  ],
  checks: [
    { check: "note_count", equals: 2 },
    { check: "link_count", equals: 1 },
    {
      check: "notes_linked",
      noteIncludes: ["birthday"],
      linkedNoteIncludes: ["red"],
    },
    { check: "tool_calls", tool: "capture_note", min: 2 },
    { check: "profile_entry_count", equals: 0 },
    {
      check: "reply_judged",
      rubric: [
        "The reply to the second message confirms that the agent kept the birthday of Ana on Friday.",
        "It says that the Note is linked to the other Note about Ana only if the agent really linked them.",
        "It is short plain text, like a text message, with no markdown, headings, or lists.",
      ].join("\n"),
    },
  ],
} satisfies EvalCaseFile;
