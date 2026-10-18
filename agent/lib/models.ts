// openzo model lanes — one resolver shared by the root agent, the task_fast
// subagent and the `look` oracle, so every model call a user's runtime makes
// rides the same credentials. Picked by env at process start (the host passes
// each user's saved settings as env when it boots their runtime):
//
//   ZO_MOCK=1            scripted mock model; no credentials. `[mock:bash <cmd>]`
//                        makes it call the real bash tool (used by the checks).
//   OPENAI_API_KEY       any OpenAI-compatible endpoint: OpenAI, OpenRouter,
//                        Groq, Together, DeepSeek, Ollama, vLLM, LM Studio...
//                        OPENAI_BASE_URL / OPENAI_MODEL / OPENAI_MODEL_FAST /
//                        OPENAI_MODEL_VISION.
//   ANTHROPIC_API_KEY    Anthropic through its OpenAI-compatible endpoint.
//                        ANTHROPIC_MODEL / ANTHROPIC_MODEL_FAST.
//   AI_GATEWAY_API_KEY   Vercel AI Gateway with catalog slugs (GATEWAY_MODEL).
//   ZO_AI_BASE_URL       a Zo-protocol gateway (the seed's original lane).
//   (nothing)            a setup model that answers every message with
//                        instructions for configuring a lane.
import { createGateway } from "@ai-sdk/gateway";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV4, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { createMockStoryModel } from "@zocomputer/agent-sdk/testing";

export type Tier = "main" | "fast" | "vision";
export type Lane = "mock" | "openai" | "anthropic" | "gateway" | "zo" | "setup";

const env = (k: string) => process.env[k]?.trim() || undefined;

export function activeLane(): Lane {
  if (env("ZO_MOCK") === "1") return "mock";
  if (env("OPENAI_API_KEY") || env("OPENAI_BASE_URL")) return "openai";
  if (env("ANTHROPIC_API_KEY")) return "anthropic";
  if (env("AI_GATEWAY_API_KEY")) return "gateway";
  if (env("ZO_AI_BASE_URL")) return "zo";
  return "setup";
}

const DEFAULTS: Record<Exclude<Lane, "mock" | "setup">, Record<Tier, string>> = {
  openai: { main: "gpt-4.1", fast: "gpt-4.1-mini", vision: "gpt-4.1-mini" },
  anthropic: { main: "claude-sonnet-5-5", fast: "claude-haiku-5-5", vision: "claude-haiku-5-5" },
  gateway: { main: "anthropic/claude-sonnet-5", fast: "anthropic/claude-haiku-4.5", vision: "google/gemini-3-flash" },
  zo: { main: "anthropic/claude-sonnet-5", fast: "anthropic/claude-haiku-4.5", vision: "google/gemini-3-flash" },
};

export function modelId(tier: Tier): string {
  const lane = activeLane();
  if (lane === "mock" || lane === "setup") return lane;
  const prefix = lane === "openai" ? "OPENAI_MODEL" : lane === "anthropic" ? "ANTHROPIC_MODEL" : "GATEWAY_MODEL";
  const suffix = tier === "main" ? "" : `_${tier.toUpperCase()}`;
  return env(`${prefix}${suffix}`) ?? (tier !== "main" ? env(prefix) : undefined) ?? DEFAULTS[lane][tier];
}

// Returns a LanguageModel instance for every lane except "zo", which keeps the
// seed's bare-slug behaviour (routed by @zocomputer/agent-sdk/ai/register).
export function resolveModel(tier: Tier): LanguageModelV4 | string {
  const lane = activeLane();
  switch (lane) {
    case "mock":
      return mockModel();
    case "setup":
      return setupModel();
    case "openai":
      return createOpenAICompatible({
        name: "openai",
        apiKey: env("OPENAI_API_KEY") ?? "none",
        baseURL: env("OPENAI_BASE_URL") ?? "https://api.openai.com/v1",
        includeUsage: true,
      }).chatModel(modelId(tier)) as unknown as LanguageModelV4;
    case "anthropic":
      return createOpenAICompatible({
        name: "anthropic",
        apiKey: env("ANTHROPIC_API_KEY")!,
        baseURL: env("ANTHROPIC_BASE_URL") ?? "https://api.anthropic.com/v1",
        includeUsage: true,
      }).chatModel(modelId(tier)) as unknown as LanguageModelV4;
    case "gateway":
      return createGateway({ apiKey: env("AI_GATEWAY_API_KEY") })(modelId(tier)) as unknown as LanguageModelV4;
    case "zo":
      return modelId(tier);
  }
}

