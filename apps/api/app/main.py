import os

import psycopg
from fastapi import FastAPI, HTTPException
from redis import Redis
from redis.exceptions import RedisError

app = FastAPI(title="VALORANT Analytics API", version="0.1.0")

@app.get("/health")
def health() -> dict[str, str]:
    """Verify the local API can reach its containerized dependencies."""

    database_url = os.getenv(
        "DATABASE_URL",
        "postgresql+psycopg://valorant:valorant_dev@127.0.0.1:15432/valorant",
    ).replace("postgresql+psycopg://", "postgresql://", 1)
    redis_url = os.getenv("REDIS_URL", "redis://127.0.0.1:6379/0")
    try:
        with psycopg.connect(database_url, connect_timeout=3) as connection:
            connection.execute("SELECT 1")
        Redis.from_url(redis_url, socket_connect_timeout=3).ping()
    except (psycopg.Error, RedisError, OSError) as exc:
        raise HTTPException(status_code=503, detail="dependency unavailable") from exc
    return {"status": "ok", "service": "api", "database": "ok", "redis": "ok"}
