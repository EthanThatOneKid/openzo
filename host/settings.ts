// Per-user settings → the env a user's runtime boots with. Secrets never leave
// the host in clear: the API returns them masked and accepts the mask back as
// "unchanged".
import { config } from "./config";
import type { User } from "./db";

export interface ModelSettings {
  preset: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  fastModel?: string;
  visionModel?: string;
  contextWindow?: number;
}

export interface Settings {
  model: ModelSettings;
  search: { searxngUrl?: string; braveKey?: string; tavilyKey?: string; exaKey?: string };
  media: MediaSettings;
  persona: string;
  rules: string;
  secrets: { name: string; value: string }[];
}

// Media tools (generate_image, generate_speech, transcribe_*, generate_video).
// "auto" reuses the model preset's key where that provider has the API (OpenAI
// for everything, Groq for transcription), else the free/local lane.
export interface MediaLane {
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}
export interface MediaSettings {
  image: MediaLane;
  speech: MediaLane & { voice?: string };
  transcription: MediaLane;
  video: { provider?: string; apiKey?: string; model?: string };
}

export const MEDIA_PROVIDERS = {
  image: ["auto", "openai-compatible", "pollinations"],
  speech: ["auto", "openai-compatible", "piper", "espeak"],
  transcription: ["auto", "openai-compatible", "local"],
  video: ["none", "fal", "replicate"],
} as const;

export interface Preset {
  id: string;
  label: string;
  hint: string;
  baseUrl?: string;
  needsKey: boolean;
  defaultModel?: string;
  defaultFast?: string;
}

export const PRESETS: Preset[] = [
  {
    id: "free",
    label: "Free (Pollinations)",
    hint: "Keyless, rate-limited community endpoint (gpt-oss-20b). Good for trying openzo; not for private data.",
    baseUrl: "https://text.pollinations.ai/openai",
    needsKey: false,
    defaultModel: "openai",
    defaultFast: "openai",
  },
  { id: "openai", label: "OpenAI", hint: "api.openai.com", baseUrl: "https://api.openai.com/v1", needsKey: true, defaultModel: "gpt-4.1", defaultFast: "gpt-4.1-mini" },
  { id: "anthropic", label: "Anthropic", hint: "Claude via Anthropic's OpenAI-compatible endpoint", needsKey: true, defaultModel: "claude-sonnet-5-5", defaultFast: "claude-haiku-5-5" },
  { id: "openrouter", label: "OpenRouter", hint: "One key, hundreds of models", baseUrl: "https://openrouter.ai/api/v1", needsKey: true, defaultModel: "anthropic/claude-sonnet-5.5", defaultFast: "openai/gpt-4.1-mini" },
  { id: "groq", label: "Groq", hint: "Very fast open models", baseUrl: "https://api.groq.com/openai/v1", needsKey: true, defaultModel: "openai/gpt-oss-120b", defaultFast: "openai/gpt-oss-20b" },
  { id: "ollama", label: "Ollama (local)", hint: "A local Ollama server; models must support tool calls", baseUrl: "http://127.0.0.1:11434/v1", needsKey: false, defaultModel: "qwen3:8b", defaultFast: "qwen3:8b" },
  { id: "gateway", label: "Vercel AI Gateway", hint: "AI_GATEWAY_API_KEY with catalog slugs", needsKey: true, defaultModel: "anthropic/claude-sonnet-5", defaultFast: "anthropic/claude-haiku-4.5" },
  { id: "custom", label: "Custom OpenAI-compatible", hint: "vLLM, LM Studio, Together, DeepSeek, Fireworks…", needsKey: false },
  { id: "mock", label: "Mock (testing)", hint: "Scripted replies, no network. For checking the stack.", needsKey: false },
];

const MASK = "••••";

