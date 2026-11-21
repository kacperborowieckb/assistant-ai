import { MockLanguageModelV4 } from "ai/test";

export const fakeTelegramApiUrl = "https://telegram.fake";

export const testTypingRepeatMillis = 100;

export interface SentTelegramMessage {
  readonly url: string;
  readonly body: {
    readonly chat_id: number;
    readonly text: string;
    readonly parse_mode?: string;
    readonly reply_parameters?: { readonly message_id: number };
  };
}

export interface TelegramReaction {
  readonly chatId: number;
  readonly messageId: number;
  readonly emoji: string;
  readonly chatActionsBefore: number;
}

export type TelegramAnswer =
  | "confirm"
  | "refuse"
  | "lose-confirmation"
  | "lose-first-reaction-confirmation";

export interface TelegramChatAction {
  readonly chatId: number;
  readonly action: string;
  readonly at: number;
}

export type ChatActionAnswer = "confirm" | "refuse" | "hang" | "hang-first";

const fakeTelegramState = {
  sent: [] as SentTelegramMessage[],
  reactions: [] as TelegramReaction[],
  answer: "confirm" as TelegramAnswer,
  chatActions: [] as TelegramChatAction[],
  chatActionAnswer: "confirm" as ChatActionAnswer,
  chatActionsAtModelCalls: [] as number[],
  chatActionsAtSends: [] as number[],
  sendDelayMillis: 0,
};

const answerChatAction = async (request: Request) => {
  const recorded = { chatId: 0, action: "", at: Date.now() };
  fakeTelegramState.chatActions.push(recorded);
  const body = await request.json<{ chat_id: number; action: string }>();
  recorded.chatId = body.chat_id;
  recorded.action = body.action;
  if (
    fakeTelegramState.chatActionAnswer === "hang" ||
    (fakeTelegramState.chatActionAnswer === "hang-first" &&
      fakeTelegramState.chatActions.length === 1)
  ) {
    return Promise.withResolvers<Response>().promise;
  }
  if (fakeTelegramState.chatActionAnswer === "refuse") {
    return Response.json(
      { ok: false, description: "Forbidden: bot was blocked by the user" },
      { status: 403 }
    );
  }
  return Response.json({ ok: true, result: true });
};

const answerReaction = async (request: Request) => {
  const body = await request.json<{
    chat_id: number;
    message_id: number;
    reaction: readonly { readonly emoji: string }[];
  }>();
  fakeTelegramState.reactions.push({
    chatId: body.chat_id,
    messageId: body.message_id,
    emoji: body.reaction.map((reaction) => reaction.emoji).join(""),
    chatActionsBefore: fakeTelegramState.chatActions.length,
  });
  if (fakeTelegramState.sendDelayMillis > 0) {
    await scheduler.wait(fakeTelegramState.sendDelayMillis);
  }
  if (
    fakeTelegramState.answer === "lose-confirmation" ||
    (fakeTelegramState.answer === "lose-first-reaction-confirmation" &&
      fakeTelegramState.reactions.length === 1)
  ) {
    throw new TypeError("The connection dropped before Telegram answered");
  }
  if (fakeTelegramState.answer === "refuse") {
    return Response.json(
      { ok: false, description: "Bad Request: REACTION_INVALID" },
      { status: 400 }
    );
  }
  return Response.json({ ok: true, result: true });
};

export const fakeTelegram = {
  get sent(): readonly SentTelegramMessage[] {
    return fakeTelegramState.sent;
  },
  get reactions(): readonly TelegramReaction[] {
    return fakeTelegramState.reactions;
  },
  get chatActions(): readonly TelegramChatAction[] {
    return fakeTelegramState.chatActions;
  },
  get chatActionsAtModelCalls(): readonly number[] {
    return fakeTelegramState.chatActionsAtModelCalls;
  },
  get chatActionsAtSends(): readonly number[] {
    return fakeTelegramState.chatActionsAtSends;
  },
  answerWith: (answer: TelegramAnswer) => {
    fakeTelegramState.answer = answer;
  },
  delaySendsBy: (millis: number) => {
    fakeTelegramState.sendDelayMillis = millis;
  },
  answerChatActionsWith: (answer: ChatActionAnswer) => {
    fakeTelegramState.chatActionAnswer = answer;
  },
  fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url.endsWith("/sendChatAction")) {
      return answerChatAction(request);
    }
    if (request.url.endsWith("/setMessageReaction")) {
      return answerReaction(request);
    }
    fakeTelegramState.chatActionsAtSends.push(
      fakeTelegramState.chatActions.length
    );
    fakeTelegramState.sent.push({
      url: request.url,
      body: await request.json(),
    });
    if (fakeTelegramState.sendDelayMillis > 0) {
      await scheduler.wait(fakeTelegramState.sendDelayMillis);
    }
    if (fakeTelegramState.answer === "lose-confirmation") {
      throw new TypeError("The connection dropped before Telegram answered");
    }
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

const recordedDataPoints: AnalyticsEngineDataPoint[] = [];

const metricsState = { failing: false };

export const fakeMetrics = {
  get dataPoints(): readonly AnalyticsEngineDataPoint[] {
    return recordedDataPoints;
  },
  failWrites: () => {
    metricsState.failing = true;
  },
  dataset: {
    writeDataPoint: (dataPoint?: AnalyticsEngineDataPoint) => {
      if (metricsState.failing) {
        throw new Error("Analytics Engine is down");
      }
      if (dataPoint !== undefined) {
        recordedDataPoints.push(dataPoint);
      }
    },
  } satisfies AnalyticsEngineDataset,
};

