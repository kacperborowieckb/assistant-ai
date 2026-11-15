import type { ModelMessage } from "ai";

import type { InboxEvent } from "./inbox.ts";

export const ownerMessage = (event: InboxEvent): ModelMessage => ({
  role: "user",
  content: event.text,
});
