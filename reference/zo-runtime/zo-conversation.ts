import {
  ZO_EVE_SESSION_HEADER,
  applyRuntimeCredentialHeaders,
} from "@zocomputer/agent-sdk/state-files";
import { defineHook, type HookContext, type HookEvent } from "eve/hooks";

const OBSERVATION_PATH = "/runtime/conversation-observations";
const TIMEOUT_MS = 2_000;
const RETRYABLE_STATUSES = new Set([401, 500, 503]);

export type RuntimeConversationObservation =
  | {
      readonly kind: "registration";
      readonly channel: "slack";
      readonly teamId: string;
      readonly channelId: string;
      readonly threadTs: string;
      readonly observedAt: string;
      readonly actor?: SlackActorReport;
    }
  | {
      readonly kind: "registration";
      readonly channel: "web";
      readonly observedAt: string;
      readonly actor?: WebActorReport;
    }
  | {
      readonly kind: "progress";
      readonly channel: "slack" | "web";
      readonly observedAt: string;
      readonly turnId: string;
      readonly turnSequence: number;
      readonly terminal?: "complete" | "error";
    };

interface ActorReportBase {
  readonly turnId: string;
  readonly turnSequence: number;
}

interface SlackActorReport extends ActorReportBase {
  readonly authenticator: string;
  readonly principalId: string;
  readonly principalType: string;
  readonly issuer?: string;
  readonly attributes?: Readonly<Record<string, string>>;
}

interface WebActorReport extends ActorReportBase {
  readonly sessionCapability: string;
}

type ObservationFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface ObservationPostDeps {
  readonly fetch?: ObservationFetch;
  readonly apiBaseUrl?: () => string | null;
  readonly applyRuntimeCredentialHeaders?: typeof applyRuntimeCredentialHeaders;
  readonly timeoutSignal?: (milliseconds: number) => AbortSignal;
  readonly warn?: (message: string) => void;
  readonly error?: (message: string) => void;
}

type ObservationWarn = (message: string) => void;

type SessionAuthContext = NonNullable<HookContext["session"]["auth"]["current"]>;

export default defineHook({
  events: {
    "message.received": async (event, ctx) => {
      await reportObservation(
        (warn) => buildRegistrationObservation(event, ctx, undefined, warn),
        ctx,
      );
    },
    "turn.completed": async (event, ctx) => {
      await reportObservation(
        (warn) => buildProgressObservation(event, ctx, undefined, warn),
        ctx,
      );
    },
    "session.completed": async (_event, ctx) => {
      await reportObservation(
        (warn) => buildTerminalObservation(ctx, "complete", undefined, warn),
        ctx,
      );
    },
    "session.failed": async (_event, ctx) => {
      await reportObservation(
        (warn) => buildTerminalObservation(ctx, "error", undefined, warn),
        ctx,
      );
    },
  },
});

export async function reportObservation(
  build: (warn: ObservationWarn) => RuntimeConversationObservation | null,
  ctx: HookContext,
  deps: ObservationPostDeps = {},
): Promise<void> {
  const warn = deps.warn ?? console.warn;
  try {
    // Load-bearing: child/subagent sessions are not user-facing conversations.
    // Their delegated prompts arrive as `message.received` on their own session;
    // posting them would mint one spurious Conversation/TraceSession per
    // subagent call.
    if (ctx.session.parent !== undefined) return;

    const observation = build(warn);
    if (observation === null) return;

    await postObservation(observation, ctx, deps);
  } catch {
    // Eve awaits hook handlers inline after accepting the event. Observation must
    // never reject the already-accepted turn/session, even for malformed context.
    warn("[zo] conversation observation failed");
  }
}

