import { MockLanguageModelV4 } from "ai/test";

export const fakeTelegramApiUrl = "https://telegram.fake";

export interface SentTelegramMessage {
  readonly url: string;
  readonly body: {
    readonly chat_id: number;
    readonly text: string;
    readonly parse_mode?: string;
    readonly reply_parameters: { readonly message_id: number };
  };
}

export type TelegramAnswer = "confirm" | "refuse";

const fakeTelegramState = {
  sent: [] as SentTelegramMessage[],
  answer: "confirm" as TelegramAnswer,
};

export const fakeTelegram = {
  get sent(): readonly SentTelegramMessage[] {
    return fakeTelegramState.sent;
  },
  answerWith: (answer: TelegramAnswer) => {
    fakeTelegramState.answer = answer;
  },
  fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    fakeTelegramState.sent.push({
      url: request.url,
      body: await request.json(),
    });
    if (fakeTelegramState.answer === "refuse") {
      return Response.json(
        { ok: false, description: "Bad Request: chat not found" },
        { status: 400 }
      );
    }
    return Response.json({
      ok: true,
      result: { message_id: 9000 + fakeTelegramState.sent.length },
    });
  },
};

export const fakeReplyPrefix = "You said: ";

const lastOwnerText = (
  prompt: MockLanguageModelV4["doGenerateCalls"][number]["prompt"]
) => {
  const message = prompt.findLast((candidate) => candidate.role === "user");
  const part = message?.content.find((candidate) => candidate.type === "text");
  return part?.type === "text" ? part.text : "";
};

let releaseModel = Promise.resolve();

export const fakeModel = new MockLanguageModelV4({
  provider: "fake",
  modelId: "fake-reply-model",
  doGenerate: async (options) => {
    await releaseModel;
    return {
      content: [
        {
          type: "text",
          text: `${fakeReplyPrefix}${lastOwnerText(options.prompt)}`,
        },
      ],
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 42, noCache: 30, cacheRead: 12, cacheWrite: 0 },
        outputTokens: { total: 7, text: 7, reasoning: 0 },
      },
      warnings: [],
    };
  },
});

export const holdModel = () => {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  releaseModel = promise;
  return () => resolve(undefined);
};

export const resetFakes = () => {
  fakeTelegramState.sent = [];
  fakeTelegramState.answer = "confirm";
  fakeModel.doGenerateCalls.length = 0;
  releaseModel = Promise.resolve();
};
