import type { FakeTelegramChatAction } from "./fake-chat-actions.ts";
import type { FakeTelegramReaction } from "./fake-reaction.ts";
import type { FakeModelCall } from "./local-fakes.ts";

export const renderChatActions = (
  chatActions: readonly FakeTelegramChatAction[],
  outcome = "the reply"
) =>
  chatActions.length === 0
    ? `Telegram sendChatAction: none before ${outcome}`
    : `Telegram sendChatAction before ${outcome}: ${chatActions
        .map(
          (chatAction) => `"${chatAction.action}" to chat ${chatAction.chatId}`
        )
        .join(", ")}`;

const staySilentToolName = "stay_silent";

const stayedSilentOn = (
  modelCalls: readonly FakeModelCall[],
  message: string
) =>
  modelCalls
    .findLast((call) => call.lastUserMessage === message)
    ?.toolCalls.includes(staySilentToolName) === true;

const reactionOn = (
  reactions: readonly FakeTelegramReaction[],
  messageId: number
) => reactions.findLast((reaction) => reaction.messageId === messageId);

interface AnswerWithoutText {
  readonly calls: readonly FakeModelCall[];
  readonly message: string;
  readonly reactions: readonly FakeTelegramReaction[];
  readonly messageId: number;
}

export const answeredWithoutText = ({
  calls,
  message,
  reactions,
  messageId,
}: AnswerWithoutText) =>
  stayedSilentOn(calls, message) ||
  reactionOn(reactions, messageId) !== undefined;

export const renderAnswerWithoutText = ({
  calls,
  message,
  reactions,
  messageId,
  chatActions,
}: AnswerWithoutText & {
  readonly chatActions: readonly FakeTelegramChatAction[];
}) => {
  const reaction = reactionOn(reactions, messageId);
  if (reaction !== undefined) {
    return [
      renderChatActions(chatActions, "the reaction"),
      `Telegram setMessageReaction on message ${reaction.messageId} in chat ${reaction.chatId}: "${reaction.emoji}"`,
    ];
  }
  return stayedSilentOn(calls, message)
    ? [
        renderChatActions(chatActions, "the silence"),
        `No Telegram send for the message "${message}": the agent stayed silent (${staySilentToolName})`,
      ]
    : undefined;
};
