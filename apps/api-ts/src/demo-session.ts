import type { Pool } from "pg";
import { PostgresRiotOAuthStore, type ProductSession } from "./riot-oauth.js";

export const DEMO_USER_ID = "10000000-0000-4000-8000-000000000001";

export class DemoSessionError extends Error {
  constructor() {
    super("Demo fixture data is not available. Run npm run demo:seed --workspace=@valorant/api first.");
    this.name = "DemoSessionError";
  }
}

export class DemoSessionService {
  private readonly sessions: PostgresRiotOAuthStore;

  constructor(pool: Pool) {
    this.sessions = new PostgresRiotOAuthStore(pool);
  }

  async create(): Promise<ProductSession> {
    const session = await this.sessions.createSessionForUser(DEMO_USER_ID);
    if (!session) throw new DemoSessionError();
    return session;
  }
}
