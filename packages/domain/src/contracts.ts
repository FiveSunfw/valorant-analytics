import { z } from "zod";

export const COMPETITIVE_QUEUE_ID = "competitive" as const;

export const matchInfoSchema = z.object({
  matchId: z.string().min(1),
  region: z.string().optional(),
  mapId: z.string().optional(),
  gameVersion: z.string().optional(),
  gameLengthMillis: z.number().int().optional(),
  gameStartMillis: z.number().int().optional(),
  provisioningFlowId: z.string().optional(),
  isCompleted: z.boolean(),
  customGameName: z.string().optional(),
  queueId: z.string(),
  gameMode: z.string().optional(),
  isRanked: z.boolean(),
  seasonId: z.string().optional(),
  premierMatchInfo: z.record(z.unknown()).optional()
});

export const damageSchema = z.object({
  damage: z.number().int().nullable().optional(),
  headshots: z.number().int().nullable().optional(),
  bodyshots: z.number().int().nullable().optional(),
  legshots: z.number().int().nullable().optional()
});

export const killSchema = z.object({
  killer: z.string().optional(),
  victim: z.string().optional(),
  assistants: z.array(z.string()).optional(),
  gameTime: z.number().int().nullable().optional(),
  roundTime: z.number().int().nullable().optional(),
  finishingDamage: z.object({
    damageType: z.string().optional(),
    damageItem: z.string().optional(),
    isSecondaryFireMode: z.boolean().optional()
  }).optional()
});

export const playerRoundStatsSchema = z.object({
  puuid: z.string(),
  score: z.number().int().nullable().optional(),
  economy: z.record(z.unknown()).nullable().optional(),
  ability: z.record(z.unknown()).nullable().optional(),
  kills: z.array(killSchema).default([]),
  damage: z.array(damageSchema).default([])
});

export const roundResultSchema = z.object({
  roundNum: z.number().int().nonnegative(),
  winningTeam: z.string().nullable().optional(),
  winningTeamRole: z.string().nullable().optional(),
  roundResult: z.string().nullable().optional(),
  roundResultCode: z.string().nullable().optional(),
  plantRoundTime: z.number().int().nullable().optional(),
  plantLocation: z.record(z.unknown()).nullable().optional(),
  plantSite: z.string().nullable().optional(),
  playerStats: z.array(playerRoundStatsSchema).default([])
});

export const rawMatchSchema = z.object({
  matchInfo: matchInfoSchema,
  players: z.array(z.object({
    puuid: z.string(),
    teamId: z.string().nullable().optional(),
    partyId: z.string().nullable().optional(),
    characterId: z.string().nullable().optional(),
    competitiveTier: z.number().int().nullable().optional(),
    accountLevel: z.number().int().nullable().optional(),
    stats: z.object({
      score: z.number().int().nullable().optional(),
      roundsPlayed: z.number().int().nullable().optional(),
      kills: z.number().int().nullable().optional(),
      deaths: z.number().int().nullable().optional(),
      assists: z.number().int().nullable().optional(),
      playtimeMillis: z.number().int().nullable().optional(),
      abilityCasts: z.record(z.unknown()).nullable().optional()
    })
  })).default([]),
  roundResults: z.array(roundResultSchema).default([])
});

export type RawMatch = z.infer<typeof rawMatchSchema>;
