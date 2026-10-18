// Calls from this runtime to the openzo host's internal API (host/internal.ts).
// The host hands every runtime its base URL and a per-user token at boot; with
// neither set (the agent running alone under `eve dev`) host-backed tools
// report that they need the openzo host instead of failing obscurely.
export class HostUnavailable extends Error {}

export function hostApiAvailable(): boolean {
  return Boolean(process.env.OPENZO_HOST_API && process.env.OPENZO_RUNTIME_TOKEN);
}

export async function hostApi<T = any>(method: string, path: string, body?: unknown, timeoutMs = 120_000): Promise<T> {
  const base = process.env.OPENZO_HOST_API;
  const token = process.env.OPENZO_RUNTIME_TOKEN;
  if (!base || !token) throw new HostUnavailable("this tool needs the openzo host (OPENZO_HOST_API is not set)");
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "x-openzo-runtime": token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) throw new Error(data?.error ?? `host answered ${res.status}`);
  return data as T;
}
