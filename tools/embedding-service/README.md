# Local Qwen embedding service

This service runs `Qwen/Qwen3-Embedding-0.6B` locally and exposes the OpenAI-compatible `/v1/embeddings` endpoint used by the API. It does not call a paid embedding provider.

Set `QWEN_EMBEDDING_MODEL_PATH` to the model directory, then run:

```powershell
python embedding_server.py
```

The local service uses CUDA when available and listens on `127.0.0.1:18090` in this project setup.

Health check:

```powershell
Invoke-RestMethod http://127.0.0.1:18090/health
```
