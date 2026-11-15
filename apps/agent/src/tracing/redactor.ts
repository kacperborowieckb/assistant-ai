import type { ModelMessage } from "ai";
import { Context, Layer, Schema } from "effect";

import { ModelMessageSchema } from "../model-gateway/model-message-schema.ts";

export const redactedMark = "[redacted]";

const makeRedactor = (secrets: readonly string[]) => {
  const present = secrets.filter((secret) => secret.length > 0);
  const redact = (text: string) => {
    let clean = text;
    for (const secret of present) {
      clean = clean.replaceAll(secret, redactedMark);
    }
    return clean;
  };
  const redactDeep = (value: unknown): unknown => {
    if (typeof value === "string") {
      return redact(value);
    }
    if (Array.isArray(value)) {
      return value.map(redactDeep);
    }
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, redactDeep(entry)])
      );
    }
    return value;
  };
  const redactMessage = (message: ModelMessage): ModelMessage =>
    Schema.decodeUnknownSync(ModelMessageSchema)(redactDeep(message));
  return { redact, redactMessage };
};

export class Redactor extends Context.Service<
  Redactor,
  ReturnType<typeof makeRedactor>
>()("Redactor") {
  static readonly layer = (secrets: readonly string[]) =>
    Layer.succeed(Redactor, makeRedactor(secrets));
}
