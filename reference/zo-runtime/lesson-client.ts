import {
  STATE_FILES_HANDLE_PATH,
  StateFilesHandleError,
  ZO_EVE_SESSION_HEADER,
  applyRuntimeCredentialHeaders,
  createRefreshingStateFilesClient,
  parseStateFilesHandle,
  type StateFilesClient,
  type StateFilesHandle,
} from "@zocomputer/agent-sdk/state-files";

import { createFetchR2S3Client } from "./r2-s3";

export const LESSONS_DECLARATION_NAME = "lessons";

export interface CreateLessonsReaderOptions {
  readonly apiBaseUrl?: string | URL | null;
  readonly agentToken?: string | null;
  readonly fetch?: typeof globalThis.fetch;
  readonly getSessionId?: () => string | undefined;
  readonly now?: () => Date;
}

/** Runtime reader for the seed agent's `lessons` external-state declaration. */
export function createLessonsReader(
  options: CreateLessonsReaderOptions = {},
): StateFilesClient {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  // No ambient-session fallback: the session.started instruction threads the
  // resolve context's session id in. A session-partitioned handle request
  // without one is refused by the broker (`eve_session_required`) — loud,
  // never silently keyed to the wrong subject. (The vendored ambient reader
  // also isn't importable here: the seed's only Zo dep is the fat agent-sdk.)
  const getSessionId = options.getSessionId ?? (() => undefined);
  const now = options.now ?? (() => new Date());
  const s3 = createFetchR2S3Client(fetchImpl, now);

  return createRefreshingStateFilesClient({
    s3,
    now,
    loadHandle: async () =>
      requestLessonsHandle({
        fetch: fetchImpl,
        apiBaseUrl: resolveApiBaseUrl(options.apiBaseUrl),
        agentToken: resolveAgentToken(options.agentToken),
        eveSessionKey: getSessionId(),
      }),
  });
}

/**
 * POST the broker handle request directly rather than through the SDK's
 * `requestStateFilesHandle`, which sends no `suggestedDefaults`: on a
 * zero-config first use the broker would fall back to zo-blob-r2's default
 * `user` partition, keying a store the session-scoped lesson mounts
 * (`state/lessons.ts` declares `partition: "session"`) never share.
 */
async function requestLessonsHandle(input: {
  readonly fetch: typeof globalThis.fetch;
  readonly apiBaseUrl: string;
  readonly agentToken: string;
  readonly eveSessionKey: string | undefined;
}): Promise<StateFilesHandle> {
  const headers = new Headers({ "content-type": "application/json" });
  // OIDC-first ambient credential; `input.agentToken` is the legacy fallback.
  applyRuntimeCredentialHeaders(headers, input.agentToken);
  if (input.eveSessionKey !== undefined) {
    headers.set(ZO_EVE_SESSION_HEADER, input.eveSessionKey);
  }
  const response = await input.fetch(
    `${input.apiBaseUrl.replace(/\/+$/u, "")}${STATE_FILES_HANDLE_PATH}`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        declarationName: LESSONS_DECLARATION_NAME,
        interface: "files",
        access: "r",
        // Mirror the declaration's suggested defaults so the reader and the
        // lesson mounter resolve the same session-partitioned store instance.
        suggestedDefaults: { engine: "zo-blob-r2", partition: "session" },
      }),
    },
  );
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = brokerErrorCode(json);
    throw new StateFilesHandleError(
      `lessons handle request failed with ${response.status}${code === null ? "" : ` (${code})`}`,
      { status: response.status, code },
    );
  }
  const handle = parseStateFilesHandle(json);
  if (handle === null) {
    throw new StateFilesHandleError("state files broker returned a malformed handle", {
      status: response.status,
      code: "malformed_handle",
    });
  }
  return handle;
}

function brokerErrorCode(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("error" in value)) {
    return null;
  }
  const code = value.error;
  return typeof code === "string" && code.length > 0 ? code : null;
}

function resolveApiBaseUrl(apiBaseUrl: string | URL | null | undefined): string {
  const value = String(apiBaseUrl ?? process.env.ZO_API_URL ?? "").trim();
  if (value.length === 0) {
    throw new Error("ZO_API_URL is required to read mounted lessons");
  }
  return value;
}

// The explicit legacy token to thread as a fallback, or "" when absent. No
// longer throws on a missing `ZO_AGENT_TOKEN`: the handle request resolves the
// ambient OIDC credential first (`applyRuntimeCredentialHeaders`), so a deployed
// agent reads lessons via OIDC with no token set; a genuinely credential-less
// call is rejected at the broker, not pre-empted here.
function resolveAgentToken(agentToken: string | null | undefined): string {
  return (agentToken ?? process.env.ZO_AGENT_TOKEN ?? "").trim();
}
