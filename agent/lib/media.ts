// Self-hosted media: images, speech, transcription, video. Zo runs these on its
// metered media gateway; openzo calls a backend directly. The host resolves the
// user's Settings → Media choices (including "auto") into OPENZO_MEDIA_* env:
//
//   OPENZO_MEDIA_IMAGE_PROVIDER       openai-compatible | pollinations (default)
//   OPENZO_MEDIA_IMAGE_{BASE_URL,API_KEY,MODEL}
//   OPENZO_MEDIA_SPEECH_PROVIDER      openai-compatible | piper | espeak | local (default: piper, then espeak-ng)
//   OPENZO_MEDIA_SPEECH_{BASE_URL,API_KEY,MODEL,VOICE}
//   OPENZO_MEDIA_TRANSCRIBE_PROVIDER  openai-compatible | local (default: faster-whisper)
//   OPENZO_MEDIA_TRANSCRIBE_{BASE_URL,API_KEY,MODEL}
//   OPENZO_MEDIA_VIDEO_PROVIDER       fal | replicate | none (default)
//   OPENZO_MEDIA_VIDEO_{API_KEY,MODEL,BASE_URL}
//   OPENZO_PIPER_VOICES               colon-separated dirs of piper *.onnx voices
//   OPENZO_WHISPER_PYTHON             python with faster_whisper importable (default python3)
//
// Every output lands in the workspace and is returned as a /workspace/… path.
// Self-contained on purpose (no eve imports) so tools/e2e-media.ts can drive it
// directly under bun.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";

const NOMINAL = "/workspace";
const env = (k: string) => process.env[k]?.trim() || undefined;

// ------------------------------------------------------------------ paths

export function workspaceRoot(): string {
  return resolve(env("OPENZO_WORKSPACE") ?? NOMINAL);
}

/** A path the agent gave (nominal /workspace/…, absolute, or workspace-relative) → real path. */
export function realPath(p: string): string {
  const root = workspaceRoot();
  if (p === NOMINAL || p.startsWith(`${NOMINAL}/`)) return join(root, p.slice(NOMINAL.length));
  if (isAbsolute(p)) return p;
  return join(root, p);
}

/** A real path → what the agent (and the UI) see: /workspace/… when inside the workspace. */
export function nominalPath(real: string): string {
  const root = workspaceRoot();
  if (real === root) return NOMINAL;
  if (real.startsWith(`${root}/`)) return `${NOMINAL}${real.slice(root.length)}`;
  return real;
}

function slug(text: string, fallback: string): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 6)
    .join("-")
    .slice(0, 48);
  return s || fallback;
}

function outPath(opts: { outputDir?: string; defaultDir: string; stem?: string; text: string; fallback: string; ext: string; index?: number }): string {
  const dir = realPath(opts.outputDir?.trim() || `${NOMINAL}/${opts.defaultDir}`);
  mkdirSync(dir, { recursive: true });
  const stem = opts.stem?.trim() ? opts.stem.trim().replace(/[\/\\]/g, "-") : slug(opts.text, opts.fallback);
  const suffix = opts.index === undefined ? "" : `-${opts.index + 1}`;
  let p = join(dir, `${stem}${suffix}.${opts.ext}`);
  if (existsSync(p)) p = join(dir, `${stem}${suffix}-${randomUUID().slice(0, 6)}.${opts.ext}`);
  return p;
}

const EXT_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

const TYPE_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  flac: "audio/flac",
  webm: "audio/webm",
  mp4: "video/mp4",
};

function sniffImageType(b: Uint8Array): string {
  if (b[0] === 0x89 && b[1] === 0x50) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57) return "image/webp";
  if (b[0] === 0x47 && b[1] === 0x49) return "image/gif";
  return "image/png";
}

function fileBlob(real: string): Blob {
  if (!existsSync(real)) throw new Error(`File not found: ${nominalPath(real)}`);
  const ext = extname(real).slice(1).toLowerCase();
  return new Blob([readFileSync(real)], { type: TYPE_BY_EXT[ext] ?? "application/octet-stream" });
}

const trimSlash = (u: string) => u.replace(/\/+$/, "");

