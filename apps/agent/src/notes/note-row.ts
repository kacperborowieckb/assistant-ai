import type { notes } from "../personal-agent/storage-schema.ts";
import type { Note } from "./notes.ts";

export const toNote = (row: typeof notes.$inferSelect): Note => ({
  noteId: row.noteId,
  text: row.text,
  url: row.url ?? undefined,
  source: {
    channel: row.sourceChannel,
    conversationId: row.sourceConversationId,
    channelMessageId: row.sourceChannelMessageId,
  },
  trustLevel: row.trustLevel,
  capturedAt: row.capturedAt,
  lastCheckedAt: row.lastCheckedAt,
});