export function contextWindowTokens(): number {
  return Number(env("OPENZO_CONTEXT_WINDOW") ?? 128_000);
}

// ---------------------------------------------------------------------------

type Prompt = Parameters<LanguageModelV4["doStream"]>[0]["prompt"];

function lastUserText(prompt: Prompt): string {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const m = prompt[i]!;
    if (m.role !== "user") continue;
    return m.content
      .map((p) => (p.type === "text" ? p.text : ""))
      .join("")
      .trim();
  }
  return "";
}

function lastToolResult(prompt: Prompt): string | null {
  const last = prompt[prompt.length - 1];
  if (!last || last.role !== "tool") return null;
  const part = last.content.find((p) => p.type === "tool-result");
  if (!part || part.type !== "tool-result") return null;
  return JSON.stringify(part.output).slice(0, 4000);
}

function scripted(
  id: string,
  build: (prompt: Prompt) => { text?: string; toolCall?: { name: string; input: unknown } },
): LanguageModelV4 {
  const usage = (n: number) => ({
    inputTokens: { total: n, noCache: n, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: n, text: n, reasoning: 0 },
  });
  return {
    specificationVersion: "v4",
    // Borrowed catalog identity so eve can resolve context-window metadata;
    // nothing is ever sent to Anthropic.
    provider: "anthropic",
    modelId: "claude-opus-4-8",
    supportedUrls: {},
    async doGenerate(options) {
      const { text = "" } = build(options.prompt);
      return {
        content: [{ type: "text", text }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: usage(Math.ceil(text.length / 4)),
        warnings: [],
      };
    },
    async doStream(options) {
      const step = build(options.prompt);
      const stream = new ReadableStream<LanguageModelV4StreamPart>({
        start(c) {
          c.enqueue({ type: "stream-start", warnings: [] });
          c.enqueue({ type: "response-metadata", id: `${id}-${Date.now()}`, modelId: id, timestamp: new Date() });
          if (step.toolCall) {
            const input = JSON.stringify(step.toolCall.input);
            c.enqueue({ type: "tool-input-start", id: "c1", toolName: step.toolCall.name });
            c.enqueue({ type: "tool-input-delta", id: "c1", delta: input });
            c.enqueue({ type: "tool-input-end", id: "c1" });
            c.enqueue({ type: "tool-call", toolCallId: "c1", toolName: step.toolCall.name, input });
            c.enqueue({ type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage: usage(20) });
          } else {
            const text = step.text ?? "";
            c.enqueue({ type: "text-start", id: "t1" });
            for (const chunk of text.match(/[\s\S]{1,24}/g) ?? []) c.enqueue({ type: "text-delta", id: "t1", delta: chunk });
            c.enqueue({ type: "text-end", id: "t1" });
            c.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usage(text.length / 4) });
          }
          c.close();
        },
      });
      return { stream };
    },
  } as LanguageModelV4;
}

const MOCK_BASH = /\[mock:bash\s+([\s\S]+?)\]/;

function mockModel(): LanguageModelV4 {
  const story = createMockStoryModel({ chunkDelayMs: 0 });
  const bash = scripted("openzo-mock", (prompt) => {
    const result = lastToolResult(prompt);
    if (result !== null) return { text: `Command finished. Result: ${result}` };
    const cmd = MOCK_BASH.exec(lastUserText(prompt))![1]!;
    return { toolCall: { name: "bash", input: { command: cmd } } };
  });
  return {
    ...story,
    doGenerate: (o) => story.doGenerate(o),
    doStream: (o) => (MOCK_BASH.test(lastUserText(o.prompt)) ? bash.doStream(o) : story.doStream(o)),
  };
}

const SETUP_TEXT = [
  "**No model is configured for this workspace yet.**",
  "",
  "Open **Settings → Model** and choose a provider:",
  "",
  "- **OpenAI-compatible** — OpenAI, OpenRouter, Groq, Together, DeepSeek, or a local Ollama / vLLM / LM Studio server (base URL + key + model).",
  "- **Anthropic** — an `ANTHROPIC_API_KEY`.",
  "- **Vercel AI Gateway** — an `AI_GATEWAY_API_KEY`.",
  "",
  "Saving restarts your runtime with the new lane; nothing else needs to change.",
].join("\n");

function setupModel(): LanguageModelV4 {
  return scripted("openzo-setup", () => ({ text: SETUP_TEXT }));
}
