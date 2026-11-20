import type { JournalEntry } from "../journal/journal.ts";
import type { ProactiveOutcome } from "../personal-agent/storage-values.ts";

const changesOpenLoopOf = (
  openLoopIds: readonly string[],
  entry: JournalEntry
) => {
  const { record } = entry;
  switch (record._tag) {
    case "OpenLoopOpened":
    case "OpenLoopChanged":
    case "OpenLoopClosed": {
      return openLoopIds.includes(record.noteId);
    }
    default: {
      return false;
    }
  }
};

const mutesInTurn = (entry: JournalEntry) =>
  entry.record._tag === "ProactiveMuteChanged" &&
  entry.record.change === "muted";

export const outcomeOfConnectedTurn = (
  openLoopIds: readonly string[],
  entriesOfTurn: readonly JournalEntry[]
): ProactiveOutcome => {
  if (entriesOfTurn.some((entry) => changesOpenLoopOf(openLoopIds, entry))) {
    return "acted";
  }
  return entriesOfTurn.some(mutesInTurn) ? "muted" : "replied";
};
