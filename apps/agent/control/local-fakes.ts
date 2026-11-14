import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { Effect, Queue, Schema } from "effect";

export const fakeReplyPrefix = "You said: ";

export interface FakeTelegramMessage {
  readonly chatId: number;
  readonly text: string;
  readonly replyToMessageId: number | undefined;
}

export interface FakeModelCall {
  readonly gatewayId: string | undefined;
  readonly metadata: string | undefined;
  readonly collectLogPayload: string | undefined;
}

const SendMessageBodySchema = Schema.Struct({
  chat_id: Schema.Number,
  text: Schema.String,
  reply_parameters: Schema.optionalKey(
    Schema.Struct({ message_id: Schema.Number })
  ),
});

const ChatCompletionBodySchema = Schema.Struct({
  model: Schema.String,
  messages: Schema.Array(
    Schema.Struct({ role: Schema.String, content: Schema.Unknown })
  ),
});

const readBody = async (request: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf-8")) as unknown;
};

const sendJson = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
};

const lastOwnerText = (
  messages: (typeof ChatCompletionBodySchema.Type)["messages"]
) => {
  const content = messages.findLast(
    (message) => message.role === "user"
  )?.content;
  return typeof content === "string" ? content : "";
};

const headerValue = (request: IncomingMessage, name: string) => {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
};

const sendMessagePath = /^\/telegram\/bot[^/]+\/sendMessage$/u;
const chatCompletionsPath = "/ai-gateway/chat/completions";

export const startLocalFakes = Effect.gen(function* startLocalFakesEffect() {
  const telegramMessages = yield* Queue.unbounded<FakeTelegramMessage>();
  const modelCalls: FakeModelCall[] = [];
  let nextMessageId = 1;

  const answerSendMessage = (body: unknown, response: ServerResponse) => {
    const message = Schema.decodeUnknownSync(SendMessageBodySchema)(body);
    Queue.offerUnsafe(telegramMessages, {
      chatId: message.chat_id,
      text: message.text,
      replyToMessageId: message.reply_parameters?.message_id,
    });
    nextMessageId += 1;
    sendJson(response, 200, {
      ok: true,
      result: { message_id: nextMessageId },
    });
  };

  const answerChatCompletion = (
    request: IncomingMessage,
    body: unknown,
    response: ServerResponse
  ) => {
    const completion = Schema.decodeUnknownSync(ChatCompletionBodySchema)(body);
    modelCalls.push({
      gatewayId: headerValue(request, "cf-aig-gateway-id"),
      metadata: headerValue(request, "cf-aig-metadata"),
      collectLogPayload: headerValue(request, "cf-aig-collect-log-payload"),
    });
    sendJson(response, 200, {
      id: `fake-completion-${modelCalls.length}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: completion.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: `${fakeReplyPrefix}${lastOwnerText(completion.messages)}`,
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
    });
  };

  const server = createServer(async (request, response) => {
    try {
      const body = await readBody(request);
      if (sendMessagePath.test(request.url ?? "")) {
        answerSendMessage(body, response);
        return;
      }
      if (request.url === chatCompletionsPath) {
        answerChatCompletion(request, body, response);
        return;
      }
      sendJson(response, 404, { ok: false, description: "Not Found" });
    } catch (error) {
      sendJson(response, 400, { ok: false, description: String(error) });
    }
  });

  const port = yield* Effect.acquireRelease(
    Effect.promise(async () => {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        throw new Error("The local fakes have no port");
      }
      return address.port;
    }),
    () =>
      Effect.promise(async () => {
        server.close();
        await once(server, "close");
      })
  );
  const origin = `http://127.0.0.1:${port}`;

  return {
    telegramApiUrl: `${origin}/telegram`,
    aiGatewayUrl: `${origin}/ai-gateway`,
    nextTelegramMessage: Queue.take(telegramMessages),
    modelCalls: () => [...modelCalls],
  };
});
