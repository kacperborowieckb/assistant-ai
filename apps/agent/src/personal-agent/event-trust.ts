import type { TrustLevel } from "../notes/note.ts";
import type { InboxEvent } from "./inbox.ts";

export const trustLevelOfEvent = (event: InboxEvent): TrustLevel =>
  event._tag === "OwnerMessage" && event.forwardOrigin !== undefined
    ? "untrusted"
    : "owner";
