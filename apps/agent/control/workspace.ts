import nodePath from "node:path";
import { fileURLToPath } from "node:url";

export const agentRoot = fileURLToPath(new URL("..", import.meta.url));

export const wranglerConfigPath = nodePath.join(agentRoot, "wrangler.jsonc");