async function failText(res: Response, what: string): Promise<never> {
  let body = "";
  try {
    body = (await res.text()).slice(0, 500);
  } catch {}
  throw new Error(`${what} failed: HTTP ${res.status} ${res.statusText}${body ? ` — ${body}` : ""}`);
}

function run(cmd: string, args: string[], input?: string | Uint8Array, timeoutMs = 300_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done, fail) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      fail(e);
      return;
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      fail(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code: code ?? 1, stdout, stderr });
    });
    child.stdin.on("error", () => {});
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

function which(bin: string): string | undefined {
  for (const dir of (process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin").split(":")) {
    const p = join(dir, bin);
    try {
      if (statSync(p).isFile()) return p;
    } catch {}
  }
  return undefined;
}

async function ffmpeg(args: string[]): Promise<void> {
  if (!which("ffmpeg")) throw new Error("ffmpeg is not installed in this runtime (needed to convert audio/video).");
  const r = await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
  if (r.code !== 0) throw new Error(`ffmpeg failed: ${r.stderr.slice(-400)}`);
}

// ------------------------------------------------------------------ config

export interface MediaStatus {
  image: string;
  speech: string;
  transcription: string;
  video: string;
}

function imageConfig() {
  const provider = env("OPENZO_MEDIA_IMAGE_PROVIDER") ?? "pollinations";
  return {
    provider: provider === "openai-compatible" ? "openai-compatible" : "pollinations",
    baseUrl: trimSlash(env("OPENZO_MEDIA_IMAGE_BASE_URL") ?? "https://api.openai.com/v1"),
    apiKey: env("OPENZO_MEDIA_IMAGE_API_KEY"),
    model: env("OPENZO_MEDIA_IMAGE_MODEL"),
  } as const;
}

function speechConfig() {
  return {
    provider: env("OPENZO_MEDIA_SPEECH_PROVIDER") ?? "local",
    baseUrl: trimSlash(env("OPENZO_MEDIA_SPEECH_BASE_URL") ?? "https://api.openai.com/v1"),
    apiKey: env("OPENZO_MEDIA_SPEECH_API_KEY"),
    model: env("OPENZO_MEDIA_SPEECH_MODEL"),
    voice: env("OPENZO_MEDIA_SPEECH_VOICE"),
  };
}

function transcribeConfig() {
  return {
    provider: env("OPENZO_MEDIA_TRANSCRIBE_PROVIDER") ?? "local",
    baseUrl: trimSlash(env("OPENZO_MEDIA_TRANSCRIBE_BASE_URL") ?? "https://api.openai.com/v1"),
    apiKey: env("OPENZO_MEDIA_TRANSCRIBE_API_KEY"),
    model: env("OPENZO_MEDIA_TRANSCRIBE_MODEL"),
  };
}

function videoConfig() {
  const provider = env("OPENZO_MEDIA_VIDEO_PROVIDER") ?? "none";
  return {
    provider,
    apiKey: env("OPENZO_MEDIA_VIDEO_API_KEY"),
    model: env("OPENZO_MEDIA_VIDEO_MODEL"),
    baseUrl: env("OPENZO_MEDIA_VIDEO_BASE_URL"),
  };
}

export function mediaStatus(): MediaStatus {
  return {
    image: imageConfig().provider,
    speech: speechConfig().provider,
    transcription: transcribeConfig().provider,
    video: videoConfig().provider,
  };
}

// ------------------------------------------------------------------ images

export interface ImageInput {
  prompt: string;
  file_stem?: string;
  output_dir?: string;
  aspect_ratio?: string;
  size?: string;
  n?: number;
  seed?: number;
  model?: string;
  quality?: string;
}

export interface ImageOutput {
  paths: string[];
  provider: string;
  model: string;
  prompt: string;
}

function ratio(aspect?: string): number {
  const m = aspect?.match(/^(\d+):(\d+)$/);
  if (!m) return 1;
  const r = Number(m[1]) / Number(m[2]);
  return r > 0 && Number.isFinite(r) ? r : 1;
}

// gpt-image-1 takes exactly three sizes; dall-e-3 its own three.
function openaiSize(model: string, input: { size?: string; aspect_ratio?: string }): string | undefined {
  if (input.size) return input.size;
  if (!input.aspect_ratio) return undefined;
  const r = ratio(input.aspect_ratio);
  if (model.startsWith("dall-e-3")) return r > 1.2 ? "1792x1024" : r < 0.83 ? "1024x1792" : "1024x1024";
  return r > 1.2 ? "1536x1024" : r < 0.83 ? "1024x1536" : "1024x1024";
}

function pixelSize(input: { size?: string; aspect_ratio?: string }): { width: number; height: number } {
  const m = input.size?.match(/^(\d+)x(\d+)$/);
  if (m) return { width: Math.min(2048, Number(m[1])), height: Math.min(2048, Number(m[2])) };
  const r = ratio(input.aspect_ratio);
  // Long side 1024, short side rounded to a multiple of 16.
  if (r >= 1) return { width: 1024, height: Math.round(1024 / r / 16) * 16 };
  return { width: Math.round((1024 * r) / 16) * 16, height: 1024 };
}

async function imageFromData(d: { b64_json?: string; url?: string }): Promise<Uint8Array> {
  if (d.b64_json) return new Uint8Array(Buffer.from(d.b64_json, "base64"));
  if (d.url) {
    const r = await fetch(d.url);
    if (!r.ok) await failText(r, "Downloading the generated image");
    return new Uint8Array(await r.arrayBuffer());
  }
  throw new Error("The image API returned neither b64_json nor url.");
}

function saveImages(images: Uint8Array[], input: { prompt: string; file_stem?: string; output_dir?: string }, fallback: string): string[] {
  return images.map((bytes, i) => {
    const ext = EXT_BY_TYPE[sniffImageType(bytes)] ?? "png";
    const p = outPath({ outputDir: input.output_dir, defaultDir: "Images", stem: input.file_stem, text: input.prompt, fallback, ext, index: images.length > 1 ? i : undefined });
    writeFileSync(p, bytes);
    return nominalPath(p);
  });
}

export async function generateImage(input: ImageInput): Promise<ImageOutput> {
  const cfg = imageConfig();
  const n = Math.max(1, Math.min(4, input.n ?? 1));
  if (cfg.provider === "openai-compatible") {
    const model = input.model ?? cfg.model ?? "gpt-image-1";
    const size = openaiSize(model, input);
    const body: Record<string, unknown> = { model, prompt: input.prompt, n };
    if (size) body.size = size;
    if (input.quality) body.quality = input.quality;
    if (model.startsWith("dall-e")) body.response_format = "b64_json";
    const res = await fetch(`${cfg.baseUrl}/images/generations`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
      body: JSON.stringify(body),
    });
    if (!res.ok) await failText(res, "Image generation");
    const json = (await res.json()) as { data?: { b64_json?: string; url?: string }[] };
    const images = await Promise.all((json.data ?? []).map(imageFromData));
    if (!images.length) throw new Error("The image API returned no images.");
    return { paths: saveImages(images, input, "image"), provider: "openai-compatible", model, prompt: input.prompt };
  }
  // Keyless free lane. One request per image; distinct seeds so n>1 differs.
  const model = input.model ?? cfg.model ?? "flux";
  const { width, height } = pixelSize(input);
  const base = trimSlash(env("OPENZO_POLLINATIONS_IMAGE_URL") ?? "https://image.pollinations.ai");
  const seed0 = input.seed ?? Math.floor(Math.random() * 1_000_000_000);
  const images: Uint8Array[] = [];
  for (let i = 0; i < n; i++) {
    const qs = new URLSearchParams({ width: String(width), height: String(height), model, nologo: "true", seed: String(seed0 + i) });
    const res = await fetch(`${base}/prompt/${encodeURIComponent(input.prompt)}?${qs}`, { signal: AbortSignal.timeout(180_000) });
    if (!res.ok) await failText(res, "Pollinations image generation");
    const type = res.headers.get("content-type") ?? "";
    if (!type.startsWith("image/")) throw new Error(`Pollinations returned ${type || "no content type"} instead of an image.`);
    images.push(new Uint8Array(await res.arrayBuffer()));
  }
  return { paths: saveImages(images, input, "image"), provider: "pollinations", model, prompt: input.prompt };
}

