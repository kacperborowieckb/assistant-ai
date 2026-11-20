import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  driver: "durable-sqlite",
  schema: [
    "./src/personal-agent/storage-schema.ts",
    "./src/preferences/preferences-schema.ts",
    "./src/proactive/proactive-schema.ts",
    "./src/schedule/schedule-open-loops-schema.ts",
  ],
  out: "./src/personal-agent/migrations",
});