export function readSettings(user: User): Settings {
  let raw: Partial<Settings> = {};
  try {
    raw = JSON.parse(user.settings || "{}");
  } catch {}
  return {
    model: { preset: config.defaultLane, ...(raw.model ?? {}) },
    search: raw.search ?? {},
    media: {
      image: raw.media?.image ?? {},
      speech: raw.media?.speech ?? {},
      transcription: raw.media?.transcription ?? {},
      video: raw.media?.video ?? {},
    },
    persona: raw.persona ?? "",
    rules: raw.rules ?? "",
    secrets: raw.secrets ?? [],
  };
}

const mask = (v?: string) => (v ? `${MASK}${v.slice(-4)}` : "");

export function maskedSettings(s: Settings) {
  return {
    ...s,
    model: { ...s.model, apiKey: mask(s.model.apiKey) },
    search: {
      searxngUrl: s.search.searxngUrl ?? "",
      braveKey: mask(s.search.braveKey),
      tavilyKey: mask(s.search.tavilyKey),
      exaKey: mask(s.search.exaKey),
    },
    media: {
      image: { ...s.media.image, apiKey: mask(s.media.image.apiKey) },
      speech: { ...s.media.speech, apiKey: mask(s.media.speech.apiKey) },
      transcription: { ...s.media.transcription, apiKey: mask(s.media.transcription.apiKey) },
      video: { ...s.media.video, apiKey: mask(s.media.video.apiKey) },
    },
    secrets: s.secrets.map((x) => ({ name: x.name, value: mask(x.value) })),
  };
}

const keep = (next: unknown, prev?: string) =>
  typeof next === "string" && next.startsWith(MASK) ? prev : typeof next === "string" ? next.trim() || undefined : prev;

const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const RESERVED = /^(OPENZO_|WORKFLOW_|PORT$|HOST$|NITRO_|NODE_|PATH$|HOME$)/;

const str = (next: unknown, prev?: string) => (typeof next === "string" ? next.trim() || undefined : prev);

function mergeLane<T extends Record<string, string | undefined>>(prev: T, next: any, providers: readonly string[], fields: string[]): T {
  const out: Record<string, string | undefined> = {};
  out.provider = providers.includes(next?.provider) ? next.provider : prev.provider;
  out.apiKey = keep(next?.apiKey, prev.apiKey);
  for (const f of fields) out[f] = str(next?.[f], prev[f]);
  return out as T;
}

function mergeMedia(prev: MediaSettings, m: any): MediaSettings {
  return {
    image: mergeLane(prev.image as Record<string, string | undefined>, m?.image, MEDIA_PROVIDERS.image, ["baseUrl", "model"]),
    speech: mergeLane(prev.speech as Record<string, string | undefined>, m?.speech, MEDIA_PROVIDERS.speech, ["baseUrl", "model", "voice"]),
    transcription: mergeLane(prev.transcription as Record<string, string | undefined>, m?.transcription, MEDIA_PROVIDERS.transcription, ["baseUrl", "model"]),
    video: mergeLane(prev.video as Record<string, string | undefined>, m?.video, MEDIA_PROVIDERS.video, ["model"]),
  };
}

