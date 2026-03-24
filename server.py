"""
SpeakEasy Backend Server
FastAPI + Whisper (local) + Ollama Qwen2.5 (local)
Transcribes English/Tagalog/Bisaya audio and summarizes feedback

Run: uvicorn server:app --host 0.0.0.0 --port 8000 --reload
"""

import os
import json
import shutil
import tempfile
import httpx
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import whisper
import torch

app = FastAPI(title="SpeakEasy API", version="1.0.0")

# Allow all origins (your Expo app on local WiFi)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── CONFIG ──────────────────────────────────────────────────────────────────
OLLAMA_URL = "http://localhost:11434/api/generate"
OLLAMA_TAGS_URL = "http://localhost:11434/api/tags"
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "qwen2.5:7b")
OLLAMA_MODEL_FALLBACKS = ["qwen2.5:7b", "qwen2.5", "qwen2.5:3b"]
OLLAMA_TIMEOUT_SECONDS = 3600.0
OLLAMA_KV_CACHE_TYPE = os.getenv("OLLAMA_KV_CACHE_TYPE") or None
WHISPER_MODEL_SIZE = "large-v3"    # Options: tiny, base, small, medium, large-v3
USE_GPU = bool(torch.cuda.is_available())

print(f"GPU Available: {USE_GPU}")


def configure_ffmpeg():
    existing = shutil.which("ffmpeg")
    if existing:
        print(f"Using ffmpeg from PATH: {existing}")
        return existing

    try:
        import imageio_ffmpeg

        bundled = imageio_ffmpeg.get_ffmpeg_exe()
        alias_dir = os.path.join(tempfile.gettempdir(), "speakeasy-ffmpeg")
        alias_path = os.path.join(alias_dir, "ffmpeg.exe")

        os.makedirs(alias_dir, exist_ok=True)

        if not os.path.exists(alias_path):
            shutil.copyfile(bundled, alias_path)

        os.environ["PATH"] = alias_dir + os.pathsep + os.environ.get("PATH", "")
        print(f"Using bundled ffmpeg alias: {alias_path}")
        return alias_path
    except Exception as error:
        print(f"FFmpeg not available: {error}")
        return None


FFMPEG_PATH = configure_ffmpeg()
print(f"Loading Whisper {WHISPER_MODEL_SIZE}...")

# Load Whisper once at startup (takes ~10s first time)
whisper_model = whisper.load_model(
    WHISPER_MODEL_SIZE,
    device="cuda" if USE_GPU else "cpu"
)
print("Whisper model loaded and ready!")


def get_ollama_model_candidates(requested_model: str | None = None):
    if requested_model and requested_model.strip():
        return [requested_model.strip()]

    candidates = []

    for name in [OLLAMA_MODEL, *OLLAMA_MODEL_FALLBACKS]:
        if name and name not in candidates:
            candidates.append(name)

    return candidates


async def get_installed_ollama_models():
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(OLLAMA_TAGS_URL)
            response.raise_for_status()
            payload = response.json()
            models = [
                item.get("name")
                for item in payload.get("models", [])
                if item.get("name")
            ]

            if models:
                return models
    except Exception as error:
        print(f"Could not load Ollama model list: {error}")

    return get_ollama_model_candidates()

# ─── MODELS ──────────────────────────────────────────────────────────────────
class SummaryRequest(BaseModel):
    transcript: str
    context: str = "teacher feedback on student project"
    model: str | None = None

class TranscribeResponse(BaseModel):
    success: bool
    transcript: str
    language: str
    language_probability: float
    duration: float
    segments: list

class SummaryResponse(BaseModel):
    success: bool
    summary: str
    key_points: list[str]
    action_items: list[str]
    model: str | None = None
    kv_cache_type: str | None = None
    raw: str

# ─── ROUTES ──────────────────────────────────────────────────────────────────