export const fakeReplyPrefix = "You said: ";

const lastOwnerText = (
  prompt: MockLanguageModelV4["doGenerateCalls"][number]["prompt"]
) => {
  const message = prompt.findLast((candidate) => candidate.role === "user");
  const part = message?.content.find((candidate) => candidate.type === "text");
  return part?.type === "text" ? part.text : "";
};

export type ScriptedModelStep =
  | { readonly say: string }
  | { readonly error: string }
  | {
      readonly callTool: string;
      readonly times?: number;
      readonly input:
        | Record<string, unknown>
        | ((
            previousToolOutput: Record<string, unknown>
          ) => Record<string, unknown>);
    };

type ModelPrompt = MockLanguageModelV4["doGenerateCalls"][number]["prompt"];

const lastToolOutput = (prompt: ModelPrompt): Record<string, unknown> => {
  const message = prompt.findLast((candidate) => candidate.role === "tool");
  const part = message?.content.find(
    (candidate) => candidate.type === "tool-result"
  );
  return part?.type === "tool-result" &&
    part.output.type === "json" &&
    typeof part.output.value === "object" &&
    part.output.value !== null &&
    !Array.isArray(part.output.value)
    ? { ...part.output.value }
    : {};
};

const modelScript: ScriptedModelStep[] = [];

export const scriptModel = (steps: readonly ScriptedModelStep[]) => {
  modelScript.splice(0, modelScript.length, ...steps);
};

const scriptedContent = (
  step: Exclude<ScriptedModelStep, { readonly error: string }>,
  prompt: ModelPrompt
) =>
  "say" in step
    ? ([{ type: "text", text: step.say }] as const)
    : Array.from({ length: step.times ?? 1 }, (_, index) => ({
        type: "tool-call" as const,
        toolCallId: `call-${modelScript.length}${index === 0 ? "" : `-${index}`}`,
        toolName: step.callTool,
        input: JSON.stringify(
          typeof step.input === "function"
            ? step.input(lastToolOutput(prompt))
            : step.input
        ),
      }));

const defaultModelFailureMessage = "The model provider is down";

const modelFailure = { remaining: 0, message: defaultModelFailureMessage };

let releaseModel = Promise.resolve();
let callsBeforeHold = 0;

export const fakeModel = new MockLanguageModelV4({
  provider: "fake",
  modelId: "fake-reply-model",
  doGenerate: async (options) => {
    fakeTelegramState.chatActionsAtModelCalls.push(
      fakeTelegramState.chatActions.length
    );
    if (fakeModel.doGenerateCalls.length > callsBeforeHold) {
      await releaseModel;
    }
    if (modelFailure.remaining > 0) {
      modelFailure.remaining -= 1;
      throw new Error(modelFailure.message);
    }
    const scripted = modelScript.shift();
    if (scripted !== undefined && "error" in scripted) {
      throw new Error(scripted.error);
    }
    const callsTool = scripted !== undefined && "callTool" in scripted;
    return {
      content:
        scripted === undefined
          ? [
              {
                type: "text",
                text: `${fakeReplyPrefix}${lastOwnerText(options.prompt)}`,
              },
            ]
          : [...scriptedContent(scripted, options.prompt)],
      finishReason: callsTool
        ? { unified: "tool-calls", raw: "tool_calls" }
        : { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 42, noCache: 30, cacheRead: 12, cacheWrite: 0 },
        outputTokens: { total: 7, text: 7, reasoning: 0 },
      },
      warnings: [],
    };
  },
});

export const holdModel = (answeredCalls = 0) => {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  releaseModel = promise;
  callsBeforeHold = answeredCalls;
  return () => resolve(undefined);
};

export const failModel = (
  times: number,
  message = defaultModelFailureMessage
) => {
  modelFailure.remaining = times;
  modelFailure.message = message;
};

export const fakeTool = {
  name: "keep_note",
  kept: [] as string[],
  failWith: undefined as string | undefined,
};

export const defaultTestMaxRestarts = 2;

export const fakeBurstWait = {
  quietMillis: 0,
  maxWaitMillis: 0,
  maxRestarts: defaultTestMaxRestarts,
};

export const resetFakes = () => {
  fakeBurstWait.quietMillis = 0;
  fakeBurstWait.maxWaitMillis = 0;
  fakeBurstWait.maxRestarts = defaultTestMaxRestarts;
  modelScript.length = 0;
  fakeTool.kept = [];
  fakeTool.failWith = undefined;
  modelFailure.remaining = 0;
  modelFailure.message = defaultModelFailureMessage;
  recordedDataPoints.length = 0;
  metricsState.failing = false;
  fakeTelegramState.sent = [];
  fakeTelegramState.reactions = [];
  fakeTelegramState.answer = "confirm";
  fakeTelegramState.chatActions = [];
  fakeTelegramState.chatActionAnswer = "confirm";
  fakeTelegramState.chatActionsAtModelCalls = [];
  fakeTelegramState.chatActionsAtSends = [];
  fakeTelegramState.sendDelayMillis = 0;
  fakeModel.doGenerateCalls.length = 0;
  releaseModel = Promise.resolve();
  callsBeforeHold = 0;
};
