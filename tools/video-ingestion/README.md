# Private video ingestion workspace

This is copied to `E:\valorant-video-ingestion` and is intentionally not served by the web app. It retrieves subtitles before ASR, retains JSON transcripts and selected frames privately, and removes temporary audio after each source. Run `python extract.py --source-id bili-haven-defense --url https://www.bilibili.com/video/BV1tM4y1j7mE/`.

Set `FFMPEG_BIN` to the local executable when it is not on `PATH`. A Bilibili cookie path is optional and must remain outside Git and Vercel.