export function buildRegistrationObservation(
  event: HookEvent<"message.received">,
  ctx: HookContext,
  now: () => Date = () => new Date(),
  warn: ObservationWarn = console.warn,
): RuntimeConversationObservation | null {
  const auth = ctx.session.auth.current;
  if (auth === null) return null;

  const turn = turnCoordinateFromEvent(event.data.turnId, event.data.sequence);
  if (turn === null) {
    warn("[zo] conversation registration observation missing turn coordinate");
    return null;
  }

  const observedAt = now().toISOString();
  if (auth.authenticator === "slack-webhook") {
    const address = slackAddressFromAuth(auth);
    if (address === null) {
      warn("[zo] conversation registration observation missing Slack address");
      return null;
    }
    const attributes = stringAttributes(auth.attributes);
    return {
      kind: "registration",
      channel: "slack",
      ...address,
      observedAt,
      actor: {
        ...turn,
        authenticator: auth.authenticator,
        principalId: auth.principalId,
        principalType: auth.principalType,
        ...(auth.issuer === undefined ? {} : { issuer: auth.issuer }),
        ...(attributes === undefined ? {} : { attributes }),
      },
    };
  }

  const sessionCapability = stringAttribute(auth.attributes, "zoSessionCapability");
  if (sessionCapability === null) return null;
  return {
    kind: "registration",
    channel: "web",
    observedAt,
    actor: { ...turn, sessionCapability },
  };
}

export function buildProgressObservation(
  event: HookEvent<"turn.completed">,
  ctx: HookContext,
  now: () => Date = () => new Date(),
  warn: ObservationWarn = console.warn,
): RuntimeConversationObservation | null {
  const channel = channelFromAuth(ctx.session.auth.current, warn);
  if (channel === null) return null;

  const turn = turnCoordinateFromEvent(event.data.turnId, event.data.sequence);
  if (turn === null) {
    warn("[zo] conversation progress observation missing turn coordinate");
    return null;
  }

  return {
    kind: "progress",
    channel,
    observedAt: now().toISOString(),
    ...turn,
  };
}

export function buildTerminalObservation(
  ctx: HookContext,
  terminal: "complete" | "error",
  now: () => Date = () => new Date(),
  warn: ObservationWarn = console.warn,
): RuntimeConversationObservation | null {
  const channel = channelFromAuth(ctx.session.auth.current, warn);
  if (channel === null) return null;

  // session.completed carries no turn payload, and session.failed carries only
  // failure details. The hook context keeps the active/last turn coordinate; use
  // it so terminal observations can satisfy the endpoint's progress schema.
  const turn = turnCoordinateFromSessionContext(ctx);
  if (turn === null) {
    warn("[zo] conversation terminal observation missing turn coordinate");
    return null;
  }

  return {
    kind: "progress",
    channel,
    observedAt: now().toISOString(),
    ...turn,
    terminal,
  };
}

export async function postObservation(
  observation: RuntimeConversationObservation,
  ctx: HookContext,
  deps: ObservationPostDeps = {},
): Promise<void> {
  const baseUrl = (deps.apiBaseUrl ?? defaultApiBaseUrl)();
  if (baseUrl === null) {
    (deps.warn ?? console.warn)(
      "[zo] conversation observation endpoint is not configured",
    );
    return;
  }

  const warn = deps.warn ?? console.warn;
  const error = deps.error ?? console.error;
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const credentialHeaders =
    deps.applyRuntimeCredentialHeaders ?? applyRuntimeCredentialHeaders;
  const timeoutSignal =
    deps.timeoutSignal ?? ((milliseconds) => AbortSignal.timeout(milliseconds));

  for (const attempt of [1, 2] as const) {
    try {
      const headers = new Headers({ "content-type": "application/json" });
      // Re-resolve on every attempt: a 401 usually means an expired ambient OIDC
      // token, so replaying the first attempt's credential guarantees retry failure.
      credentialHeaders(headers);
      headers.set(ZO_EVE_SESSION_HEADER, ctx.session.id);

      const response = await fetchImpl(`${baseUrl}${OBSERVATION_PATH}`, {
        method: "POST",
        headers,
        body: JSON.stringify(observation),
        signal: timeoutSignal(TIMEOUT_MS),
      });
      if (response.ok) return;
      logObservationHttpDrop(response.status, observation, ctx, attempt, {
        error,
        warn,
      });
      if (attempt === 2 || !RETRYABLE_STATUSES.has(response.status)) return;
    } catch (caught) {
      if (attempt === 2) {
        warn(
          `[zo] conversation observation network failure session=${sessionIdForLog(ctx)} error=${errorForLog(caught)}`,
        );
        return;
      }
      warn(
        `[zo] conversation observation retrying after network failure session=${sessionIdForLog(ctx)} error=${errorForLog(caught)}`,
      );
    }
  }
}

