import type { LanguageModel } from "ai";
import { Context } from "effect";

export type ModelTask = "reply";

export class ModelProvider extends Context.Service<
  ModelProvider,
  { readonly languageModel: (task: ModelTask) => LanguageModel }
>()("ModelProvider") {}