export interface EditImageInput {
  prompt: string;
  source_filepath: string;
  mask_filepath?: string;
  reference_filepaths?: string[];
  file_suffix?: string;
  output_dir?: string;
  size?: string;
  aspect_ratio?: string;
  model?: string;
  quality?: string;
}

export async function editImage(input: EditImageInput): Promise<ImageOutput> {
  const cfg = imageConfig();
  if (cfg.provider !== "openai-compatible") {
    throw new Error(
      "Image editing needs an OpenAI-compatible image API (e.g. OpenAI gpt-image-1). The keyless Pollinations lane can only edit images it can fetch from a public URL, and your workspace is private. Set Settings → Media → Images to an OpenAI-compatible provider with a key, or use the OpenAI model preset. Alternatively, describe the full desired image to generate_image.",
    );
  }
  const model = input.model ?? cfg.model ?? "gpt-image-1";
  const src = realPath(input.source_filepath);
  const form = new FormData();
  form.set("model", model);
  form.set("prompt", input.prompt);
  const refs = (input.reference_filepaths ?? []).map(realPath);
  if (refs.length) {
    for (const p of [src, ...refs]) form.append("image[]", fileBlob(p), basename(p));
  } else {
    form.set("image", fileBlob(src), basename(src));
  }
  if (input.mask_filepath) {
    const m = realPath(input.mask_filepath);
    form.set("mask", fileBlob(m), basename(m));
  }
  const size = openaiSize(model, input);
  if (size) form.set("size", size);
  if (input.quality) form.set("quality", input.quality);
  if (model.startsWith("dall-e")) form.set("response_format", "b64_json");
  const res = await fetch(`${cfg.baseUrl}/images/edits`, {
    method: "POST",
    headers: cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {},
    body: form,
  });
  if (!res.ok) await failText(res, "Image edit");
  const json = (await res.json()) as { data?: { b64_json?: string; url?: string }[] };
  const images = await Promise.all((json.data ?? []).map(imageFromData));
  if (!images.length) throw new Error("The image API returned no images.");
  const stem = `${basename(src, extname(src))}-${input.file_suffix?.trim() || "edited"}`;
  const outputDir = input.output_dir ?? nominalPath(dirname(src));
  return { paths: saveImages(images, { prompt: input.prompt, file_stem: stem, output_dir: outputDir }, "edited"), provider: "openai-compatible", model, prompt: input.prompt };
}

