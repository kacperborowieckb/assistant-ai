import { Context, Layer } from "effect";

export class AgentStorage extends Context.Service<
  AgentStorage,
  { readonly sql: SqlStorage }
>()("PersonalAgent/AgentStorage") {
  static readonly layer = (
    storage: DurableObjectStorage,
    schema: readonly string[]
  ) =>
    Layer.sync(AgentStorage, () => {
      for (const statement of schema) {
        storage.sql.exec(statement);
      }
      return { sql: storage.sql };
    });
}
