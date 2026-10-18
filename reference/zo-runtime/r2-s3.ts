import type {
  StateFilesCredentials,
  StateFilesObject,
  StateFilesS3Client,
  StateFilesS3DeleteInput,
  StateFilesS3ListInput,
  StateFilesS3ReadInput,
  StateFilesS3WriteInput,
} from "@zocomputer/agent-sdk/state-files";

const EMPTY_PAYLOAD_HASH =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** Fetch-backed S3 client for reading lesson objects from zo-blob-r2 handles. */
export function createFetchR2S3Client(
  fetchImpl: typeof globalThis.fetch,
  now: () => Date = () => new Date(),
): StateFilesS3Client {
  return {
    async listObjects(input: StateFilesS3ListInput) {
      // ListObjectsV2 caps each response (1000 keys); follow the continuation
      // token so a store with more objects than one page lists completely.
      const objects: StateFilesObject[] = [];
      let continuationToken: string | undefined;
      do {
        const url = listObjectsUrl(
          input.endpoint,
          input.bucketName,
          input.prefix,
          continuationToken,
        );
        const headers = await signedS3Headers({
          credentials: input.credentials,
          date: now(),
          host: url.host,
          method: "GET",
          path: url.pathname,
          query: url.searchParams,
          payloadHash: EMPTY_PAYLOAD_HASH,
        });
        const response = await fetchImpl(url, { method: "GET", headers });
        if (!response.ok) {
          throw new Error(`state files list failed with ${response.status}`);
        }
        const page = parseListObjectsPage(await response.text());
        objects.push(...page.objects);
        if (page.isTruncated && page.nextContinuationToken === undefined) {
          // Silently returning what we have would present a partial listing
          // as complete — fail loudly instead.
          throw new Error("state files list page is truncated but has no continuation token");
        }
        if (
          page.nextContinuationToken !== undefined &&
          page.nextContinuationToken === continuationToken
        ) {
          // A truncated page must advance the cursor; a repeated token would
          // loop forever, so treat it as a malformed response.
          throw new Error("state files list did not advance its continuation token");
        }
        continuationToken = page.nextContinuationToken;
      } while (continuationToken !== undefined);
      return objects;
    },

    async readObject(input: StateFilesS3ReadInput) {
      const url = objectUrl(input.endpoint, input.bucketName, input.key);
      const headers = await signedS3Headers({
        credentials: input.credentials,
        date: now(),
        host: url.host,
        method: "GET",
        path: url.pathname,
        query: url.searchParams,
        payloadHash: EMPTY_PAYLOAD_HASH,
      });
      const response = await fetchImpl(url, { method: "GET", headers });
      if (!response.ok) {
        throw new Error(`state file read failed with ${response.status}`);
      }
      return new Uint8Array(await response.arrayBuffer());
    },

    async writeObject(_input: StateFilesS3WriteInput): Promise<void> {
      throw new Error("lessons reader is read-only");
    },

    async deleteObject(_input: StateFilesS3DeleteInput): Promise<void> {
      throw new Error("lessons reader is read-only");
    },
  };
}

function listObjectsUrl(
  endpoint: string,
  bucketName: string,
  prefix: string | undefined,
  continuationToken: string | undefined,
): URL {
  const url = new URL(`${endpoint.replace(/\/+$/u, "")}/${encodeSegment(bucketName)}`);
  url.searchParams.set("list-type", "2");
  if (prefix !== undefined && prefix.length > 0) {
    url.searchParams.set("prefix", prefix);
  }
  if (continuationToken !== undefined) {
    url.searchParams.set("continuation-token", continuationToken);
  }
  return url;
}

function objectUrl(endpoint: string, bucketName: string, key: string): URL {
  const base = endpoint.replace(/\/+$/u, "");
  return new URL(
    `${base}/${encodeSegment(bucketName)}/${encodeKey(key)}`,
  );
}

/** One parsed ListObjectsV2 page: its objects plus the cursor for the next page. */
export interface ListObjectsPage {
  readonly objects: readonly StateFilesObject[];
  /** Whether the response reported `IsTruncated` — more keys exist beyond this page. */
  readonly isTruncated: boolean;
  /** Present on a truncated page — send as `continuation-token` for the next page. */
  readonly nextContinuationToken?: string;
}