export function mergeSettings(prev: Settings, input: any): Settings {
  const m = input?.model ?? {};
  const s = input?.search ?? {};
  const prevSecrets = new Map(prev.secrets.map((x) => [x.name, x.value]));
  const secrets = Array.isArray(input?.secrets)
    ? input.secrets
        .filter((x: any) => typeof x?.name === "string" && ENV_NAME.test(x.name) && !RESERVED.test(x.name))
        .map((x: any) => ({ name: x.name, value: keep(x.value, prevSecrets.get(x.name)) ?? "" }))
        .filter((x: any) => x.value)
    : prev.secrets;
  const preset = PRESETS.some((p) => p.id === m.preset) ? m.preset : prev.model.preset;
  return {
    model: {
      preset,
      baseUrl: typeof m.baseUrl === "string" ? m.baseUrl.trim() || undefined : prev.model.baseUrl,
      apiKey: keep(m.apiKey, prev.model.apiKey),
      model: typeof m.model === "string" ? m.model.trim() || undefined : prev.model.model,
      fastModel: typeof m.fastModel === "string" ? m.fastModel.trim() || undefined : prev.model.fastModel,
      visionModel: typeof m.visionModel === "string" ? m.visionModel.trim() || undefined : prev.model.visionModel,
      contextWindow: Number(m.contextWindow) > 0 ? Number(m.contextWindow) : prev.model.contextWindow,
    },
    search: {
      searxngUrl: typeof s.searxngUrl === "string" ? s.searxngUrl.trim() || undefined : prev.search.searxngUrl,
      braveKey: keep(s.braveKey, prev.search.braveKey),
      tavilyKey: keep(s.tavilyKey, prev.search.tavilyKey),
      exaKey: keep(s.exaKey, prev.search.exaKey),
    },
    media: input?.media ? mergeMedia(prev.media, input.media) : prev.media,
    persona: typeof input?.persona === "string" ? input.persona.slice(0, 8000) : prev.persona,
    rules: typeof input?.rules === "string" ? input.rules.slice(0, 8000) : prev.rules,
    secrets,
  };
}

// The env a runtime boots with. Host plumbing (port, workspace, secret) is
// added by the driver; this is only what comes from the user's choices.
export function runtimeEnv(user: User, opts: { containerized: boolean }): Record<string, string> {
  const s = readSettings(user);
  const out: Record<string, string> = {};
  for (const x of s.secrets) out[x.name] = x.value;
  const m = s.model;
  const preset = PRESETS.find((p) => p.id === m.preset) ?? PRESETS[0]!;
  const set = (k: string, v?: string) => {
    if (v) out[k] = v;
  };
  switch (preset.id) {
    case "mock":
      out.ZO_MOCK = "1";
      break;
    case "anthropic":
      set("ANTHROPIC_API_KEY", m.apiKey);
      set("ANTHROPIC_BASE_URL", m.baseUrl);
      set("ANTHROPIC_MODEL", m.model ?? preset.defaultModel);
      set("ANTHROPIC_MODEL_FAST", m.fastModel ?? preset.defaultFast);
      set("ANTHROPIC_MODEL_VISION", m.visionModel);
      break;
    case "gateway":
      set("AI_GATEWAY_API_KEY", m.apiKey);
      set("GATEWAY_MODEL", m.model ?? preset.defaultModel);
      set("GATEWAY_MODEL_FAST", m.fastModel ?? preset.defaultFast);
      set("GATEWAY_MODEL_VISION", m.visionModel);
      break;
    default: {
      let base = m.baseUrl ?? preset.baseUrl ?? "";
      // Inside a container, 127.0.0.1 is the container itself.
      if (opts.containerized) base = base.replace(/\/\/(127\.0\.0\.1|localhost)(?=[:/])/, "//host.docker.internal");
      set("OPENAI_BASE_URL", base);
      out.OPENAI_API_KEY = m.apiKey ?? "none";
      set("OPENAI_MODEL", m.model ?? preset.defaultModel);
      set("OPENAI_MODEL_FAST", m.fastModel ?? preset.defaultFast ?? m.model);
      set("OPENAI_MODEL_VISION", m.visionModel ?? m.fastModel ?? preset.defaultFast ?? m.model);
    }
  }
  if (m.contextWindow) out.OPENZO_CONTEXT_WINDOW = String(m.contextWindow);
  const hostSearch = config.searxngUrl
    ? opts.containerized && config.internalHost
      ? `http://${config.internalHost}:${config.internalPort}/searxng`
      : config.searxngUrl
    : undefined;
  set("SEARXNG_URL", s.search.searxngUrl ?? hostSearch);
  set("BRAVE_API_KEY", s.search.braveKey);
  set("TAVILY_API_KEY", s.search.tavilyKey);
  set("EXA_API_KEY", s.search.exaKey);
  Object.assign(out, mediaEnv(s, opts));
  set("OPENZO_PERSONA", s.persona);
  set("OPENZO_RULES", s.rules);
  out.OPENZO_USER = user.name;
  return out;
}

