export type PlayerMetricInput = {
  score: number;
  roundsPlayed: number;
  kills: number;
  deaths: number;
  totalDamage: number;
  headshots: number;
  bodyshots: number;
  legshots: number;
  firstDeaths: number;
  firstKills?: number;
  assists?: number;
  roundsWithKast?: number;
};

export type PlayerMetrics = {
  adr: number;
  acs: number;
  kd: number;
  headshotRate: number;
  firstDeathRate: number;
  firstKillRate: number;
  kast: number;
};

const roundToTwo = (value: number): number => Math.round(value * 100) / 100;

export function calculatePlayerMetrics(input: PlayerMetricInput): PlayerMetrics {
  if (input.roundsPlayed < 0 || input.deaths < 0) {
    throw new Error("metric inputs cannot be negative");
  }
  const hits = input.headshots + input.bodyshots + input.legshots;
  return {
    adr: input.roundsPlayed ? roundToTwo(input.totalDamage / input.roundsPlayed) : 0,
    acs: input.roundsPlayed ? roundToTwo(input.score / input.roundsPlayed) : 0,
    kd: input.deaths ? roundToTwo(input.kills / input.deaths) : input.kills,
    headshotRate: hits ? roundToTwo(input.headshots / hits * 100) : 0,
    firstDeathRate: input.roundsPlayed ? roundToTwo(input.firstDeaths / input.roundsPlayed * 100) : 0,
    firstKillRate: input.roundsPlayed ? roundToTwo((input.firstKills ?? 0) / input.roundsPlayed * 100) : 0,
    kast: input.roundsPlayed ? roundToTwo((input.roundsWithKast ?? 0) / input.roundsPlayed * 100) : 0
  };
}