// ------------------------------------------------------------------ speech

export interface SpeechInput {
  text: string;
  file_stem?: string;
  output_dir?: string;
  voice?: string;
  format?: "mp3" | "wav";
  speed?: number;
  instructions?: string;
  language?: string;
  model?: string;
}

export interface SpeechOutput {
  path: string;
  provider: string;
  model: string;
  voice: string;
  format: string;
  bytes: number;
}

export function piperVoiceDirs(): string[] {
  const dirs = (env("OPENZO_PIPER_VOICES") ?? "").split(":").filter(Boolean);
  dirs.push("/opt/piper-voices", "/usr/share/piper-voices", "/usr/local/share/piper-voices", join(homedir(), ".local/share/piper-voices"), join(workspaceRoot(), ".piper-voices"));
  return dirs;
}

export function piperVoices(): { name: string; path: string }[] {
  const out: { name: string; path: string }[] = [];
  const seen = new Set<string>();
  for (const d of piperVoiceDirs()) {
    let names: string[] = [];
    try {
      names = readdirSync(d);
    } catch {
      continue;
    }
    for (const f of names.sort()) {
      if (!f.endsWith(".onnx") || !names.includes(`${f}.json`)) continue;
      const name = f.slice(0, -5);
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ name, path: join(d, f) });
    }
  }
  return out;
}