@app.get("/")
def root():
    return {
        "status": "SpeakEasy server is running",
        "gpu": USE_GPU,
        "whisper_model": WHISPER_MODEL_SIZE,
        "ollama_model": OLLAMA_MODEL,
        "ollama_model_candidates": get_ollama_model_candidates(),
        "ffmpeg_available": bool(FFMPEG_PATH),
    }

@app.get("/health")
def health():
    return {
        "status": "ok",
        "gpu": USE_GPU,
        "ffmpeg_available": bool(FFMPEG_PATH),
        "default_summary_model": OLLAMA_MODEL,
        "ollama_kv_cache_type": OLLAMA_KV_CACHE_TYPE,
    }


@app.get("/config")
async def config():
    return {
        "default_summary_model": OLLAMA_MODEL,
        "summary_model_candidates": get_ollama_model_candidates(),
        "available_summary_models": await get_installed_ollama_models(),
        "ollama_kv_cache_type": OLLAMA_KV_CACHE_TYPE,
    }


@app.post("/transcribe", response_model=TranscribeResponse)
async def transcribe_audio(file: UploadFile = File(...)):
    """
    Accepts an audio/video file, runs Whisper, returns transcript.
    Supports: mp3, mp4, wav, m4a, webm, ogg
    Languages: English, Tagalog, Bisaya/Cebuano (auto-detected)
    """
    allowed_types = [
        "audio/mpeg", "audio/mp4", "audio/wav", "audio/x-wav",
        "audio/m4a", "audio/webm", "audio/ogg", "video/mp4",
        "audio/x-m4a", "application/octet-stream"
    ]

    # Save uploaded file to temp
    suffix = os.path.splitext(file.filename or "audio.m4a")[1] or ".m4a"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        content = await file.read()
        tmp.write(content)
        tmp_path = tmp.name

    try:
        print(f"Transcribing: {file.filename} ({len(content) / 1024:.1f} KB)")

        # Run Whisper
        # task="transcribe" keeps original language
        # task="translate" would convert to English
        result = whisper_model.transcribe(
            tmp_path,
            task="transcribe",
            language=None,          # Auto-detect language
            # Segment timestamps are enough for the app timeline. Word-level
            # alignment is much slower on this machine and is not used.
            word_timestamps=False,
            verbose=False
        )

        # Extract detected language info
        detected_lang = result.get("language", "unknown")
        lang_prob = result.get("language_probs", {}).get(detected_lang, 0.0)

        # Build segments list
        segments = []
        for seg in result.get("segments", []):
            segments.append({
                "start": round(seg["start"], 2),
                "end": round(seg["end"], 2),
                "text": seg["text"].strip()
            })

        duration_seconds = float(result.get("duration") or (segments[-1]["end"] if segments else 0))

        print(f"Transcribed. Language: {detected_lang} | Duration: {duration_seconds:.1f}s")

        return TranscribeResponse(
            success=True,
            transcript=result["text"].strip(),
            language=detected_lang,
            language_probability=round(float(lang_prob), 4),
            duration=round(duration_seconds, 2),
            segments=segments
        )

    except Exception as e:
        print(f"Transcription error: {e}")
        if isinstance(e, FileNotFoundError) or "WinError 2" in str(e):
            raise HTTPException(
                status_code=500,
                detail=(
                    "FFmpeg is missing for Whisper transcription. "
                    "Install FFmpeg or restart the backend after configuring it."
                ),
            )
        raise HTTPException(status_code=500, detail=str(e))

    finally:
        os.unlink(tmp_path)  # Clean up temp file


