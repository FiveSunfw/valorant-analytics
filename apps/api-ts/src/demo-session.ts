import type { Pool } from "pg";
import { PostgresRiotOAuthStore, type ProductSession } from "./riot-oauth.js";
import { DEMO_FIXTURES, type DemoFixtureProfile } from "./demo-fixtures.js";

export { DEMO_USER_ID } from "./demo-fixtures.js";

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

  async create(profile: DemoFixtureProfile = "full"): Promise<ProductSession> {
    const session = await this.sessions.createSessionForUser(DEMO_FIXTURES[profile].userId);
    if (!session) throw new DemoSessionError();
    return session;
  }
}
