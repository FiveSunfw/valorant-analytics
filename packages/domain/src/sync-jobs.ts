import { z } from "zod";

export const ACCOUNT_SYNC_EXCHANGE = "valorant.sync" as const;
export const ACCOUNT_SYNC_ROUTING_KEY = "account-sync" as const;
export const ACCOUNT_SYNC_QUEUE = "valorant.account-sync" as const;

export const accountSyncJobSchema = z.object({
  jobId: z.string().uuid(),
  riotAccountId: z.string().uuid(),
  maxMatches: z.number().int().min(1).max(20).default(10)
}).strict();

export type AccountSyncJob = z.infer<typeof accountSyncJobSchema>;
