// Media tools check. Drives agent/lib/media.ts directly under bun against a
// mock OpenAI-compatible / fal / Replicate / Pollinations server (proves the
// request shapes and where outputs land), then the local lanes that exist on
// this box (piper, espeak-ng, faster-whisper), one live Pollinations image,
// and the host side: Settings → Media masking, merging and runtime env.
//
//   bun tools/e2e-media.ts [--offline] [--no-runtime]
//
// The runtime section boots a host (mock model lane) and has the built agent
// call generate_image / generate_speech through [mock:tool …] (needs npx eve build).
//
// Local lanes are skipped (not failed) when their backend is missing:
//   OPENZO_PIPER_VOICES     dir(s) with piper *.onnx voices
//   OPENZO_WHISPER_PYTHON   a python with faster_whisper importable
//   OPENZO_WHISPER_MODEL    faster-whisper model for the local check (default base.en)
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const OFFLINE = process.argv.includes("--offline");
const NO_RUNTIME = process.argv.includes("--no-runtime");
const ROOT = join(import.meta.dir, "..");
const TMP = mkdtempSync(join(tmpdir(), "openzo-media-"));
const WS = join(TMP, "workspace");
mkdirSync(WS, { recursive: true });
process.env.OPENZO_WORKSPACE = WS;
process.env.OPENZO_DATA = join(TMP, "data");

let pass = 0;
let fail = 0;
let skip = 0;
function check(name: string, ok: unknown, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function skipped(name: string, why: string) {
  skip++;
  console.log(`  skip ${name} — ${why}`);
}
async function throws(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "";
  } catch (e) {
    return (e as Error).message;
  }
}
const real = (nominal: string) => join(WS, nominal.replace(/^\/workspace/, ""));
const has = (bin: string) => spawnSync("sh", ["-c", `command -v ${bin}`]).status === 0;

// 1x1 PNG, a tiny MP3-ish blob, a tiny MP4-ish blob.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const MP3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(64, 1)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(64, 2)]);
const KEY = "sk-test-media-0001";

// ------------------------------------------------------------------ mock server
const seen: Record<string, any[]> = {};
const log = (k: string, v: any) => (seen[k] ??= []).push(v);
let falPolls = 0;
let repPolls = 0;

const mock = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    const auth = req.headers.get("authorization");
    const b = `http://127.0.0.1:${mock.port}`;
    if (p === "/v1/images/generations") {
      const body = await req.json();
      log("gen", { auth, body });
      return Response.json({ data: Array.from({ length: body.n ?? 1 }, () => ({ b64_json: PNG.toString("base64") })) });
    }
    if (p === "/v1/images/edits") {
      const f = await req.formData();
      const img = f.get("image") as File | null;
      log("edit", { auth, model: f.get("model"), prompt: f.get("prompt"), size: f.get("size"), image: img ? { name: img.name, type: img.type, size: img.size } : null, multi: f.getAll("image[]").length, mask: !!f.get("mask") });
      return Response.json({ data: [{ url: `${b}/files/edited.png` }] });
    }
    if (p === "/files/edited.png") return new Response(PNG, { headers: { "content-type": "image/png" } });
    if (p === "/v1/audio/speech") {
      const body = await req.json();
      log("speech", { auth, body });
      return new Response(MP3, { headers: { "content-type": "audio/mpeg" } });
    }
    if (p === "/v1/audio/transcriptions") {
      const f = await req.formData();
      const file = f.get("file") as File;
      log("stt", { auth, model: f.get("model"), format: f.get("response_format"), language: f.get("language"), name: file?.name, size: file?.size });
      return Response.json({ text: "hello from the mock", language: "english", duration: 1.5, segments: [{ start: 0, end: 1.5, text: " hello from the mock" }] });
    }
    // Pollinations
    if (p.startsWith("/prompt/")) {
      log("poll", { prompt: decodeURIComponent(p.slice(8)), q: Object.fromEntries(url.searchParams) });
      return new Response(PNG, { headers: { "content-type": "image/jpeg" } });
    }
    // fal queue
    if (req.method === "POST" && p === "/fal/fal-ai/ltx-video") {
      log("fal", { auth, body: await req.json() });
      return Response.json({ request_id: "r1", status_url: `${b}/fal/status/r1`, response_url: `${b}/fal/result/r1` });
    }
    if (p === "/fal/status/r1") return Response.json({ status: ++falPolls < 2 ? "IN_PROGRESS" : "COMPLETED" });
    if (p === "/fal/result/r1") return Response.json({ video: { url: `${b}/files/clip.mp4` } });
    // replicate
    if (req.method === "POST" && p === "/rep/models/minimax/video-01/predictions") {
      log("rep", { auth, body: await req.json() });
      return Response.json({ id: "p1", status: "starting", urls: { get: `${b}/rep/predictions/p1` } });
    }
    if (p === "/rep/predictions/p1") return Response.json(++repPolls < 2 ? { id: "p1", status: "processing" } : { id: "p1", status: "succeeded", output: `${b}/files/clip.mp4` });
    if (p === "/files/clip.mp4") return new Response(MP4, { headers: { "content-type": "video/mp4" } });
    return new Response("not found", { status: 404 });
  },
});
const MOCK = `http://127.0.0.1:${mock.port}`;

