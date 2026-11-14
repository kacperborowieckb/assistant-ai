import { runWranglerAttached } from "./wrangler.ts";

export const runLocalWorker = runWranglerAttached([
  "dev",
  "--local",
  "--persist-to",
  ".wrangler/state",
]);
