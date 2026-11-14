import type { ModelMessage } from "ai";
import { Effect } from "effect";

import type { BehaviorConfig } from "../behavior/behavior-config.ts";
import { Channel } from "../channels/channel.ts";
import { Journal } from "../journal/journal.ts";
import { ModelGateway, modelAttempts } from "../model-gateway/model-gateway.ts";
import type { ModelUnavailable } from "../model-gateway/model-unavailable.ts";
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

export const honestFailureText =
  "Sorry, I could not answer that. Please try again in a moment.";

const deliver = (event: InboxEvent, text: string) =>
  Effect.gen(function* deliverEffect() {
    const journal = yield* Journal;
    const channel = yield* Channel;

    yield* journal.append({
      _tag: "ReplyPlanned",
      eventId: event.eventId,
      text,
    });
    yield* journal.append({ _tag: "SendStarted", eventId: event.eventId });
    const delivery = yield* channel.send({
      conversationId: event.conversationId,
      inReplyTo: event.channelMessageId,
      text,
    });

    if (delivery._tag === "Failed") {
      yield* journal.append({
        _tag: "ReplyFailed",
        eventId: event.eventId,
        reason: delivery.reason,
      });
      return delivery;
    }
    yield* journal.append({
      _tag: "ReplySent",
      eventId: event.eventId,
      channelMessageId: delivery.channelMessageId,
    });
    return delivery;
  });

const recordTurnFailed = (event: InboxEvent, reason: string) =>
  Effect.gen(function* recordTurnFailedEffect() {
    const inbox = yield* Inbox;
    const journal = yield* Journal;

    yield* journal.append({
      _tag: "TurnFailed",
      eventId: event.eventId,
      reason,
    });
    yield* inbox.markFailed([event]);
  });

const sendHonestFailure = (event: InboxEvent) =>
  Effect.gen(function* sendHonestFailureEffect() {
    const inbox = yield* Inbox;

    yield* deliver(event, honestFailureText);
    yield* inbox.markFailed([event]);
  });

const failTurnWithHonestMessage = (event: InboxEvent, reason: string) =>
  Effect.gen(function* failTurnWithHonestMessageEffect() {
    const journal = yield* Journal;

    yield* journal.append({
      _tag: "TurnFailed",
      eventId: event.eventId,
      reason,
    });
    yield* sendHonestFailure(event);
  });

const modelFailureReason = (error: ModelUnavailable) =>
  `The model failed ${modelAttempts} times: ${String(error.cause)}`;

const answer = (behavior: BehaviorConfig, event: InboxEvent) =>
  Effect.gen(function* answerEffect() {
    const inbox = yield* Inbox;
    const conversation = yield* Conversation;
    const modelGateway = yield* ModelGateway;

    const history = yield* conversation.recent;
    const reply = yield* modelGateway
      .generate({
        task: "reply",
        system: systemPrompt(behavior),
        messages: [...history, ownerMessage(event)].map(toModelMessage),
      })
      .pipe(
        Effect.catchTag("ModelUnavailable", (error) =>
          failTurnWithHonestMessage(event, modelFailureReason(error)).pipe(
            Effect.as(undefined)
          )
        )
      );

    if (reply === undefined) {
      return;
    }
    const delivery = yield* deliver(event, reply.text);
    if (delivery._tag === "Failed") {
      yield* recordTurnFailed(event, delivery.reason);
      return;
    }
    yield* conversation.append([
      ownerMessage(event),
      { role: "agent", text: reply.text },
    ]);
    yield* inbox.markDone([event]);
  });

export const unconfirmedSendReason =
  "A send started but Telegram did not confirm it, so the agent did not send again";

const settleFromJournal = (event: InboxEvent) =>
  Effect.gen(function* settleFromJournalEffect() {
    const inbox = yield* Inbox;
    const journal = yield* Journal;
    const entries = yield* journal.readForEvent(event.eventId);
    const tags = new Set(entries.map((entry) => entry.record._tag));

    if (tags.has("TurnFailed")) {
      yield* tags.has("SendStarted")
        ? inbox.markFailed([event])
        : sendHonestFailure(event);
      return "settled" as const;
    }
    if (tags.has("ReplySent")) {
      yield* inbox.markDone([event]);
      return "settled" as const;
    }
    const failedSend = entries.find(
      (entry) => entry.record._tag === "ReplyFailed"
    );
    if (failedSend?.record._tag === "ReplyFailed") {
      yield* recordTurnFailed(event, failedSend.record.reason);
      return "settled" as const;
    }
    if (tags.has("SendStarted")) {
      yield* journal.append({
        _tag: "ReplyFailed",
        eventId: event.eventId,
        reason: unconfirmedSendReason,
      });
      yield* recordTurnFailed(event, unconfirmedSendReason);
      return "settled" as const;
    }
    return "unanswered" as const;
  });

export const takeTurn = (behavior: BehaviorConfig) =>
  Effect.gen(function* takeTurnEffect() {
    const inbox = yield* Inbox;
    const events = yield* inbox.pending;
    for (const event of events) {
      const outcome = yield* settleFromJournal(event);
      if (outcome === "unanswered") {
        yield* answer(behavior, event);
      }
    }
  });
