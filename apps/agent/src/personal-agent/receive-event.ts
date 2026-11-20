import { Effect, Option } from "effect";

import type { Event } from "../event.ts";
import { ProactiveMessages } from "../proactive/proactive-messages.ts";
import { AgentStorage } from "./agent-storage.ts";
import { Inbox } from "./inbox.ts";
import { OwnerChannelConversation } from "./owner-channel-conversation.ts";

export const receiveEvent = Effect.fnUntraced(function* receiveEvent(
  event: Event
) {
  const { database } = yield* AgentStorage;
  const inbox = yield* Inbox;
  const ownerConversation = yield* OwnerChannelConversation;
  const proactiveMessages = yield* ProactiveMessages;

  if (event._tag === "OwnerMessage") {
    yield* ownerConversation.remember(event);
  }
  yield* database.transaction(() =>
    Effect.gen(function* storeAndConnect() {
      const eventId = yield* inbox.storeEvent(event);
      if (event._tag === "OwnerMessage" && Option.isSome(eventId)) {
        yield* proactiveMessages.connect(eventId.value);
      }
    })
  );
});
