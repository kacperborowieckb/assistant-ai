import type { notes } from "../personal-agent/storage-schema.ts";
import type { Note } from "./notes.ts";
import { openLoopOfColumns } from "./open-loop.ts";

export const toNote = (row: typeof notes.$inferSelect): Note => ({
  noteId: row.noteId,
  text: row.text,
  url: row.url ?? undefined,
  source: {
    channel: row.sourceChannel,
    conversationId: row.sourceConversationId,
    channelMessageId: row.sourceChannelMessageId,
    forwardOrigin: row.sourceForwardOrigin ?? undefined,
  },
  trustLevel: row.trustLevel,
  capturedAt: row.capturedAt,
  lastCheckedAt: row.lastCheckedAt,
  openLoop: openLoopOfColumns({
    openLoopKind: row.openLoopKind,
    openLoopState: row.openLoopState,
    openLoopClosedReason: row.openLoopClosedReason,
    openLoopDueAt: row.openLoopDueAt,
  }),
});