const media = await import("../agent/lib/media.ts");
const setEnv = (vars: Record<string, string | undefined>) => {
  for (const k of Object.keys(process.env)) if (k.startsWith("OPENZO_MEDIA_") || k === "OPENZO_POLLINATIONS_IMAGE_URL") delete process.env[k];
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
};

try {
  // ---------------------------------------------------------------- images
  console.log("images (mock OpenAI-compatible)");
  setEnv({ OPENZO_MEDIA_IMAGE_PROVIDER: "openai-compatible", OPENZO_MEDIA_IMAGE_BASE_URL: `${MOCK}/v1`, OPENZO_MEDIA_IMAGE_API_KEY: KEY });
  const g = await media.generateImage({ prompt: "A red cube on a white table", aspect_ratio: "16:9", n: 2, quality: "low" });
  const gen = seen.gen?.[0];
  check("POST /images/generations with bearer key", gen?.auth === `Bearer ${KEY}`, JSON.stringify(gen));
  check("body: model gpt-image-1, n=2, 16:9 → 1536x1024, quality", gen?.body.model === "gpt-image-1" && gen.body.n === 2 && gen.body.size === "1536x1024" && gen.body.quality === "low" && !("response_format" in gen.body), JSON.stringify(gen?.body));
  check("two files saved under /workspace/Images", g.paths.length === 2 && g.paths.every((p) => p.startsWith("/workspace/Images/a-red-cube-on-a-white-") && p.endsWith(".png") && existsSync(real(p))), JSON.stringify(g.paths));
  check("saved bytes are the PNG", readFileSync(real(g.paths[0]!)).equals(PNG));

  const e = await media.editImage({ prompt: "make it blue", source_filepath: g.paths[0]!, size: "1024x1024" });
  const ed = seen.edit?.[0];
  check("POST /images/edits multipart: image file + prompt + model", ed?.image?.type === "image/png" && ed.image.size === PNG.length && ed.prompt === "make it blue" && ed.model === "gpt-image-1" && ed.size === "1024x1024" && ed.auth === `Bearer ${KEY}`, JSON.stringify(ed));
  check("edit result (url response) saved next to source as -edited", e.paths.length === 1 && /\/workspace\/Images\/a-red-cube-on-a-white-1-edited\.png$/.test(e.paths[0]!) && existsSync(real(e.paths[0]!)), JSON.stringify(e.paths));
  await media.editImage({ prompt: "combine", source_filepath: g.paths[0]!, reference_filepaths: [g.paths[1]!], file_suffix: "combo" });
  check("references go as image[] (source + refs)", seen.edit?.[1]?.multi === 2 && !seen.edit?.[1]?.image, JSON.stringify(seen.edit?.[1]));

  console.log("images (mock Pollinations)");
  setEnv({ OPENZO_MEDIA_IMAGE_PROVIDER: "pollinations", OPENZO_POLLINATIONS_IMAGE_URL: MOCK });
  const pg = await media.generateImage({ prompt: "tiny fox", aspect_ratio: "9:16", seed: 7, file_stem: "fox", output_dir: "/workspace/Art" });
  const pq = seen.poll?.[0];
  check("GET /prompt/<prompt>?width&height&model=flux&nologo&seed", pq?.prompt === "tiny fox" && pq.q.width === "576" && pq.q.height === "1024" && pq.q.model === "flux" && pq.q.nologo === "true" && pq.q.seed === "7", JSON.stringify(pq));
  check("file_stem + output_dir honoured, extension sniffed from bytes", pg.paths[0] === "/workspace/Art/fox.png" && existsSync(real(pg.paths[0]!)), JSON.stringify(pg.paths));
  const noEdit = await throws(() => media.editImage({ prompt: "x", source_filepath: pg.paths[0]! }));
  check("edit on the free lane fails with a clear message", /OpenAI-compatible image API/.test(noEdit) && /Settings → Media/.test(noEdit), noEdit);
  setEnv({});
  check("default image provider is pollinations", media.mediaStatus().image === "pollinations");

  // ---------------------------------------------------------------- speech
  console.log("speech (mock OpenAI-compatible)");
  setEnv({ OPENZO_MEDIA_SPEECH_PROVIDER: "openai-compatible", OPENZO_MEDIA_SPEECH_BASE_URL: `${MOCK}/v1`, OPENZO_MEDIA_SPEECH_API_KEY: KEY, OPENZO_MEDIA_SPEECH_VOICE: "nova" });
  const s = await media.generateSpeech({ text: "Hello there, world.", speed: 1.25, instructions: "cheerful" });
  const sp = seen.speech?.[0];
  check("POST /audio/speech: model, input, voice, format, speed, instructions", sp?.auth === `Bearer ${KEY}` && sp.body.model === "gpt-4o-mini-tts" && sp.body.input === "Hello there, world." && sp.body.voice === "nova" && sp.body.response_format === "mp3" && sp.body.speed === 1.25 && sp.body.instructions === "cheerful", JSON.stringify(sp));
  check("saved to /workspace/Audio/*.mp3", s.path === "/workspace/Audio/hello-there-world.mp3" && readFileSync(real(s.path)).equals(MP3), JSON.stringify(s));

  // ---------------------------------------------------------------- transcription (mock)
  console.log("transcription (mock OpenAI-compatible)");
  setEnv({ OPENZO_MEDIA_TRANSCRIBE_PROVIDER: "openai-compatible", OPENZO_MEDIA_TRANSCRIBE_BASE_URL: `${MOCK}/v1`, OPENZO_MEDIA_TRANSCRIBE_API_KEY: KEY });
  const t = await media.transcribe({ path: s.path, language: "en", output_format: "srt" });
  const st = seen.stt?.[0];
  check("POST /audio/transcriptions multipart: file, whisper-1, verbose_json, language", st?.auth === `Bearer ${KEY}` && st.model === "whisper-1" && st.format === "verbose_json" && st.language === "en" && st.name === "hello-there-world.mp3" && st.size === MP3.length, JSON.stringify(st));
  check("transcript returned + .transcript.txt + .srt written next to audio", t.transcript === "hello from the mock" && t.transcript_path === "/workspace/Audio/hello-there-world.srt" && existsSync(real("/workspace/Audio/hello-there-world.transcript.txt")) && readFileSync(real(t.transcript_path), "utf8").includes("00:00:00,000 --> 00:00:01,500"), JSON.stringify(t));
  await media.transcribe({ path: s.path, model: "gpt-4o-mini-transcribe" });
  check("gpt-4o-*-transcribe asks for json, not verbose_json", seen.stt?.[1]?.format === "json", JSON.stringify(seen.stt?.[1]));
  const missing = await throws(() => media.transcribe({ path: "/workspace/nope.mp3" }));
  check("missing file → clear error", /File not found: \/workspace\/nope\.mp3/.test(missing), missing);

  // ---------------------------------------------------------------- video
  console.log("video");
  setEnv({});
  const noVideo = await throws(() => media.generateVideo({ instruction: "a wave" }));
  check("unconfigured video explains how to configure, makes no call", /not configured/.test(noVideo) && /fal\.ai/.test(noVideo) && /Replicate/.test(noVideo), noVideo);
  setEnv({ OPENZO_MEDIA_VIDEO_PROVIDER: "fal", OPENZO_MEDIA_VIDEO_API_KEY: KEY, OPENZO_MEDIA_VIDEO_BASE_URL: `${MOCK}/fal` });
  const fv = await media.generateVideo({ instruction: "a slow wave at dusk", aspect_ratio: "16:9", duration_seconds: 5, poll_interval_ms: 10 });
  const fr = seen.fal?.[0];
  check("fal: POST queue/<model> with 'Key' auth + prompt", fr?.auth === `Key ${KEY}` && fr.body.prompt === "a slow wave at dusk" && fr.body.aspect_ratio === "16:9" && fr.body.duration === 5, JSON.stringify(fr));
  check("fal: polled to COMPLETED, video downloaded to /workspace/Videos", falPolls >= 2 && fv.path === "/workspace/Videos/a-slow-wave-at-dusk.mp4" && readFileSync(real(fv.path)).equals(MP4), JSON.stringify(fv));
  setEnv({ OPENZO_MEDIA_VIDEO_PROVIDER: "replicate", OPENZO_MEDIA_VIDEO_API_KEY: KEY, OPENZO_MEDIA_VIDEO_BASE_URL: `${MOCK}/rep` });
  const rv = await media.generateVideo({ instruction: "a cat", filepath: g.paths[0]!, poll_interval_ms: 10 });
  const rr = seen.rep?.[0];
  check("replicate: POST models/<model>/predictions, Bearer, first_frame_image data URI", rr?.auth === `Bearer ${KEY}` && rr.body.input.prompt === "a cat" && String(rr.body.input.first_frame_image).startsWith("data:image/png;base64,"), JSON.stringify(rr).slice(0, 300));
  check("replicate: polled to succeeded, saved", repPolls >= 2 && existsSync(real(rv.path)), JSON.stringify(rv));

  // ---------------------------------------------------------------- local TTS
  console.log("local speech");
  setEnv({ OPENZO_MEDIA_SPEECH_PROVIDER: "local" });
  const voices = media.piperVoices();
  let spoken: string | undefined;
  if (has("piper") && voices.length) {
    const ps = await media.generateSpeech({ text: "The quick brown fox jumps over the lazy dog.", file_stem: "piper-test", format: "wav" });
    spoken = real(ps.path);
    check(`piper (${ps.voice}) wrote a wav`, ps.provider === "piper" && readFileSync(spoken).subarray(0, 4).toString() === "RIFF" && ps.bytes > 10_000, JSON.stringify(ps));
    if (has("ffmpeg")) {
      const pm = await media.generateSpeech({ text: "Short mp3 test.", voice: "alan", format: "mp3" });
      check(`piper → ffmpeg mp3 (voice match '${pm.voice}')`, pm.path.endsWith(".mp3") && pm.bytes > 1000 && (pm.voice.includes("alan") || !voices.some((v) => v.name.includes("alan"))), JSON.stringify(pm));
    }
  } else skipped("piper", has("piper") ? `no voices in ${media.piperVoiceDirs().join(":")}` : "piper not installed");
  if (has("espeak-ng")) {
    setEnv({ OPENZO_MEDIA_SPEECH_PROVIDER: "espeak" });
    const es = await media.generateSpeech({ text: "espeak test", format: "wav" });
    check("espeak-ng wrote a wav", es.provider === "espeak-ng" && es.bytes > 1000, JSON.stringify(es));
    spoken ??= real(es.path);
  } else skipped("espeak-ng", "not installed");
  if (!has("piper") && !has("espeak-ng")) {
    const none = await throws(() => media.generateSpeech({ text: "x" }));
    check("no local TTS → clear error", /No speech backend/.test(none), none);
  }

  // ---------------------------------------------------------------- local STT
  console.log("local transcription");
  setEnv({ OPENZO_MEDIA_TRANSCRIBE_PROVIDER: "local" });
  const py = process.env.OPENZO_WHISPER_PYTHON ?? "python3";
  const fw = spawnSync(py, ["-c", "import faster_whisper"]).status === 0;
  if (fw && spoken) {
    const lt = await media.transcribe({ path: spoken.replace(WS, "/workspace"), model: process.env.OPENZO_WHISPER_MODEL ?? "base.en" });
    check("faster-whisper round-trips the piper audio", /quick brown fox/i.test(lt.transcript) && lt.provider === "faster-whisper", JSON.stringify(lt));
    if (has("ffmpeg")) {
      const vid = join(WS, "Videos", "talk.mp4");
      mkdirSync(join(WS, "Videos"), { recursive: true });
      const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=160x120", "-i", spoken, "-shortest", "-c:v", "libx264", "-c:a", "aac", vid]);
      if (r.status === 0) {
        const vt = await media.transcribe({ path: "/workspace/Videos/talk.mp4", model: process.env.OPENZO_WHISPER_MODEL ?? "base.en", output_format: "vtt" });
        check("transcribe_video: ffmpeg extracts audio, transcript + .vtt beside the video", /brown fox/i.test(vt.transcript) && vt.transcript_path === "/workspace/Videos/talk.vtt" && readFileSync(real(vt.transcript_path), "utf8").startsWith("WEBVTT"), JSON.stringify(vt));
      } else skipped("transcribe_video", `ffmpeg could not build a test video: ${r.stderr}`);
    }
  } else if (!fw) {
    const err = await throws(() => media.transcribe({ path: s.path }));
    check("no faster-whisper → clear error", /faster-whisper/.test(err), err);
    skipped("faster-whisper round trip", `${py} cannot import faster_whisper (set OPENZO_WHISPER_PYTHON)`);
  } else skipped("faster-whisper round trip", "no local TTS audio to transcribe");

  // ---------------------------------------------------------------- live Pollinations
  console.log("live Pollinations");
  if (OFFLINE) skipped("live Pollinations image", "--offline");
  else {
    setEnv({});
    try {
      const live = await media.generateImage({ prompt: "a small red cube on a white background", size: "256x256", seed: 3, file_stem: "live" });
      const bytes = readFileSync(real(live.paths[0]!));
      check("live Pollinations returned a real image", bytes.length > 1000 && (bytes[0] === 0xff || bytes[0] === 0x89), `${bytes.length} bytes`);
    } catch (e) {
      const m = (e as Error).message;
      if (/fetch failed|timed out|ENOTFOUND|ECONNREFUSED|HTTP 5\d\d|HTTP 429/i.test(m)) skipped("live Pollinations image", m.slice(0, 160));
      else check("live Pollinations image", false, m);
    }
  }

  // ---------------------------------------------------------------- host settings
  console.log("host Settings → Media");
  const { readSettings, mergeSettings, maskedSettings, runtimeEnv } = await import("../host/settings.ts");
  const user = (settings: object) => ({ id: 1, name: "t", email: null, pass: "", role: "user", disabled: 0, settings: JSON.stringify(settings), created: 0, last_seen: null }) as any;
  const empty = readSettings(user({}));
  check("defaults: media lanes exist and are empty", JSON.stringify(empty.media) === JSON.stringify({ image: {}, speech: {}, transcription: {}, video: {} }));
  let st1 = mergeSettings(empty, { media: { image: { provider: "openai-compatible", apiKey: "sk-image-1234", baseUrl: "http://127.0.0.1:9999/v1", model: "gpt-image-1" }, video: { provider: "fal", apiKey: "fal-abcd" }, speech: { provider: "bogus" } } });
  check("merge: provider validated, values stored", st1.media.image.provider === "openai-compatible" && st1.media.image.apiKey === "sk-image-1234" && st1.media.video.provider === "fal" && st1.media.speech.provider === undefined);
  const masked = maskedSettings(st1);
  check("keys masked like the others (••••1234)", masked.media.image.apiKey === "••••1234" && masked.media.video.apiKey === "••••abcd" && !JSON.stringify(masked).includes("sk-image-1234"));
  const st2 = mergeSettings(st1, JSON.parse(JSON.stringify(masked)));
  check("mask round-trip keeps the real key", st2.media.image.apiKey === "sk-image-1234" && st2.media.video.apiKey === "fal-abcd");
  const st3 = mergeSettings(st2, { model: { preset: "free" } });
  check("a save without media leaves media untouched", st3.media.image.apiKey === "sk-image-1234");
  const env1 = runtimeEnv(user(st2), { containerized: false });
  check("env: explicit openai-compatible image lane", env1.OPENZO_MEDIA_IMAGE_PROVIDER === "openai-compatible" && env1.OPENZO_MEDIA_IMAGE_API_KEY === "sk-image-1234" && env1.OPENZO_MEDIA_IMAGE_BASE_URL === "http://127.0.0.1:9999/v1");
  check("env: auto speech/transcription fall to local, video fal", env1.OPENZO_MEDIA_SPEECH_PROVIDER === "local" && env1.OPENZO_MEDIA_TRANSCRIBE_PROVIDER === "local" && env1.OPENZO_MEDIA_VIDEO_PROVIDER === "fal" && env1.OPENZO_MEDIA_VIDEO_API_KEY === "fal-abcd");
  const env2 = runtimeEnv(user(st2), { containerized: true });
  check("env: localhost base URL rewritten inside a container", env2.OPENZO_MEDIA_IMAGE_BASE_URL === "http://host.docker.internal:9999/v1");
  const oa = runtimeEnv(user({ model: { preset: "openai", apiKey: "sk-openai-9999" } }), { containerized: false });
  check("auto + OpenAI preset reuses its key for image, speech, transcription", oa.OPENZO_MEDIA_IMAGE_PROVIDER === "openai-compatible" && oa.OPENZO_MEDIA_IMAGE_API_KEY === "sk-openai-9999" && oa.OPENZO_MEDIA_SPEECH_API_KEY === "sk-openai-9999" && oa.OPENZO_MEDIA_TRANSCRIBE_BASE_URL === "https://api.openai.com/v1");
  const gq = runtimeEnv(user({ model: { preset: "groq", apiKey: "gsk-1" } }), { containerized: false });
  check("auto + Groq preset: transcription on Groq whisper, images on Pollinations", gq.OPENZO_MEDIA_TRANSCRIBE_BASE_URL === "https://api.groq.com/openai/v1" && gq.OPENZO_MEDIA_TRANSCRIBE_MODEL === "whisper-large-v3-turbo" && gq.OPENZO_MEDIA_IMAGE_PROVIDER === "pollinations" && gq.OPENZO_MEDIA_SPEECH_PROVIDER === "local");
  const fr2 = runtimeEnv(user({}), { containerized: false });
  check("auto + free preset: pollinations / local / local / none", fr2.OPENZO_MEDIA_IMAGE_PROVIDER === "pollinations" && fr2.OPENZO_MEDIA_SPEECH_PROVIDER === "local" && fr2.OPENZO_MEDIA_TRANSCRIBE_PROVIDER === "local" && fr2.OPENZO_MEDIA_VIDEO_PROVIDER === "none");

  // ---------------------------------------------------------------- through a real runtime
  console.log("runtime (host + built agent, mock model lane)");
  if (NO_RUNTIME) skipped("runtime turn", "--no-runtime");
  else if (!existsSync(join(ROOT, ".output/server/index.mjs"))) skipped("runtime turn", "no built agent (npx eve build)");
  else {
    const PORT = 19800 + Math.floor(Math.random() * 150);
    const BASE = `http://127.0.0.1:${PORT}`;
    const DATA = join(TMP, "hostdata");
    const hostEnv: Record<string, string> = { ...(process.env as Record<string, string>), OPENZO_DATA: DATA, OPENZO_PORT: String(PORT), OPENZO_DEFAULT_LANE: "mock", OPENZO_SIGNUP: "invite", OPENZO_PORT_BASE: String(PORT + 200) };
    for (const k of Object.keys(hostEnv)) if (k.startsWith("OPENZO_MEDIA_") || k === "OPENZO_WORKSPACE" || k === "OPENZO_POLLINATIONS_IMAGE_URL") delete hostEnv[k];
    const host = Bun.spawn(["bun", join(ROOT, "host/server.ts")], { env: hostEnv, stdout: "pipe", stderr: "pipe" });
    let token = "";
    const api = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(BASE + path, { method, headers: { ...(token ? { "x-openzo-session": token } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {}
      return { status: res.status, json, text, res };
    };
    const until = async <T,>(fn: () => T | Promise<T>, ms: number): Promise<T | undefined> => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const v = await fn();
        if (v) return v;
        await Bun.sleep(300);
      }
      return undefined;
    };
    try {
      await until(() => fetch(`${BASE}/api/health`).then((r) => r.ok, () => false), 15_000);
      const setup = await api("POST", "/api/setup", { name: "mia", password: "correct-horse-9" });
      token = setup.json?.token ?? "";
      check("host up, admin created", !!token, setup.text);
      const put = await api("PUT", "/api/settings", { media: { image: { provider: "openai-compatible", baseUrl: `${MOCK}/v1`, apiKey: "sk-runtime-7777" }, speech: { provider: "openai-compatible", baseUrl: `${MOCK}/v1`, apiKey: "sk-runtime-7777", voice: "shimmer" } } });
      check("PUT /api/settings stores media, returns it masked", put.status === 200 && put.json?.settings?.media?.image?.apiKey === "••••7777" && !put.text.includes("sk-runtime-7777"), put.text.slice(0, 300));
      const got = await api("GET", "/api/settings");
      check("GET /api/settings masks media keys", got.json?.settings?.media?.speech?.apiKey === "••••7777" && got.json.settings.media.speech.voice === "shimmer");
      const ws = join(DATA, "users/mia/workspace");
      const before = seen.gen?.length ?? 0;
      const turn = await api("POST", "/eve/v1/session", { message: `[mock:tool generate_image {"prompt":"runtime lighthouse","file_stem":"lighthouse"}]` });
      check("agent turn with generate_image started", !!turn.json?.sessionId, turn.text.slice(0, 300));
      const made = await until(() => existsSync(join(ws, "Images/lighthouse.png")), 90_000);
      check("runtime's generate_image hit the configured API and wrote /workspace/Images/lighthouse.png", made && seen.gen?.[before]?.auth === "Bearer sk-runtime-7777", JSON.stringify(seen.gen?.[before]));
      const raw = await fetch(`${BASE}/api/files/raw?path=${encodeURIComponent("/Images/lighthouse.png")}&oz_token=${encodeURIComponent(token)}`);
      check("the chat preview URL serves it (/api/files/raw?path=/Images/…&oz_token=)", raw.ok && Buffer.from(await raw.arrayBuffer()).equals(PNG));
      const sp0 = seen.speech?.length ?? 0;
      await api("POST", "/eve/v1/session", { message: `[mock:tool generate_speech {"text":"hello from the runtime","file_stem":"hello"}]` });
      const spoke = await until(() => existsSync(join(ws, "Audio/hello.mp3")), 90_000);
      check("runtime's generate_speech used the saved voice and wrote /workspace/Audio/hello.mp3", spoke && seen.speech?.[sp0]?.body?.voice === "shimmer", JSON.stringify(seen.speech?.[sp0]));
    } finally {
      host.kill("SIGTERM");
      await host.exited;
    }
  }
} catch (e) {
  check("unexpected exception", false, (e as Error).stack ?? String(e));
} finally {
  mock.stop(true);
  rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail ? 1 : 0);
