import { Context } from "effect";

export class AgentStorage extends Context.Service<
  AgentStorage,
  { readonly sql: SqlStorage }
>()("PersonalAgent/AgentStorage") {}
