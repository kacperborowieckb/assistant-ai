import { modelMessageSchema } from "ai";
import type { ModelMessage } from "ai";
import { Schema } from "effect";

const isModelMessage = (value: unknown): value is ModelMessage =>
  modelMessageSchema.safeParse(value).success;

export const ModelMessageSchema = Schema.declare(isModelMessage);

export const ModelMessageJsonSchema = Schema.fromJsonString(ModelMessageSchema);