function pickPiperVoice(want: string | undefined, language: string | undefined) {
  const voices = piperVoices();
  if (!voices.length) return undefined;
  if (want) {
    const w = want.toLowerCase();
    const hit = voices.find((v) => v.name.toLowerCase() === w) ?? voices.find((v) => v.name.toLowerCase().includes(w));
    if (hit) return hit;
  }
  if (language && language !== "auto") {
    const l = language.toLowerCase().replace("-", "_");
    const hit = voices.find((v) => v.name.toLowerCase().startsWith(l));
    if (hit) return hit;
  }
  return voices.find((v) => v.name.startsWith("en_US")) ?? voices[0];
}

async function toFormat(wav: string, dest: string, format: string): Promise<void> {
  if (format === "wav") {
    writeFileSync(dest, readFileSync(wav));
    return;
  }
  await ffmpeg(["-i", wav, "-codec:a", "libmp3lame", "-q:a", "3", dest]);
}

export async function generateSpeech(input: SpeechInput): Promise<SpeechOutput> {
  const cfg = speechConfig();
  const format = input.format ?? "mp3";
  const dest = outPath({ outputDir: input.output_dir, defaultDir: "Audio", stem: input.file_stem, text: input.text, fallback: "speech", ext: format });
  const done = (provider: string, model: string, voice: string): SpeechOutput => ({ path: nominalPath(dest), provider, model, voice, format, bytes: statSync(dest).size });

  if (cfg.provider === "openai-compatible") {
    const model = input.model ?? cfg.model ?? "gpt-4o-mini-tts";
    const voice = input.voice ?? cfg.voice ?? "alloy";
    const body: Record<string, unknown> = { model, input: input.text, voice, response_format: format };
    if (input.speed) body.speed = input.speed;
    if (input.instructions) body.instructions = input.instructions;
    const res = await fetch(`${cfg.baseUrl}/audio/speech`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
      body: JSON.stringify(body),
    });
    if (!res.ok) await failText(res, "Speech generation");
    writeFileSync(dest, new Uint8Array(await res.arrayBuffer()));
    return done("openai-compatible", model, voice);
  }

  const tmp = join(tmpdir(), `openzo-tts-${randomUUID()}.wav`);
  try {
    const wantPiper = cfg.provider === "piper" || cfg.provider === "local";
    const voiceName = input.voice ?? cfg.voice;
    if (wantPiper && which("piper")) {
      const v = pickPiperVoice(voiceName, input.language);
      if (v) {
        const args = ["--model", v.path, "--output_file", tmp];
        if (input.speed) args.push("--length_scale", (1 / input.speed).toFixed(3));
        const r = await run("piper", args, input.text);
        if (r.code !== 0 || !existsSync(tmp)) throw new Error(`piper failed: ${r.stderr.slice(-400)}`);
        await toFormat(tmp, dest, format);
        return done("piper", "piper", v.name);
      }
      if (cfg.provider === "piper") throw new Error(`piper is installed but no voices were found. Put a voice (*.onnx + *.onnx.json from huggingface.co/rhasspy/piper-voices) in one of: ${piperVoiceDirs().join(", ")}.`);
    } else if (cfg.provider === "piper") {
      throw new Error("piper is not installed in this runtime.");
    }
    const espeak = which("espeak-ng") ?? which("espeak");
    if (!espeak) {
      throw new Error(
        "No speech backend: neither piper (with a voice) nor espeak-ng is available in this runtime. Configure Settings → Media → Speech with an OpenAI-compatible API key, or install piper/espeak-ng.",
      );
    }
    const voice = voiceName && /^[a-z]{2,3}([-_][a-z0-9]+)*$/i.test(voiceName) ? voiceName : input.language && input.language !== "auto" ? input.language : "en";
    const args = ["-v", voice, "-w", tmp, "--stdin"];
    if (input.speed) args.push("-s", String(Math.round(175 * input.speed)));
    const r = await run(espeak, args, input.text);
    if (r.code !== 0 || !existsSync(tmp)) throw new Error(`espeak-ng failed: ${r.stderr.slice(-400)}`);
    await toFormat(tmp, dest, format);
    return done("espeak-ng", "espeak-ng", voice);
  } finally {
    rmSync(tmp, { force: true });
  }
}

