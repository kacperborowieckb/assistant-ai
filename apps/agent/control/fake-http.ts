import type { IncomingMessage, ServerResponse } from "node:http";

export const readBody = async (request: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf-8")) as unknown;
};

export const sendJson = (
  response: ServerResponse,
  status: number,
  body: unknown
) => {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
};