export function parseListObjectsPage(xml: string): ListObjectsPage {
  const objects: StateFilesObject[] = [];
  const blockPattern = /<Contents>([\s\S]*?)<\/Contents>/gu;
  for (const block of xml.matchAll(blockPattern)) {
    const content = block[1];
    if (content === undefined) continue;
    const key = readXmlTag(content, "Key");
    const sizeRaw = readXmlTag(content, "Size");
    if (key === null || sizeRaw === null) continue;
    const size = Number.parseInt(sizeRaw, 10);
    if (!Number.isFinite(size)) continue;
    objects.push({ key, size });
  }
  const isTruncated = readXmlTag(xml, "IsTruncated") === "true";
  const token = isTruncated ? readXmlTag(xml, "NextContinuationToken") : null;
  return token === null || token.length === 0
    ? { objects, isTruncated }
    : { objects, isTruncated, nextContinuationToken: token };
}

function readXmlTag(block: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([^<]*)</${tag}>`, "u").exec(block);
  const text = match?.[1];
  return text === undefined ? null : decodeXmlText(text);
}

// S3/R2 XML-escape element text, so a key like `a&b.md` arrives as
// `a&amp;b.md` — decode the predefined entities (+ numeric refs) or the
// signed read of that key targets the wrong object.
function decodeXmlText(text: string): string {
  return text.replace(
    /&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/gu,
    (whole, entity: string) => {
      switch (entity) {
        case "amp":
          return "&";
        case "lt":
          return "<";
        case "gt":
          return ">";
        case "quot":
          return '"';
        case "apos":
          return "'";
        default:
          break;
      }
      const codePoint = entity.startsWith("#x")
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return whole;
      }
    },
  );
}

interface SignedS3HeadersInput {
  readonly method: "GET";
  readonly path: string;
  readonly host: string;
  readonly query: URLSearchParams;
  readonly payloadHash: string;
  readonly credentials: StateFilesCredentials;
  readonly date: Date;
}

async function signedS3Headers(input: SignedS3HeadersInput): Promise<Headers> {
  const amzDate = awsAmzDate(input.date);
  const dateStamp = amzDate.slice(0, 8);
  const canonicalQuery = canonicalQueryString(input.query);
  const headerEntries: [string, string][] = [
    ["host", input.host],
    ["x-amz-content-sha256", input.payloadHash],
    ["x-amz-date", amzDate],
    ["x-amz-security-token", input.credentials.sessionToken],
  ];
  headerEntries.sort(([left], [right]) => compareCodePoints(left, right));
  const canonicalHeaders = headerEntries
    .map(([name, value]) => `${name}:${value.trim()}\n`)
    .join("");
  const signedHeaders = headerEntries.map(([name]) => name).join(";");
  const canonicalRequest = [
    input.method,
    input.path,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256Hex(new TextEncoder().encode(canonicalRequest)),
  ].join("\n");
  const signingKey = await awsSigningKey(input.credentials.secretAccessKey, dateStamp);
  const signature = await hmacHex(signingKey, stringToSign);
  const headers = new Headers();
  for (const [name, value] of headerEntries) headers.set(name, value);
  headers.set(
    "authorization",
    `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  );
  return headers;
}

function canonicalQueryString(params: URLSearchParams): string {
  // SigV4 orders by the ENCODED name (then value), by code point — not a
  // locale collation, which sorts punctuation like `-` differently.
  const entries = [...params.entries()].map(
    ([key, value]) => [encodeRfc3986(key), encodeRfc3986(value)] as const,
  );
  entries.sort(
    ([leftKey, leftValue], [rightKey, rightValue]) =>
      compareCodePoints(leftKey, rightKey) || compareCodePoints(leftValue, rightValue),
  );
  return entries.map(([key, value]) => `${key}=${value}`).join("&");
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

async function awsSigningKey(
  secretAccessKey: string,
  dateStamp: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const dateKey = await hmacBytes(
    new TextEncoder().encode(`AWS4${secretAccessKey}`),
    dateStamp,
  );
  const regionKey = await hmacBytes(dateKey, "auto");
  const serviceKey = await hmacBytes(regionKey, "s3");
  return hmacBytes(serviceKey, "aws4_request");
}

async function hmacBytes(key: Uint8Array<ArrayBuffer>, data: string): Promise<Uint8Array<ArrayBuffer>> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data)),
  );
}

async function hmacHex(key: Uint8Array<ArrayBuffer>, data: string): Promise<string> {
  return bytesToHex(await hmacBytes(key, data));
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(new Uint8Array(digest));
}

function bytesToHex(bytes: Uint8Array<ArrayBuffer>): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function awsAmzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/gu, "");
}

function encodeKey(key: string): string {
  return key.split("/").map(encodeSegment).join("/");
}

function encodeSegment(segment: string): string {
  return encodeRfc3986(segment);
}
