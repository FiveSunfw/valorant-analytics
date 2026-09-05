import { Pool } from "pg";
import { migrate } from "./migration.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgresql://valorant:valorant_dev@127.0.0.1:15432/valorant";

const pool = new Pool({ connectionString: databaseUrl });
try {
  await migrate(pool);
  console.info("database migrations complete");
} finally {
  await pool.end();
}