@app.post("/summarize", response_model=SummaryResponse)
async def summarize_transcript(req: SummaryRequest):
    """
    Takes a transcript and summarizes it using Ollama Qwen2.5.
    Extracts key feedback points and action items.
    """

    prompt = f"""You are a helpful assistant that summarizes teacher feedback for a student.

The following is a transcript of a teacher giving feedback on a student's project.
The transcript may be in English, Tagalog, Bisaya, or a mix of all three (code-switching).

Transcript:
\"\"\"
{req.transcript}
\"\"\"

Please provide:
1. A clear SUMMARY of the main feedback points (3-5 sentences max, in English)
2. A list of KEY POINTS - the most important feedback details in short bullets
3. A list of ACTION ITEMS - specific things the student needs to add, fix, or change

Respond ONLY in this exact JSON format, no extra text:
{{
  "summary": "...",
  "key_points": ["point 1", "point 2", "point 3"],
  "action_items": ["item 1", "item 2", "item 3"]
}}"""

    try:
        print("Sending to Ollama for summarization...")

        response = None
        selected_model = None

        async with httpx.AsyncClient(timeout=OLLAMA_TIMEOUT_SECONDS) as client:
            for model_name in get_ollama_model_candidates(req.model):
                print(f"Trying Ollama model: {model_name}")
                response = await client.post(
                    OLLAMA_URL,
                    json={
                        "model": model_name,
                        "prompt": prompt,
                        "stream": False,
                        "options": {
                            "temperature": 0.3,   # Low temp = more consistent output
                            "top_p": 0.9,
                            "num_predict": 1024
                        }
                    }
                )

                if response.status_code == 404:
                    continue

                if response.status_code != 200:
                    raise HTTPException(
                        status_code=502,
                        detail=f"Ollama server error ({response.status_code})"
                    )

                selected_model = model_name
                break

        if not response or not selected_model:
            if req.model:
                raise HTTPException(
                    status_code=503,
                    detail=(
                        f'Requested Ollama model "{req.model}" was not found. '
                        f'Install it with: ollama pull {req.model}'
                    ),
                )

            raise HTTPException(
                status_code=503,
                detail=(
                    "No compatible Ollama model was found. Install one of: "
                    + ", ".join(get_ollama_model_candidates())
                ),
            )

        raw_response = response.json().get("response", "")
        print(f"Ollama response received from {selected_model} ({len(raw_response)} chars)")

        # Parse JSON from response
        try:
            # Strip any markdown code fences if present
            clean = raw_response.strip()
            if clean.startswith("```"):
                clean = clean.split("```")[1]
                if clean.startswith("json"):
                    clean = clean[4:]
            clean = clean.strip()

            parsed = json.loads(clean)
            return SummaryResponse(
                success=True,
                summary=parsed.get("summary", ""),
                key_points=parsed.get("key_points", []),
                action_items=parsed.get("action_items", []),
                model=selected_model,
                kv_cache_type=OLLAMA_KV_CACHE_TYPE,
                raw=raw_response
            )
        except json.JSONDecodeError:
            # Fallback: return raw response as summary
            return SummaryResponse(
                success=True,
                summary=raw_response,
                key_points=[],
                action_items=[],
                model=selected_model,
                kv_cache_type=OLLAMA_KV_CACHE_TYPE,
                raw=raw_response
            )

    except httpx.ConnectError:
        raise HTTPException(
            status_code=503,
            detail="Cannot connect to Ollama. Make sure it's running: ollama serve"
        )
    except Exception as e:
        print(f"Summary error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/transcribe-and-summarize")
async def transcribe_and_summarize(
    file: UploadFile = File(...),
    summary_model: str | None = Form(None),
):
    """
    One-shot endpoint: transcribe + summarize in a single call.
    This is what the mobile app uses.
    """
    # Step 1: Transcribe
    transcribe_result = await transcribe_audio(file)

    if not transcribe_result.success:
        raise HTTPException(status_code=500, detail="Transcription failed")

    # Step 2: Summarize
    summary_result = await summarize_transcript(
        SummaryRequest(
            transcript=transcribe_result.transcript,
            model=summary_model,
        )
    )

    return {
        "success": True,
        "transcription": {
            "text": transcribe_result.transcript,
            "language": transcribe_result.language,
            "duration": transcribe_result.duration,
            "segments": transcribe_result.segments
        },
        "summary": {
            "text": summary_result.summary,
            "key_points": summary_result.key_points,
            "action_items": summary_result.action_items,
            "model": summary_result.model,
            "kv_cache_type": summary_result.kv_cache_type,
        }
    }
