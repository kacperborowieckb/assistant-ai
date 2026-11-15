import { Option, Schema } from "effect";
import { unstable_getVarsForDev } from "wrangler";

import { wranglerConfigPath } from "./workspace.ts";

const isNonEmpty = (value: string) => value.length > 0;

const DevVarSchema = Schema.Struct({ value: Schema.String });

const devVarValue = (name: string) =>
  Schema.decodeUnknownOption(DevVarSchema)(
    unstable_getVarsForDev(wranglerConfigPath, undefined, {}, undefined, true, {
      required: [name],
    })[name]
  ).pipe(Option.map((devVar) => devVar.value));

export const localValue = (name: string) =>
  Option.fromNullishOr(process.env[name]).pipe(
    Option.filter(isNonEmpty),
    Option.orElse(() => devVarValue(name)),
    Option.filter(isNonEmpty)
  );
