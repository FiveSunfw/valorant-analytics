# Private video ingestion workspace

This is copied to `E:\valorant-video-ingestion` and is intentionally not served by the web app. It retrieves subtitles before ASR, falls back to the public Bilibili player API plus system `curl` when Python TLS is unavailable, retains normalized JSON transcripts privately, and removes temporary audio after each source. Frame/vision extraction is opt-in and disabled for the current four-source ingestion run.

Run from the workspace after the API database has been migrated:

```powershell
docker compose -f E:\valorant-video-ingestion\docker-compose.yml up -d
npm run knowledge:extract --workspace @valorant/api -- bili-haven-defense
npm run knowledge:draft --workspace @valorant/api -- bili-haven-defense
# Inspect the pending draft ID, then publish only after review:
npm run knowledge:approve --workspace @valorant/api -- <draft-id>
npm run knowledge:index --workspace @valorant/api -- bili-haven-defense
# Verify all four private manifests and confirm temporary audio was removed:
python tools/video-ingestion/test_ingestion.py
```

Set `QDRANT_URL`, `JINA_API_KEY`, and the existing server-side `DEEPSEEK_API_KEY` in the API process for hosted embeddings, reranking, and structured draft generation. `VISION_API_BASE_URL`, `VISION_API_KEY`, and `VISION_MODEL` are optional; without them frame assets are retained with `not_configured` status.

Set `FFMPEG_BIN` to the local executable when it is not on `PATH`. A Bilibili cookie path is optional and must remain outside Git and Vercel.
