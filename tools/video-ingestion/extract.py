"""Private Bilibili transcript-first extraction. No media is retained after processing."""
import argparse, json, os, shutil, subprocess, sys
from pathlib import Path
import httpx
import yt_dlp
from faster_whisper import WhisperModel

def download_info(url, work):
    opts = {"skip_download": True, "writesubtitles": True, "writeautomaticsub": True,
            "subtitleslangs": ["zh-Hans", "zh-CN", "zh", "en"], "outtmpl": str(work / "%(id)s.%(ext)s"), "quiet": True}
    cookie = os.getenv("BILIBILI_COOKIES")
    if cookie: opts["cookiefile"] = cookie
    with yt_dlp.YoutubeDL(opts) as ydl: return ydl.extract_info(url, download=False)

def transcript_from_subtitles(info):
    tracks = info.get("subtitles") or info.get("automatic_captions") or {}
    for language in ("zh-Hans", "zh-CN", "zh", "en"):
        if tracks.get(language):
            item = next((x for x in tracks[language] if x.get("ext") in ("json3", "vtt", "srt")), tracks[language][0])
            return {"kind": "remote_subtitle", "url": item.get("url"), "language": language}
    return None

def fetch_subtitle(track):
    """Retain only a normalized private transcript, never the original subtitle file."""
    response=httpx.get(track["url"], timeout=30); response.raise_for_status(); data=response.json()
    rows=[]
    for body in data.get("body", []):
        text="".join(part.get("content", "") for part in body.get("content", []))
        if text: rows.append({"start":round(body.get("from",0)/1000,2),"end":round(body.get("to",0)/1000,2),"text":text})
    return rows

def asr(url, temp):
    audio = temp / "audio.%(ext)s"
    opts = {"format": "bestaudio/best", "outtmpl": str(audio), "quiet": True, "postprocessors": [{"key":"FFmpegExtractAudio","preferredcodec":"mp3"}]}
    cookie = os.getenv("BILIBILI_COOKIES")
    if cookie: opts["cookiefile"] = cookie
    with yt_dlp.YoutubeDL(opts) as ydl: ydl.download([url])
    media = next(temp.glob("audio.*"))
    try: model = WhisperModel("small", device="cuda", compute_type="float16")
    except Exception: model = WhisperModel("base", device="cpu", compute_type="int8")
    segments, _ = model.transcribe(str(media), vad_filter=True)
    return [{"start": round(s.start,2), "end": round(s.end,2), "text": s.text.strip()} for s in segments]

def main():
    parser=argparse.ArgumentParser(); parser.add_argument("--source-id", required=True); parser.add_argument("--url", required=True); parser.add_argument("--out", default="out")
    args=parser.parse_args(); root=Path(args.out)/args.source_id; temp=root/"temp"; root.mkdir(parents=True,exist_ok=True); temp.mkdir(exist_ok=True)
    try:
        info=download_info(args.url,temp); subtitle=transcript_from_subtitles(info)
        manifest={"sourceId":args.source_id,"url":args.url,"title":info.get("title"),"description":info.get("description"),"duration":info.get("duration"),"subtitle":subtitle,"transcriptSegments":[],"frames":[],"status":"subtitle_available" if subtitle else "asr_required"}
        if subtitle:
            try: manifest["transcriptSegments"]=fetch_subtitle(subtitle); manifest["status"]="subtitle_complete"
            except Exception as error: manifest["subtitleError"]=str(error); manifest["transcriptSegments"]=asr(args.url,temp); manifest["status"]="asr_complete"
        else: manifest["transcriptSegments"]=asr(args.url,temp); manifest["status"]="asr_complete"
        (root/"manifest.json").write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding="utf-8")
        print(json.dumps({"sourceId":args.source_id,"manifest":str(root/'manifest.json'),"status":manifest["status"]},ensure_ascii=False))
    finally:
        shutil.rmtree(temp, ignore_errors=True)
if __name__=="__main__": main()