// ------------------------------------------------------------------ transcription

export interface TranscribeInput {
  path: string;
  language?: string;
  model?: string;
  output_format?: "text" | "srt" | "vtt" | "json";
}

export interface Segment {
  start: number;
  end: number;
  text: string;
}

export interface TranscribeOutput {
  transcript: string;
  truncated: boolean;
  transcript_path: string;
  segments_count: number;
  language?: string;
  duration_seconds?: number;
  provider: string;
  model: string;
}

const INLINE_LIMIT = 20_000;
const VIDEO_EXT = new Set(["mp4", "mov", "mkv", "webm", "avi", "m4v", "flv", "wmv", "mpeg", "mpg", "3gp"]);

function stamp(sec: number, sep: string): string {
  const ms = Math.round(sec * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms % 1000, 3)}`;
}

function captions(segments: Segment[], kind: "srt" | "vtt"): string {
  const sep = kind === "srt" ? "," : ".";
  const body = segments.map((s, i) => `${kind === "srt" ? `${i + 1}\n` : ""}${stamp(s.start, sep)} --> ${stamp(s.end, sep)}\n${s.text.trim()}\n`).join("\n");
  return kind === "vtt" ? `WEBVTT\n\n${body}` : body;
}

const WHISPER_SCRIPT = `
import json, sys
from faster_whisper import WhisperModel
path, model, lang = sys.argv[1], sys.argv[2], sys.argv[3]
m = WhisperModel(model, device="cpu", compute_type="int8", cpu_threads=2)
segs, info = m.transcribe(path, language=(lang or None), vad_filter=True)
out = [{"start": s.start, "end": s.end, "text": s.text} for s in segs]
print(json.dumps({"segments": out, "language": info.language, "duration": info.duration}))
`;

async function transcribeLocal(audio: string, model: string, language?: string): Promise<{ text: string; segments: Segment[]; language?: string; duration?: number }> {
  const py = env("OPENZO_WHISPER_PYTHON") ?? "python3";
  let r;
  try {
    r = await run(py, ["-c", WHISPER_SCRIPT, audio, model, language && language !== "auto" ? language : ""], undefined, 1_800_000);
  } catch (e) {
    throw new Error(`Local transcription could not start ${py}: ${(e as Error).message}`);
  }
  if (r.code !== 0) {
    if (/No module named ['"]?faster_whisper/.test(r.stderr)) {
      throw new Error(
        "Local transcription needs the faster-whisper Python package (`pip install faster-whisper`), or configure Settings → Media → Transcription with an OpenAI-compatible key (OpenAI whisper-1 or Groq whisper-large-v3).",
      );
    }
    throw new Error(`Local transcription failed: ${r.stderr.slice(-600)}`);
  }
  const json = JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}") as { segments: Segment[]; language?: string; duration?: number };
  return { text: json.segments.map((s) => s.text.trim()).join(" ").trim(), segments: json.segments, language: json.language, duration: json.duration };
}

async function transcribeRemote(cfg: ReturnType<typeof transcribeConfig>, audio: string, model: string, language?: string) {
  const form = new FormData();
  form.set("file", fileBlob(audio), basename(audio));
  form.set("model", model);
  // gpt-4o-*-transcribe only speaks json/text; whisper (OpenAI, Groq) gives segments with verbose_json.
  const verbose = !model.startsWith("gpt-4o");
  form.set("response_format", verbose ? "verbose_json" : "json");
  if (language && language !== "auto") form.set("language", language);
  const res = await fetch(`${cfg.baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {},
    body: form,
  });
  if (!res.ok) await failText(res, "Transcription");
  const json = (await res.json()) as { text?: string; language?: string; duration?: number; segments?: Segment[] };
  return {
    text: (json.text ?? "").trim(),
    segments: (json.segments ?? []).map((s) => ({ start: Number(s.start), end: Number(s.end), text: String(s.text) })),
    language: json.language,
    duration: json.duration,
  };
}

