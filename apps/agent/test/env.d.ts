import type { D1Migration } from "cloudflare:test";

declare module "vitest" {
  interface ProvidedContext {
    directoryMigrations: D1Migration[];
  }
}
