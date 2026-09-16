export const DEMO_FIXTURES = {
  full: { userId: "10000000-0000-4000-8000-000000000001", accountId: "20000000-0000-4000-8000-000000000001", matches: 6, includeFirstDeaths: true },
  small: { userId: "10000000-0000-4000-8000-000000000002", accountId: "20000000-0000-4000-8000-000000000002", matches: 2, includeFirstDeaths: false },
  empty: { userId: "10000000-0000-4000-8000-000000000003", accountId: "20000000-0000-4000-8000-000000000003", matches: 0, includeFirstDeaths: false }
} as const;

export type DemoFixtureProfile = keyof typeof DEMO_FIXTURES;
export const DEMO_USER_ID = DEMO_FIXTURES.full.userId;
export function isDemoFixtureProfile(value: unknown): value is DemoFixtureProfile { return typeof value === "string" && value in DEMO_FIXTURES; }
