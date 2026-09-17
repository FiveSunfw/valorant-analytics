import { loadLocalEnv } from "@valorant/config";

loadLocalEnv();

export const databaseUrl = process.env.DATABASE_URL ?? "postgresql://valorant:valorant_dev@127.0.0.1:15432/valorant";
export const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:16379/0";
export const rabbitMqUrl = process.env.RABBITMQ_URL ?? "amqp://127.0.0.1:5672";
export const riotApiKey = process.env.RIOT_API_KEY ?? "";
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
// Retrieval credentials are server-only. Leave them empty to use the safe PostgreSQL fallback.
export const qdrantUrl = process.env.QDRANT_URL ?? "";
export const qdrantApiKey = process.env.QDRANT_API_KEY ?? "";
export const qdrantCollection = process.env.QDRANT_COLLECTION ?? "valorant_knowledge_v1";
export const qdrantTimeoutMs = Number(process.env.QDRANT_TIMEOUT_MS ?? "8000");
export const jinaApiKey = process.env.JINA_API_KEY ?? "";
export const jinaBaseUrl = process.env.JINA_BASE_URL ?? "https://api.jina.ai/v1";
export const jinaEmbeddingModel = process.env.JINA_EMBEDDING_MODEL ?? "jina-embeddings-v3";
export const jinaRerankModel = process.env.JINA_RERANK_MODEL ?? "jina-reranker-v2-base-multilingual";
export const knowledgeIndexVersion = process.env.KNOWLEDGE_INDEX_VERSION ?? "v1";
