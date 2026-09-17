$env:QWEN_EMBEDDING_MODEL_PATH = 'E:\valorant-video-ingestion\models\Qwen3-Embedding-0.6B'
$env:QWEN_EMBEDDING_PORT = '18090'
python "$PSScriptRoot\embedding_server.py"
