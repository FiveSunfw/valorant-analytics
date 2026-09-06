export type SqlExecutor = {
  query(sql: string, values?: readonly unknown[]): Promise<{ rowCount: number | null }>;
};

const migrations = [{
  id: "20260905_0002",
  statements: [
    `CREATE TABLE IF NOT EXISTS users (id UUID PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS riot_accounts (id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, rso_subject VARCHAR(255) NOT NULL UNIQUE, puuid VARCHAR(128) NOT NULL UNIQUE, game_name VARCHAR(64), tag_line VARCHAR(16), platform VARCHAR(16) NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS riot_tokens (id UUID PRIMARY KEY, riot_account_id UUID NOT NULL UNIQUE REFERENCES riot_accounts(id) ON DELETE CASCADE, encrypted_access_token BYTEA NOT NULL, encrypted_refresh_token BYTEA, access_token_expires_at TIMESTAMPTZ, scopes JSONB NOT NULL DEFAULT '[]'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS matches (match_id VARCHAR(128) PRIMARY KEY, region VARCHAR(16), map_id TEXT, game_version VARCHAR(64), game_length_millis BIGINT, game_start_millis BIGINT, provisioning_flow_id VARCHAR(64), is_completed BOOLEAN, custom_game_name TEXT, queue_id VARCHAR(64), game_mode VARCHAR(64), is_ranked BOOLEAN, season_id VARCHAR(128), premier_match_info JSONB, raw_payload JSONB NOT NULL, fetched_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    "CREATE INDEX IF NOT EXISTS ix_matches_game_start_millis ON matches (game_start_millis)",
    "CREATE INDEX IF NOT EXISTS ix_matches_queue_id ON matches (queue_id)",
    `CREATE TABLE IF NOT EXISTS match_rounds (match_id VARCHAR(128) NOT NULL REFERENCES matches(match_id) ON DELETE CASCADE, round_number INTEGER NOT NULL, winning_team VARCHAR(32), winning_team_role VARCHAR(32), round_result VARCHAR(64), round_result_code VARCHAR(64), plant_round_time INTEGER, plant_location JSONB, plant_site VARCHAR(16), PRIMARY KEY (match_id, round_number))`,
    `CREATE TABLE IF NOT EXISTS player_match_stats (match_id VARCHAR(128) NOT NULL REFERENCES matches(match_id) ON DELETE CASCADE, riot_account_id UUID NOT NULL REFERENCES riot_accounts(id) ON DELETE CASCADE, team_id VARCHAR(32), party_id VARCHAR(128), character_id VARCHAR(128), score INTEGER, rounds_played INTEGER, kills INTEGER, deaths INTEGER, assists INTEGER, playtime_millis BIGINT, ability_casts JSONB, competitive_tier INTEGER, account_level INTEGER, PRIMARY KEY (match_id, riot_account_id))`,
    `CREATE TABLE IF NOT EXISTS player_round_stats (match_id VARCHAR(128) NOT NULL, riot_account_id UUID NOT NULL, round_number INTEGER NOT NULL, score INTEGER, economy JSONB, ability JSONB, PRIMARY KEY (match_id, riot_account_id, round_number), FOREIGN KEY (match_id, riot_account_id) REFERENCES player_match_stats(match_id, riot_account_id) ON DELETE CASCADE, FOREIGN KEY (match_id, round_number) REFERENCES match_rounds(match_id, round_number) ON DELETE CASCADE)`,
    `CREATE TABLE IF NOT EXISTS round_kills (match_id VARCHAR(128) NOT NULL, riot_account_id UUID NOT NULL, round_number INTEGER NOT NULL, kill_index INTEGER NOT NULL, is_killer BOOLEAN NOT NULL, is_victim BOOLEAN NOT NULL, is_assistant BOOLEAN NOT NULL, is_first_death BOOLEAN NOT NULL DEFAULT FALSE, game_time_millis INTEGER, round_time_millis INTEGER, finishing_damage_type VARCHAR(64), finishing_item VARCHAR(128), is_secondary_fire_mode BOOLEAN, PRIMARY KEY (match_id, riot_account_id, round_number, kill_index), FOREIGN KEY (match_id, riot_account_id, round_number) REFERENCES player_round_stats(match_id, riot_account_id, round_number) ON DELETE CASCADE)`,
    `CREATE TABLE IF NOT EXISTS round_damage (match_id VARCHAR(128) NOT NULL, riot_account_id UUID NOT NULL, round_number INTEGER NOT NULL, damage_index INTEGER NOT NULL, damage INTEGER, headshots INTEGER, bodyshots INTEGER, legshots INTEGER, PRIMARY KEY (match_id, riot_account_id, round_number, damage_index), FOREIGN KEY (match_id, riot_account_id, round_number) REFERENCES player_round_stats(match_id, riot_account_id, round_number) ON DELETE CASCADE)`,
    "ALTER TABLE round_kills ADD COLUMN IF NOT EXISTS is_first_death BOOLEAN NOT NULL DEFAULT FALSE"
  ]
}, {
  id: "20260905_0003",
  statements: [
    `CREATE TABLE IF NOT EXISTS riot_oauth_states (state_hash VARCHAR(64) PRIMARY KEY, code_verifier VARCHAR(128) NOT NULL, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    "CREATE INDEX IF NOT EXISTS ix_riot_oauth_states_expires_at ON riot_oauth_states (expires_at)",
    `CREATE TABLE IF NOT EXISTS user_sessions (token_hash VARCHAR(64) PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    "CREATE INDEX IF NOT EXISTS ix_user_sessions_user_id ON user_sessions (user_id)",
    "CREATE INDEX IF NOT EXISTS ix_user_sessions_expires_at ON user_sessions (expires_at)"
  ]
}, {
  id: "20260906_0004",
  statements: [
    "ALTER TABLE riot_oauth_states ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE",
    "CREATE INDEX IF NOT EXISTS ix_riot_oauth_states_user_id ON riot_oauth_states (user_id)"
  ]
}];

export async function migrate(pool: SqlExecutor): Promise<void> {
  await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (id VARCHAR(64) PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  for (const migration of migrations) {
    const alreadyApplied = await pool.query("SELECT id FROM schema_migrations WHERE id = $1", [migration.id]);
    if (alreadyApplied.rowCount) continue;
    for (const statement of migration.statements) await pool.query(statement);
    await pool.query("INSERT INTO schema_migrations (id) VALUES ($1)", [migration.id]);
  }
}
