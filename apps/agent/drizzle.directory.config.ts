import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/directory/directory-schema.ts",
  out: "./src/directory/migrations",
});
