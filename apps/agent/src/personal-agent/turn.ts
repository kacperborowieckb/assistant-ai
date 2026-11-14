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

const answer = (behavior: BehaviorConfig, event: InboxEvent) =>
  Effect.gen(function* answerEffect() {
    const inbox = yield* Inbox;
    const conversation = yield* Conversation;
    const journal = yield* Journal;
    const channel = yield* Channel;
    const modelGateway = yield* ModelGateway;

    const history = yield* conversation.recent;
    const reply = yield* modelGateway.generate({
      task: "reply",
      system: systemPrompt(behavior),
      messages: [...history, ownerMessage(event)].map(toModelMessage),
    });

    yield* journal.append({
      _tag: "ReplyPlanned",
      eventId: event.eventId,
      text: reply.text,
    });
    const delivery = yield* channel.send({
      conversationId: event.conversationId,
      inReplyTo: event.channelMessageId,
      text: reply.text,
    });

    if (delivery._tag === "Failed") {
      yield* journal.append({
        _tag: "ReplyFailed",
        eventId: event.eventId,
        reason: delivery.reason,
      });
      yield* inbox.markFailed([event]);
      return;
    }
    yield* journal.append({
      _tag: "ReplySent",
      eventId: event.eventId,
      channelMessageId: delivery.channelMessageId,
    });
    yield* conversation.append([
      ownerMessage(event),
      { role: "agent", text: reply.text },
    ]);
    yield* inbox.markDone([event]);
  });

export const takeTurn = (behavior: BehaviorConfig) =>
  Effect.gen(function* takeTurnEffect() {
    const inbox = yield* Inbox;
    const events = yield* inbox.pending;
    for (const event of events) {
      yield* answer(behavior, event);
    }
  });
