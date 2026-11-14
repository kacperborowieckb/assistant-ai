import { sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";

export const valueIn = (column: SQLWrapper, values: readonly string[]) =>
  sql`${column} IN (${sql.raw(values.map((value) => `'${value}'`).join(", "))})`;
