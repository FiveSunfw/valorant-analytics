import { COMPETITIVE_QUEUE_ID, type RawMatch } from "./contracts.js";

export function isCompletedCompetitiveMatch(match: RawMatch): boolean {
  const { isCompleted, isRanked, queueId } = match.matchInfo;
  return isCompleted && isRanked && queueId === COMPETITIVE_QUEUE_ID;
}

export function firstKillIdentity(kill: {
  killer?: string;
  victim?: string;
  gameTime?: number | null;
  roundTime?: number | null;
  finishingDamage?: unknown;
}): string {
  return JSON.stringify([
    kill.killer,
    kill.victim,
    kill.gameTime ?? null,
    kill.roundTime ?? null,
    kill.finishingDamage ?? null
  ]);
}

export function firstKillInRound(matchRound: RawMatch["roundResults"][number]): string | undefined {
  const kills = matchRound.playerStats.flatMap((player) => player.kills)
    .filter((kill) => Boolean(kill.victim));
  const first = kills.sort((left, right) => {
    const leftTime = left.gameTime ?? left.roundTime ?? Number.MAX_SAFE_INTEGER;
    const rightTime = right.gameTime ?? right.roundTime ?? Number.MAX_SAFE_INTEGER;
    return leftTime - rightTime;
  })[0];
  return first ? firstKillIdentity(first) : undefined;
}
