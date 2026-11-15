import { Effect } from "effect";

import { normalizeNoteText } from "./note.ts";

export const hashOfNoteText = (text: string) =>
  Effect.promise(async () => {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(normalizeNoteText(text))
    );
    return Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("");
  });
