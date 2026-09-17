"""Local Qwen3 embedding service for the private knowledge index."""
import os
from typing import Any

import torch
import torch.nn.functional as F
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from transformers import AutoModel, AutoTokenizer


MODEL_PATH = os.getenv("QWEN_EMBEDDING_MODEL_PATH", r"E:\valorant-video-ingestion\models\Qwen3-Embedding-0.6B")
MODEL_NAME = os.getenv("QWEN_EMBEDDING_MODEL", "Qwen/Qwen3-Embedding-0.6B")
MAX_LENGTH = int(os.getenv("QWEN_EMBEDDING_MAX_LENGTH", "2048"))
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
DTYPE = torch.float16 if DEVICE == "cuda" else torch.float32
TASK = "Given a VALORANT teaching query, retrieve relevant map, side, callout, and tactical guidance passages."

tokenizer = AutoTokenizer.from_pretrained(MODEL_PATH, padding_side="left", local_files_only=True)
model = AutoModel.from_pretrained(MODEL_PATH, torch_dtype=DTYPE, local_files_only=True).to(DEVICE).eval()

app = FastAPI(title="Local Qwen Embeddings", version="1.0.0")


class EmbeddingRequest(BaseModel):
    model: str | None = None
    input: list[str]
    task: str | None = None


def last_token_pool(last_hidden_states: torch.Tensor, attention_mask: torch.Tensor) -> torch.Tensor:
    sequence_lengths = attention_mask.sum(dim=1) - 1
    batch_size = last_hidden_states.shape[0]
    return last_hidden_states[torch.arange(batch_size, device=last_hidden_states.device), sequence_lengths]


@app.get("/health")
def health() -> dict[str, Any]:
    return {"status": "ok", "model": MODEL_NAME, "device": DEVICE, "dimensions": 1024}


@app.post("/v1/embeddings")
def embeddings(request: EmbeddingRequest) -> dict[str, Any]:
    if not request.input or len(request.input) > 32:
        raise HTTPException(status_code=400, detail="input must contain between 1 and 32 strings")
    texts = request.input
    if request.task == "retrieval.query":
        texts = [f"Instruct: {TASK}\nQuery:{text}" for text in request.input]
    batch = tokenizer(texts, padding=True, truncation=True, max_length=MAX_LENGTH, return_tensors="pt")
    batch = {key: value.to(DEVICE) for key, value in batch.items()}
    with torch.inference_mode():
        outputs = model(**batch)
        vectors = F.normalize(last_token_pool(outputs.last_hidden_state, batch["attention_mask"]), p=2, dim=1)
    data = [{"object": "embedding", "index": index, "embedding": vector.detach().float().cpu().tolist()} for index, vector in enumerate(vectors)]
    token_count = int(batch["attention_mask"].sum().item())
    return {"object": "list", "model": request.model or MODEL_NAME, "data": data, "usage": {"prompt_tokens": token_count, "total_tokens": token_count}}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=int(os.getenv("QWEN_EMBEDDING_PORT", "8090")))
