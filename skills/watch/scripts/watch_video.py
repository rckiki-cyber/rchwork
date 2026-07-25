#!/usr/bin/env python3
"""
LegalWork Watch — 视频分析脚本

处理 YouTube 链接和本地视频文件，提取字幕/音频转录，
生成带时间戳的视频内容分析报告。

DeepSeek 适配：不输出视频帧（DS 不支持视觉），仅使用文字转录。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path


def eprint(*args, **kwargs):
    print(*args, file=sys.stderr, **kwargs)


# ── 工具检测 ──────────────────────────────────────────────

def check_dependencies():
    missing = []
    for cmd in ["ffmpeg", "yt-dlp"]:
        try:
            subprocess.run([cmd, "--version"], capture_output=True, check=True)
        except (FileNotFoundError, subprocess.CalledProcessError):
            missing.append(cmd)
    return missing


# ── yt-dlp 封装 ────────────────────────────────────────────

def is_url(text: str) -> bool:
    return re.match(r'https?://', text.strip()) is not None


def get_video_info(url: str) -> dict:
    """获取视频元数据"""
    result = subprocess.run(
        ["yt-dlp", "--dump-json", "--no-download", url],
        capture_output=True, text=True, timeout=60
    )
    if result.returncode != 0:
        return {}
    return json.loads(result.stdout)


def fetch_captions(url: str, work_dir: Path) -> dict:
    """尝试下载字幕，返回字幕文件路径和视频信息"""
    result = {"subtitle_path": None, "info": {}, "video_path": None}

    # 获取元数据
    info = get_video_info(url)
    result["info"] = info

    # 尝试下载字幕（优先自动生成的中文字幕，再英文字幕，最后任何字幕）
    langs = ["zh-Hans", "zh", "en", "a*"]
    for lang in langs:
        try:
            subprocess.run(
                ["yt-dlp", "--write-subs", "--sub-langs", lang,
                 "--skip-download", "--sub-format", "vtt",
                 "-o", str(work_dir / "subtitle.%(ext)s"),
                 url],
                capture_output=True, text=True, timeout=120
            )
            # 查找下载的字幕文件
            for f in work_dir.iterdir():
                if f.suffix in (".vtt", ".srt", ".ass"):
                    result["subtitle_path"] = str(f)
                    return result
        except (subprocess.TimeoutExpired, subprocess.CalledProcessError):
            continue
    return result


def download_audio(url: str, work_dir: Path) -> str | None:
    """下载音频用于 Whisper 转录"""
    out_path = work_dir / "audio.mp3"
    try:
        subprocess.run(
            ["yt-dlp", "-x", "--audio-format", "mp3",
             "--audio-quality", "0",
             "-o", str(out_path),
             url],
            capture_output=True, text=True, timeout=600
        )
        if out_path.exists():
            return str(out_path)
    except (subprocess.TimeoutExpired, subprocess.CalledProcessError) as e:
        eprint(f"[watch] audio download failed: {e}")
    return None


def process_local_file(path: str) -> str | None:
    p = Path(path).expanduser().resolve()
    if p.exists() and p.suffix.lower() in (".mp4", ".mov", ".mkv", ".webm", ".avi"):
        return str(p)
    return None


# ── 字幕解析 ──────────────────────────────────────────────

def parse_vtt(vtt_path: str) -> list[dict]:
    """解析 VTT 字幕文件为带时间戳的段落列表"""
    segments = []
    with open(vtt_path, "r", encoding="utf-8", errors="replace") as f:
        text = f.read()

    # 按空行分割
    blocks = re.split(r'\n\n+', text)
    for block in blocks:
        lines = block.strip().split("\n")
        if len(lines) < 2:
            continue

        # 跳过头部
        if lines[0].strip() == "WEBVTT" or lines[0].startswith("NOTE"):
            continue

        # 提取时间戳
        time_match = re.match(
            r'(\d{1,2}:?\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{1,2}:?\d{2}:\d{2}\.\d{3})',
            lines[0]
        )
        if not time_match:
            # 可能时间戳在第二行
            if len(lines) > 1:
                time_match = re.match(
                    r'(\d{1,2}:?\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{1,2}:?\d{2}:\d{2}\.\d{3})',
                    lines[1]
                )
                if time_match:
                    content_lines = lines[2:] if len(lines) > 2 else []
                else:
                    continue
            else:
                continue
        else:
            content_lines = lines[1:] if len(lines) > 1 else []

        def to_seconds(ts: str) -> float:
            parts = ts.replace(",", ".").split(":")
            if len(parts) == 3:
                return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
            elif len(parts) == 2:
                return int(parts[0]) * 60 + float(parts[1])
            return float(parts[0])

        start = to_seconds(time_match.group(1))
        end = to_seconds(time_match.group(2))
        content = " ".join(line.strip() for line in content_lines if line.strip())
        content = re.sub(r'<[^>]+>', '', content)  # 去 HTML 标签
        if content:
            segments.append({
                "start": start,
                "end": end,
                "text": content.strip()
            })

    return segments


def format_timestamp(seconds: float) -> str:
    m, s = divmod(int(seconds), 60)
    h, m = divmod(m, 60)
    if h > 0:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"


def format_transcript(segments: list[dict]) -> str:
    """将字幕段落格式化为带时间戳的文本"""
    lines = []
    for seg in segments:
        ts = format_timestamp(seg["start"])
        lines.append(f"[{ts}] {seg['text']}")
    return "\n".join(lines)


# ── Whisper 转录 ──────────────────────────────────────────

def load_whisper_config(force_backend: str | None = None) -> tuple[str | None, str | None]:
    """从环境变量或配置文件加载 Whisper API Key"""
    # 检查环境变量
    groq_key = os.environ.get("GROQ_API_KEY") or os.environ.get("WATCH_GROQ_API_KEY")
    openai_key = os.environ.get("OPENAI_API_KEY") or os.environ.get("WATCH_OPENAI_API_KEY")

    # 检查配置文件
    config_path = Path.home() / ".config" / "watch" / ".env"
    if config_path.exists():
        with open(config_path) as f:
            for line in f:
                line = line.strip()
                if line.startswith("GROQ_API_KEY="):
                    groq_key = groq_key or line.split("=", 1)[1].strip().strip("'\"")
                elif line.startswith("OPENAI_API_KEY="):
                    openai_key = openai_key or line.split("=", 1)[1].strip().strip("'\"")

    if force_backend == "groq" and groq_key:
        return ("groq", groq_key)
    if force_backend == "openai" and openai_key:
        return ("openai", openai_key)
    if groq_key:
        return ("groq", groq_key)
    if openai_key:
        return ("openai", openai_key)
    return (None, None)


def transcribe_with_whisper(audio_path: str, backend: str, api_key: str) -> list[dict]:
    """调用 Groq 或 OpenAI Whisper API 进行语音转录"""
    import urllib.request
    import json as json_module

    if backend == "groq":
        url = "https://api.groq.com/openai/v1/audio/transcriptions"
        model = "whisper-large-v3"
        headers = {"Authorization": f"Bearer {api_key}"}
    else:
        url = "https://api.openai.com/v1/audio/transcriptions"
        model = "whisper-1"
        headers = {"Authorization": f"Bearer {api_key}"}

    # 使用 multipart/form-data 上传
    boundary = "----WebKitFormBoundary7MA4YWxkTrZu0gW"
    body = []

    def add_field(name, value):
        body.append(f"--{boundary}".encode())
        body.append(f'Content-Disposition: form-data; name="{name}"'.encode())
        body.append(b"")
        body.append(value.encode() if isinstance(value, str) else value)

    # 读取音频文件
    with open(audio_path, "rb") as f:
        audio_data = f.read()

    body.append(f"--{boundary}".encode())
    body.append(f'Content-Disposition: form-data; name="file"; filename="audio.mp3"'.encode())
    body.append(b"Content-Type: audio/mpeg")
    body.append(b"")
    body.append(audio_data)

    add_field("model", model)
    add_field("response_format", "verbose_json")
    add_field("language", "zh")

    body.append(f"--{boundary}--".encode())
    body.append(b"")

    payload = b"\r\n".join(body)
    headers["Content-Type"] = f"multipart/form-data; boundary={boundary}"

    req = urllib.request.Request(url, data=payload, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            result = json_module.loads(resp.read().decode("utf-8"))
    except Exception as e:
        eprint(f"[watch] Whisper {backend} request failed: {e}")
        raise SystemExit(f"Whisper {backend} transcription failed: {e}")

    segments = []
    for seg in result.get("segments", []):
        segments.append({
            "start": seg.get("start", 0),
            "end": seg.get("end", 0),
            "text": seg.get("text", "").strip()
        })
    if not segments and result.get("text"):
        # 没有分段信息时报整体
        segments.append({"start": 0, "end": 0, "text": result["text"].strip()})

    return segments


# ── 主流程 ────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser(
        prog="watch",
        description="分析视频并提取文字内容（适配 DeepSeek：仅文字，无帧提取）",
    )
    ap.add_argument("source", help="视频 URL 或本地文件路径")
    ap.add_argument("--start", type=str, default=None, help="开始时间 (SS, MM:SS, HH:MM:SS)")
    ap.add_argument("--end", type=str, default=None, help="结束时间")
    ap.add_argument("--no-whisper", action="store_true", help="禁用 Whisper 转录")
    ap.add_argument("--whisper", choices=["groq", "openai"], default=None, help="指定 Whisper 后端")
    ap.add_argument("--json", action="store_true", help="输出 JSON 格式")
    args = ap.parse_args()

    # 检测依赖
    missing = check_dependencies()
    if missing:
        eprint(f"[watch] 缺少依赖: {', '.join(missing)}")
        eprint("[watch] 请先安装:")
        eprint("  macOS: brew install ffmpeg yt-dlp")
        eprint("  Linux: sudo apt install ffmpeg yt-dlp")
        eprint("  Windows: winget install ffmpeg yt-dlp")
        return 1

    # 创建临时工作目录
    work = Path(tempfile.mkdtemp(prefix="watch-"))
    eprint(f"[watch] 工作目录: {work}")

    # 判断是 URL 还是本地文件
    source_url = is_url(args.source)
    video_path = None
    info = {}

    if source_url:
        eprint("[watch] 获取视频信息...")
        info = get_video_info(args.source)
        title = info.get("title", args.source)
        duration = info.get("duration", 0)
        uploader = info.get("uploader", "")
        eprint(f"[watch] 标题: {title}")
        eprint(f"[watch] 时长: {duration}s")

        # 尝试下载字幕
        eprint("[watch] 尝试获取字幕...")
        cap_result = fetch_captions(args.source, work)
        subtitle_path = cap_result.get("subtitle_path")
    else:
        # 本地文件
        video_path = process_local_file(args.source)
        if not video_path:
            eprint(f"[watch] 文件不存在或格式不支持: {args.source}")
            return 1
        title = Path(video_path).name
        subtitle_path = None
        duration = 0
        uploader = ""
        eprint(f"[watch] 本地文件: {video_path}")

        # 获取本地文件时长
        try:
            probe = subprocess.run(
                ["ffprobe", "-v", "quiet", "-print_format", "json",
                 "-show_format", video_path],
                capture_output=True, text=True, timeout=30
            )
            if probe.returncode == 0:
                fmt = json.loads(probe.stdout).get("format", {})
                duration = float(fmt.get("duration", 0))
        except Exception:
            pass

    # 解析字幕
    segments = []
    if subtitle_path:
        eprint(f"[watch] 解析字幕: {subtitle_path}")
        segments = parse_vtt(subtitle_path)

    # 如果没有字幕，尝试 Whisper
    if not segments and not args.no_whisper:
        eprint("[watch] 无可用字幕，尝试音频转录...")
        # 下载音频
        if source_url:
            audio_file = download_audio(args.source, work)
        else:
            audio_file = video_path

        if audio_file:
            backend, api_key = load_whisper_config(args.whisper)
            if backend and api_key:
                eprint(f"[watch] 调用 {backend} Whisper 转录...")
                try:
                    segments = transcribe_with_whisper(audio_file, backend, api_key)
                    eprint(f"[watch] 转录完成: {len(segments)} 段")
                except SystemExit as e:
                    eprint(f"[watch] 转录失败: {e}")
            else:
                eprint("[watch] 未配置 Whisper API Key，跳过转录")
                eprint("[watch] 如需转录，在 ~/.config/watch/.env 设置 GROQ_API_KEY 或 OPENAI_API_KEY")

    # 时间范围过滤
    start_sec = None
    end_sec = None
    if args.start:
        parts = args.start.split(":")
        if len(parts) == 3:
            start_sec = int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
        elif len(parts) == 2:
            start_sec = int(parts[0]) * 60 + float(parts[1])
        else:
            start_sec = float(parts[0])
    if args.end:
        parts = args.end.split(":")
        if len(parts) == 3:
            end_sec = int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
        elif len(parts) == 2:
            end_sec = int(parts[0]) * 60 + float(parts[1])
        else:
            end_sec = float(parts[0])

    if start_sec is not None or end_sec is not None:
        filtered = []
        for seg in segments:
            if start_sec is not None and seg["end"] < start_sec:
                continue
            if end_sec is not None and seg["start"] > end_sec:
                continue
            filtered.append(seg)
        segments = filtered

    transcript = format_transcript(segments)

    # 输出报告
    if args.json:
        report = {
            "title": title,
            "source": args.source,
            "duration_seconds": duration,
            "uploader": uploader,
            "segments": len(segments),
            "transcript": transcript,
            "adaptation": "deepseek-no-vision"  # DeepSeek 不输出帧
        }
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print("# Watch: 视频分析报告")
        print()
        print(f"- **来源:** {args.source}")
        print(f"- **标题:** {title}")
        if uploader:
            print(f"- **发布者:** {uploader}")
        if duration:
            print(f"- **时长:** {format_timestamp(duration)} ({duration:.1f}s)")
        if segments:
            print(f"- **字幕段落:** {len(segments)} 段")
            print(f"- **文字长度:** {len(transcript)} 字符")
        print()
        print("> ⚠️ 当前使用 DeepSeek 模型（不支持视觉），仅提取文字内容，未分析视频画面。")
        print()

        if transcript:
            print("## 📝 完整文字记录")
            print()
            for seg in segments:
                ts = format_timestamp(seg["start"])
                print(f"> **[`{ts}`]** {seg['text']}")
        else:
            print("## 无法提取内容")
            print()
            print("未能从该视频中提取到字幕或音频转录。可能原因：")
            print("- 视频没有字幕轨道")
            print("- 未配置 Whisper API Key（需要设置 GROQ_API_KEY 或 OPENAI_API_KEY）")
            print("- 视频语言不匹配")
            print()
            print("建议：")
            print("1. 安装 yt-dlp 并确保视频平台受支持")
            print("2. 配置 Whisper API Key 以支持无字幕视频")
            print("3. 如果是本地文件，确保使用支持的格式（mp4/mov/mkv/webm）")

    # 清理
    import shutil
    shutil.rmtree(work, ignore_errors=True)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
