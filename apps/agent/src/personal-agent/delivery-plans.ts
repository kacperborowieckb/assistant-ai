import type { JournalEntry } from "../journal/journal.ts";

export const lastOf = <Tag extends JournalEntry["record"]["_tag"]>(
  entries: readonly JournalEntry[],
  tag: Tag
) => {
  const found = entries.findLast((entry) => entry.record._tag === tag);
  return found?.record as
    | Extract<JournalEntry["record"], { _tag: Tag }>
    | undefined;
};

const isReactionPlan = ({ record }: JournalEntry) =>
  record._tag === "ReplyPlanned" && record.reaction !== undefined;

export const textPlanOf = (entries: readonly JournalEntry[]) =>
  lastOf(
    entries.filter((entry) => !isReactionPlan(entry)),
    "ReplyPlanned"
  );

export const latestPlanOf = (entries: readonly JournalEntry[]) => {
  const latest = lastOf(entries, "ReplyPlanned");
  return {
    planned: latest?.reaction === undefined ? latest : undefined,
    reaction: latest?.reaction,
  };
};
