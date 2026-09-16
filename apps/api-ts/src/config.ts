import { loadLocalEnv } from "@valorant/config";

loadLocalEnv();

export const databaseUrl = process.env.DATABASE_URL ?? "postgresql://valorant:valorant_dev@127.0.0.1:15432/valorant";
export const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:16379/0";
export const riotClientId = process.env.RIOT_CLIENT_ID ?? "";
export const riotClientSecret = process.env.RIOT_CLIENT_SECRET ?? "";
export const riotRedirectUri = process.env.RIOT_REDIRECT_URI ?? "http://localhost:8000/auth/riot/callback";
export const riotRsoAuthorizeUrl = process.env.RIOT_RSO_AUTHORIZE_URL ?? "";
export const riotRsoTokenUrl = process.env.RIOT_RSO_TOKEN_URL ?? "";
export const riotRsoUserinfoUrl = process.env.RIOT_RSO_USERINFO_URL ?? "";
export const riotAccountRegion = process.env.RIOT_ACCOUNT_REGION ?? "asia";
export const riotRsoScopes = process.env.RIOT_RSO_SCOPES ?? "openid";
export const tokenEncryptionKey = process.env.TOKEN_ENCRYPTION_KEY ?? "";
export const riotPostAuthRedirectUrl = process.env.RIOT_POST_AUTH_REDIRECT_URL ?? "http://localhost:3001/?riot=connected";
export const riotPlatform = process.env.RIOT_PLATFORM ?? "ap";
export const analysisModelApiKey = process.env.DEEPSEEK_API_KEY ?? "";
export const analysisModelBaseUrl = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1";
export const analysisModelName = process.env.DEEPSEEK_MODEL ?? "deepseek-flash";
export const enableDemoMode = process.env.ENABLE_DEMO_MODE === "true";
export const enableEvalMode = process.env.ENABLE_EVAL_MODE === "true";
export const analysisModelInputUsdPerMillion = process.env.DEEPSEEK_INPUT_USD_PER_MILLION ? Number(process.env.DEEPSEEK_INPUT_USD_PER_MILLION) : undefined;
export const analysisModelOutputUsdPerMillion = process.env.DEEPSEEK_OUTPUT_USD_PER_MILLION ? Number(process.env.DEEPSEEK_OUTPUT_USD_PER_MILLION) : undefined;
