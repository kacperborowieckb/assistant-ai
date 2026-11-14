import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  driver: "durable-sqlite",
  schema: "./src/personal-agent/storage-schema.ts",
  out: "./src/personal-agent/migrations",
});