function logObservationHttpDrop(
  status: number,
  observation: RuntimeConversationObservation,
  ctx: HookContext,
  attempt: 1 | 2,
  log: { readonly warn: ObservationWarn; readonly error: ObservationWarn },
): void {
  const detail =
    `status=${status} session=${sessionIdForLog(ctx)} attempt=${attempt} ` +
    observationForLog(observation);
  if (status === 409) {
    log.error(`[zo] conversation observation conflict ${detail}`);
    return;
  }
  log.warn(`[zo] conversation observation HTTP failure ${detail}`);
}

function sessionIdForLog(ctx: HookContext): string {
  const session = (ctx as { readonly session?: unknown }).session;
  if (typeof session !== "object" || session === null) return "(missing)";
  const id = (session as { readonly id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : "(missing)";
}

function observationForLog(observation: RuntimeConversationObservation): string {
  if (observation.channel === "slack" && "teamId" in observation) {
    return (
      `channel=slack kind=${observation.kind} team=${observation.teamId} ` +
      `slackChannel=${observation.channelId} thread=${observation.threadTs}`
    );
  }
  return `channel=${observation.channel} kind=${observation.kind}`;
}

function errorForLog(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : String(error);
}

function defaultApiBaseUrl(): string | null {
  const value = String(process.env.ZO_API_URL ?? "").trim().replace(/\/+$/u, "");
  return value.length === 0 ? null : value;
}

function channelFromAuth(
  auth: SessionAuthContext | null,
  warn: ObservationWarn,
): "slack" | "web" | null {
  if (auth === null) return null;
  if (auth.authenticator === "slack-webhook") {
    if (slackAddressFromAuth(auth) === null) {
      warn("[zo] conversation progress observation missing Slack address");
      return null;
    }
    return "slack";
  }
  return stringAttribute(auth.attributes, "zoSessionCapability") === null
    ? null
    : "web";
}

function slackAddressFromAuth(
  auth: SessionAuthContext,
): {
  readonly teamId: string;
  readonly channelId: string;
  readonly threadTs: string;
} | null {
  const teamId = stringAttribute(auth.attributes, "team_id");
  const channelId = stringAttribute(auth.attributes, "channel_id");
  const threadTs = stringAttribute(auth.attributes, "thread_ts");
  if (teamId === null || channelId === null || threadTs === null) return null;
  return { teamId, channelId, threadTs };
}

function turnCoordinateFromSessionContext(
  ctx: HookContext,
): { readonly turnId: string; readonly turnSequence: number } | null {
  const session = (ctx as { readonly session?: unknown }).session;
  if (typeof session !== "object" || session === null) return null;
  const turn = (session as { readonly turn?: unknown }).turn;
  if (typeof turn !== "object" || turn === null) return null;
  return turnCoordinateFromEvent(
    (turn as { readonly id?: unknown }).id,
    (turn as { readonly sequence?: unknown }).sequence,
  );
}

function turnCoordinateFromEvent(
  turnId: unknown,
  turnSequence: unknown,
): { readonly turnId: string; readonly turnSequence: number } | null {
  if (typeof turnId !== "string" || turnId.length === 0) return null;
  if (
    typeof turnSequence !== "number" ||
    !Number.isInteger(turnSequence) ||
    turnSequence < 0
  ) {
    return null;
  }
  return { turnId, turnSequence };
}

function stringAttribute(
  attributes: Readonly<Record<string, string | readonly string[]>>,
  key: string,
): string | null {
  const value = attributes[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stringAttributes(
  attributes: Readonly<Record<string, string | readonly string[]>>,
): Readonly<Record<string, string>> | undefined {
  const entries = Object.entries(attributes).filter(
    (entry): entry is [string, string] => {
      const [, value] = entry;
      return typeof value === "string";
    },
  );
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}
