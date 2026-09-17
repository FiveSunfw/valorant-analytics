"""Offline acceptance checks for the four private transcript manifests."""
import json
import os
from pathlib import Path


SOURCE_IDS = (
    "bili-haven-defense",
    "bili-haven-attack",
    "bili-ascent-defense",
    "bili-ascent-attack",
)


def main() -> None:
    root = Path(os.getenv("KNOWLEDGE_INGESTION_ROOT", r"E:\valorant-video-ingestion")) / "out"
    checked = []
    for source_id in SOURCE_IDS:
        source_root = root / source_id
        manifest_path = source_root / "manifest.json"
        if not manifest_path.exists():
            raise SystemExit(f"missing manifest: {manifest_path}")
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        segments = manifest.get("transcriptSegments") or []
        if manifest.get("status") not in {"subtitle_complete", "asr_complete"}:
            raise SystemExit(f"incomplete status for {source_id}: {manifest.get('status')}")
        if not segments:
            raise SystemExit(f"empty transcript for {source_id}")
        if manifest.get("framesStatus") != "not_requested":
            raise SystemExit(f"vision should be disabled for {source_id}")
        if any(path.name.startswith("audio.") for path in source_root.iterdir()):
            raise SystemExit(f"temporary audio was retained for {source_id}")
        checked.append({"sourceId": source_id, "status": manifest["status"], "segments": len(segments)})
    print(json.dumps({"checked": checked}, ensure_ascii=False))


if __name__ == "__main__":
    main()