export async function transcribe(input: TranscribeInput): Promise<TranscribeOutput> {
  const cfg = transcribeConfig();
  const src = realPath(input.path);
  if (!existsSync(src)) throw new Error(`File not found: ${nominalPath(src)}`);
  const ext = extname(src).slice(1).toLowerCase();
  const remote = cfg.provider === "openai-compatible";
  // Video → audio always; remote APIs cap uploads at 25 MB, so big audio is squeezed to 16 kHz mono mp3.
  let audio = src;
  let tmp: string | undefined;
  if (VIDEO_EXT.has(ext) || (remote && (statSync(src).size > 24 * 1024 * 1024 || !TYPE_BY_EXT[ext]))) {
    tmp = join(tmpdir(), `openzo-stt-${randomUUID()}.mp3`);
    await ffmpeg(["-i", src, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", tmp]);
    audio = tmp;
  }
  try {
    const model = input.model ?? cfg.model ?? (remote ? "whisper-1" : "base");
    const r = remote ? await transcribeRemote(cfg, audio, model, input.language) : await transcribeLocal(audio, model, input.language);
    const fmt = input.output_format ?? "text";
    const stem = join(dirname(src), basename(src, extname(src)));
    let outFile = `${stem}.transcript.txt`;
    writeFileSync(outFile, `${r.text}\n`);
    if (fmt === "json") {
      outFile = `${stem}.transcript.json`;
      writeFileSync(outFile, JSON.stringify({ text: r.text, language: r.language, duration: r.duration, segments: r.segments }, null, 2));
    } else if ((fmt === "srt" || fmt === "vtt") && r.segments.length) {
      outFile = `${stem}.${fmt}`;
      writeFileSync(outFile, captions(r.segments, fmt));
    }
    const truncated = r.text.length > INLINE_LIMIT;
    return {
      transcript: truncated ? `${r.text.slice(0, INLINE_LIMIT)}…` : r.text,
      truncated,
      transcript_path: nominalPath(outFile),
      segments_count: r.segments.length,
      ...(r.language ? { language: r.language } : {}),
      ...(r.duration ? { duration_seconds: r.duration } : {}),
      provider: remote ? "openai-compatible" : "faster-whisper",
      model,
    };
  } finally {
    if (tmp) rmSync(tmp, { force: true });
  }
}

// ------------------------------------------------------------------ video

export interface VideoInput {
  instruction: string;
  filepath?: string;
  duration_seconds?: number;
  aspect_ratio?: string;
  model?: string;
  file_stem?: string;
  output_dir?: string;
  poll_interval_ms?: number;
}

export interface VideoOutput {
  path: string;
  provider: string;
  model: string;
  bytes: number;
}

const NO_VIDEO =
  "Video generation is not configured. openzo does not fake it and has no free video lane. In Settings → Media → Video pick fal.ai or Replicate and paste that provider's API key (fal.ai: fal.ai/dashboard/keys; Replicate: replicate.com/account/api-tokens). Optionally set a model id (defaults: fal-ai/ltx-video, minimax/video-01).";

function dataUri(real: string): string {
  const b = fileBlob(real);
  return `data:${b.type};base64,${readFileSync(real).toString("base64")}`;
}

function findUrl(x: unknown): string | undefined {
  if (typeof x === "string") return /^https?:\/\//.test(x) ? x : undefined;
  if (Array.isArray(x)) {
    for (const y of x) {
      const u = findUrl(y);
      if (u) return u;
    }
    return undefined;
  }
  if (x && typeof x === "object") {
    const o = x as Record<string, unknown>;
    for (const k of ["video", "url", "output", "videos"]) {
      const u = findUrl(o[k]);
      if (u) return u;
    }
  }
  return undefined;
}

export async function generateVideo(input: VideoInput): Promise<VideoOutput> {
  const cfg = videoConfig();
  if ((cfg.provider !== "fal" && cfg.provider !== "replicate") || !cfg.apiKey) throw new Error(NO_VIDEO);
  const poll = input.poll_interval_ms ?? 3000;
  const deadline = Date.now() + 15 * 60_000;
  const image = input.filepath ? dataUri(realPath(input.filepath)) : undefined;
  let url: string | undefined;
  let model: string;

  if (cfg.provider === "fal") {
    const base = trimSlash(cfg.baseUrl ?? "https://queue.fal.run");
    model = input.model ?? cfg.model ?? (image ? "fal-ai/ltx-video/image-to-video" : "fal-ai/ltx-video");
    const headers = { authorization: `Key ${cfg.apiKey}`, "content-type": "application/json" };
    const body: Record<string, unknown> = { prompt: input.instruction };
    if (image) body.image_url = image;
    if (input.aspect_ratio) body.aspect_ratio = input.aspect_ratio;
    if (input.duration_seconds) body.duration = input.duration_seconds;
    const res = await fetch(`${base}/${model}`, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) await failText(res, "fal.ai video submit");
    const job = (await res.json()) as { status_url?: string; response_url?: string; request_id?: string };
    const statusUrl = job.status_url ?? `${base}/${model}/requests/${job.request_id}/status`;
    const responseUrl = job.response_url ?? `${base}/${model}/requests/${job.request_id}`;
    for (;;) {
      if (Date.now() > deadline) throw new Error("fal.ai video generation timed out after 15 minutes.");
      const s = await fetch(statusUrl, { headers });
      if (!s.ok) await failText(s, "fal.ai status");
      const st = (await s.json()) as { status?: string; error?: string };
      if (st.status === "COMPLETED") break;
      if (st.status === "FAILED" || st.status === "ERROR") throw new Error(`fal.ai video generation failed: ${st.error ?? st.status}`);
      await new Promise((r) => setTimeout(r, poll));
    }
    const out = await fetch(responseUrl, { headers });
    if (!out.ok) await failText(out, "fal.ai result");
    url = findUrl(await out.json());
  } else {
    const base = trimSlash(cfg.baseUrl ?? "https://api.replicate.com/v1");
    model = input.model ?? cfg.model ?? "minimax/video-01";
    const headers = { authorization: `Bearer ${cfg.apiKey}`, "content-type": "application/json" };
    const inp: Record<string, unknown> = { prompt: input.instruction };
    if (image) inp.first_frame_image = image;
    if (input.aspect_ratio) inp.aspect_ratio = input.aspect_ratio;
    if (input.duration_seconds) inp.duration = input.duration_seconds;
    const [path, version] = model.split(":");
    const submit = version
      ? fetch(`${base}/predictions`, { method: "POST", headers, body: JSON.stringify({ version, input: inp }) })
      : fetch(`${base}/models/${path}/predictions`, { method: "POST", headers, body: JSON.stringify({ input: inp }) });
    const res = await submit;
    if (!res.ok) await failText(res, "Replicate video submit");
    let pred = (await res.json()) as { status?: string; output?: unknown; error?: string; urls?: { get?: string }; id?: string };
    while (pred.status !== "succeeded") {
      if (pred.status === "failed" || pred.status === "canceled") throw new Error(`Replicate video generation ${pred.status}: ${pred.error ?? ""}`);
      if (Date.now() > deadline) throw new Error("Replicate video generation timed out after 15 minutes.");
      await new Promise((r) => setTimeout(r, poll));
      const g = await fetch(pred.urls?.get ?? `${base}/predictions/${pred.id}`, { headers });
      if (!g.ok) await failText(g, "Replicate status");
      pred = (await g.json()) as typeof pred;
    }
    url = findUrl(pred.output);
  }
  if (!url) throw new Error(`${cfg.provider} finished but returned no video URL.`);
  const v = await fetch(url);
  if (!v.ok) await failText(v, "Downloading the generated video");
  const bytes = new Uint8Array(await v.arrayBuffer());
  const type = v.headers.get("content-type") ?? "";
  const ext = EXT_BY_TYPE[type.split(";")[0]!.trim()] ?? (extname(new URL(url).pathname).slice(1) || "mp4");
  const dest = outPath({ outputDir: input.output_dir, defaultDir: "Videos", stem: input.file_stem, text: input.instruction, fallback: "video", ext });
  writeFileSync(dest, bytes);
  return { path: nominalPath(dest), provider: cfg.provider, model, bytes: bytes.length };
}
