import type { OwnerMessage } from "../event.ts";
import type { InboxEvent } from "../personal-agent/inbox.ts";
import type { trustLevels } from "../personal-agent/storage-schema.ts";

export type TrustLevel = (typeof trustLevels)[number];

export interface NoteSource {
  readonly eventId: string;
  readonly channel: OwnerMessage["channel"];
  readonly conversationId: string;
  readonly channelMessageId: string;
  readonly trustLevel: TrustLevel;
}

export const noteSourceOfOwnerEvent = (event: InboxEvent): NoteSource => ({
  eventId: event.eventId,
  channel: event.channel,
  conversationId: event.conversationId,
  channelMessageId: event.channelMessageId,
  trustLevel: "owner",
});

export const normalizeNoteText = (text: string) =>
  text.normalize("NFKC").trim().replaceAll(/\s+/gu, " ").toLowerCase();
