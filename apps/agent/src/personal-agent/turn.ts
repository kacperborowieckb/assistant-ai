import type { ModelMessage } from "ai";
import { Effect } from "effect";

import type { BehaviorConfig } from "../behavior/behavior-config.ts";
import { Channel } from "../channels/channel.ts";
import { Journal } from "../journal/journal.ts";
import { ModelGateway } from "../model-gateway/model-gateway.ts";
import { Conversation } from "./conversation.ts";
import type { ConversationMessage } from "./conversation.ts";
import { Inbox } from "./inbox.ts";
import type { InboxEvent } from "./inbox.ts";

export const systemPrompt = (behavior: BehaviorConfig) =>
  [
    "You are the Owner's Personal Agent. You talk with the Owner in a chat.",
    "Answer the Owner's newest messages. Be honest when you do not know something.",
    behavior.textingStyle,
  ].join("\n");

const toModelMessage = (message: ConversationMessage): ModelMessage =>
  message.role === "owner"
    ? { role: "user", content: message.text }
    : { role: "assistant", content: message.text };

const ownerMessage = (event: InboxEvent): ConversationMessage => ({
  role: "owner",
  text: event.text,
});

export const takeTurn = (behavior: BehaviorConfig) =>
  Effect.gen(function* takeTurnEffect() {
    const inbox = yield* Inbox;
    const events = yield* inbox.pending;
    const answered = events.at(-1);
    if (answered === undefined) {
      return;
    }
    const conversation = yield* Conversation;
    const journal = yield* Journal;
    const channel = yield* Channel;
    const modelGateway = yield* ModelGateway;

    const history = yield* conversation.recent;
    const reply = yield* modelGateway.generate({
      task: "reply",
      system: systemPrompt(behavior),
      messages: [...history, ...events.map(ownerMessage)].map(toModelMessage),
    });

    yield* journal.append({
      _tag: "ReplyPlanned",
      eventId: answered.eventId,
      text: reply.text,
    });
    const delivery = yield* channel.send({
      conversationId: answered.conversationId,
      inReplyTo: answered.channelMessageId,
      text: reply.text,
    });

    if (delivery._tag === "Failed") {
      yield* journal.append({
        _tag: "ReplyFailed",
        eventId: answered.eventId,
        reason: delivery.reason,
      });
      yield* inbox.markFailed(events);
      return;
    }
    yield* journal.append({
      _tag: "ReplySent",
      eventId: answered.eventId,
      channelMessageId: delivery.channelMessageId,
    });
    yield* conversation.append([
      ...events.map(ownerMessage),
      { role: "agent", text: reply.text },
    ]);
    yield* inbox.markDone(events);
  });