// Resolve Settings → Media (including "auto") into the OPENZO_MEDIA_* env that
// agent/lib/media.ts reads. Host-level local-backend locations pass through.
function mediaEnv(s: Settings, opts: { containerized: boolean }): Record<string, string> {
  const out: Record<string, string> = {};
  const set = (k: string, v?: string) => {
    if (v) out[k] = opts.containerized ? v.replace(/\/\/(127\.0\.0\.1|localhost)(?=[:/])/, "//host.docker.internal") : v;
  };
  const m = s.model;
  const OPENAI = "https://api.openai.com/v1";
  const GROQ = "https://api.groq.com/openai/v1";
  // The model preset's own key, when that provider serves the media API too.
  const presetLane = (kind: "image" | "speech" | "transcription") => {
    if (!m.apiKey) return undefined;
    if (m.preset === "openai") return { baseUrl: m.baseUrl ?? OPENAI, apiKey: m.apiKey };
    if (m.preset === "groq" && kind === "transcription") return { baseUrl: m.baseUrl ?? GROQ, apiKey: m.apiKey, model: "whisper-large-v3-turbo" };
    return undefined;
  };
  const lane = (kind: "image" | "speech" | "transcription", local: string) => {
    const l = s.media[kind];
    const provider = l.provider ?? "auto";
    if (provider === "openai-compatible") return { provider, baseUrl: l.baseUrl ?? OPENAI, apiKey: l.apiKey, model: l.model };
    if (provider === "auto") {
      if (l.apiKey) return { provider: "openai-compatible", baseUrl: l.baseUrl ?? OPENAI, apiKey: l.apiKey, model: l.model };
      const p = presetLane(kind);
      if (p) return { provider: "openai-compatible", baseUrl: p.baseUrl, apiKey: p.apiKey, model: l.model ?? ("model" in p ? p.model : undefined) };
      return { provider: local, model: l.model };
    }
    return { provider, model: l.model };
  };
  const img = lane("image", "pollinations");
  set("OPENZO_MEDIA_IMAGE_PROVIDER", img.provider);
  set("OPENZO_MEDIA_IMAGE_BASE_URL", img.baseUrl);
  set("OPENZO_MEDIA_IMAGE_API_KEY", img.apiKey);
  set("OPENZO_MEDIA_IMAGE_MODEL", img.model);
  const sp = lane("speech", "local");
  set("OPENZO_MEDIA_SPEECH_PROVIDER", sp.provider);
  set("OPENZO_MEDIA_SPEECH_BASE_URL", sp.baseUrl);
  set("OPENZO_MEDIA_SPEECH_API_KEY", sp.apiKey);
  set("OPENZO_MEDIA_SPEECH_MODEL", sp.model);
  set("OPENZO_MEDIA_SPEECH_VOICE", s.media.speech.voice);
  const tr = lane("transcription", "local");
  set("OPENZO_MEDIA_TRANSCRIBE_PROVIDER", tr.provider);
  set("OPENZO_MEDIA_TRANSCRIBE_BASE_URL", tr.baseUrl);
  set("OPENZO_MEDIA_TRANSCRIBE_API_KEY", tr.apiKey);
  set("OPENZO_MEDIA_TRANSCRIBE_MODEL", tr.model);
  const v = s.media.video;
  set("OPENZO_MEDIA_VIDEO_PROVIDER", v.provider ?? "none");
  set("OPENZO_MEDIA_VIDEO_API_KEY", v.apiKey);
  set("OPENZO_MEDIA_VIDEO_MODEL", v.model);
  // Where this host keeps local backends (process driver; the image bakes its own).
  if (!opts.containerized) {
    for (const k of ["OPENZO_PIPER_VOICES", "OPENZO_WHISPER_PYTHON"]) set(k, process.env[k]);
  }
  return out;
}
