"""Private Bilibili transcript-first extraction. No media is retained after processing."""
import argparse, json, os, re, shutil, subprocess, sys
from pathlib import Path
import httpx
import yt_dlp
from faster_whisper import WhisperModel

def download_info(url, work):
    opts = {"skip_download": True, "writesubtitles": True, "writeautomaticsub": True,
            "subtitleslangs": ["zh-Hans", "zh-CN", "zh", "en"], "outtmpl": str(work / "%(id)s.%(ext)s"), "quiet": True}
    cookie = os.getenv("BILIBILI_COOKIES")
    if cookie: opts["cookiefile"] = cookie
    try:
        with yt_dlp.YoutubeDL(opts) as ydl: return ydl.extract_info(url, download=False)
    except Exception:
        # Windows environments with a TLS interception layer can break Python SSL while
        # the system curl remains usable. The Bilibili endpoints below are public.
        bvid = re.search(r"BV[0-9A-Za-z]+", url).group(0)
        def api(endpoint):
            raw = subprocess.check_output(["curl.exe", "-L", "--compressed", "--max-time", "30", "-s", endpoint], text=True, encoding="utf-8")
            payload = json.loads(raw)
            if payload.get("code") != 0: raise RuntimeError(payload.get("message", "Bilibili API error"))
            return payload["data"]
        view = api(f"https://api.bilibili.com/x/web-interface/view?bvid={bvid}")
        page = api(f"https://api.bilibili.com/x/player/pagelist?bvid={bvid}")[0]
        player = api(f"https://api.bilibili.com/x/player/v2?bvid={bvid}&cid={page['cid']}")
        play = api(f"https://api.bilibili.com/x/player/playurl?bvid={bvid}&cid={page['cid']}&qn=64&fnval=4048&fnver=0&fourk=1")
        dash = play.get("dash", {})
        audio = (dash.get("audio") or [{}])[0].get("baseUrl")
        video = (dash.get("video") or [{}])[0].get("baseUrl")
        return {"id": bvid, "title": view.get("title"), "description": view.get("desc"), "duration": view.get("duration"), "bili_audio_url": audio, "bili_video_url": video, "bili_subtitles": player.get("subtitle", {}).get("subtitles", []), "view_points": player.get("view_points", [])}

def transcript_from_subtitles(info):
    if info.get("bili_subtitles"):
        item = info["bili_subtitles"][0]
        return {"kind": "bilibili_subtitle", "url": item.get("subtitle_url"), "language": item.get("lan_doc", item.get("lan", ""))}
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
    try:
        with yt_dlp.YoutubeDL(opts) as ydl: ydl.download([url])
    except Exception:
        info = download_info(url, temp)
        audio_url = info.get("bili_audio_url")
        if not audio_url: raise
        raw_audio = temp / "audio.m4s"
        subprocess.run(["curl.exe", "-L", "--max-time", "1800", "-sS", "-A", "Mozilla/5.0", "-e", url, audio_url, "-o", str(raw_audio)], check=True)
    media = next(temp.glob("audio.*"))
    preferred=os.getenv("WHISPER_MODEL", "small")
    device=os.getenv("WHISPER_DEVICE", "cuda")
    try:
        model = WhisperModel(preferred, device=device, compute_type="float16" if device == "cuda" else "int8")
    except Exception:
        model = WhisperModel("base", device="cpu", compute_type="int8")
    segments, _ = model.transcribe(str(media), vad_filter=True)
    return [{"start": round(s.start,2), "end": round(s.end,2), "text": s.text.strip()} for s in segments]

def describe_frame(path):
    endpoint=os.getenv("VISION_API_BASE_URL", "").rstrip("/")
    key=os.getenv("VISION_API_KEY", "")
    model=os.getenv("VISION_MODEL", "")
    if not endpoint or not key or not model: return {"status":"not_configured"}
    import base64
    encoded=base64.b64encode(path.read_bytes()).decode("ascii")
    response=httpx.post(endpoint + "/chat/completions", headers={"Authorization":"Bearer " + key}, json={"model":model,"temperature":0,"response_format":{"type":"json_object"},"messages":[{"role":"system","content":"Extract only visible VALORANT teaching information. Never infer a player's behavior. Return JSON with map, side, phase, callouts, visibleText, tacticalSummary, confidence."},{"role":"user","content":[{"type":"text","text":"Describe this teaching screenshot for a pending knowledge draft."},{"type":"image_url","image_url":{"url":"data:image/jpeg;base64," + encoded}}]}]}, timeout=90)
    response.raise_for_status()
    return {"status":"complete","result":response.json().get("choices", [{}])[0].get("message", {}).get("content", "")}

def extract_frames(info, source_url, root):
    video_url=info.get("bili_video_url")
    if not video_url: return []
    ffmpeg=os.getenv("FFMPEG_BIN", "ffmpeg")
    points=info.get("view_points") or []
    times=[]
    for point in points: times.append((float(point.get("from", 0)), point.get("content", "")))
    if not times and info.get("duration"):
        duration=float(info["duration"]); times=[(duration*i/4, "") for i in range(4)]
    frame_dir=root/"frames"; frame_dir.mkdir(exist_ok=True)
    frames=[]
    for index,(seconds,label) in enumerate(times[:12]):
        output=frame_dir/f"frame-{index:02d}.jpg"
        headers="Referer: " + source_url + "\r\nUser-Agent: Mozilla/5.0\r\n"
        try:
            subprocess.run([ffmpeg,"-hide_banner","-loglevel","error","-y","-ss",str(seconds),"-headers",headers,"-i",video_url,"-frames:v","1","-q:v","4",str(output)], check=True, timeout=120)
            if output.exists() and output.stat().st_size: frames.append({"path":str(output),"seconds":seconds,"label":label,"vision":describe_frame(output)})
        except Exception as error: frames.append({"seconds":seconds,"label":label,"vision":{"status":"failed","error":str(error)}})
    return frames

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
        manifest["frames"]=extract_frames(info, args.url, root) if os.getenv("ENABLE_FRAME_EXTRACTION", "false").lower() == "true" else []
        manifest["framesStatus"]="enabled" if manifest["frames"] else "not_requested"
        (root/"manifest.json").write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding="utf-8")
        print(json.dumps({"sourceId":args.source_id,"manifest":str(root/'manifest.json'),"status":manifest["status"]},ensure_ascii=False))
    finally:
        shutil.rmtree(temp, ignore_errors=True)
if __name__=="__main__": main()
