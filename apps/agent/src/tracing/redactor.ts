import { Context, Layer } from "effect";

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
  return { redact };
};

export class Redactor extends Context.Service<
  Redactor,
  ReturnType<typeof makeRedactor>
>()("Redactor") {
  static readonly layer = (secrets: readonly string[]) =>
    Layer.succeed(Redactor, makeRedactor(secrets));
}
