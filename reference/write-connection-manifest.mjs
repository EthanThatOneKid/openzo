import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CONNECTION_MANIFEST_KIND = "zo-eve-connection-manifest";
export const CONNECTION_MANIFEST_VERSION = 1;
export const CONNECTION_MANIFEST_PUBLIC_PATH = ".well-known/zo/connection-manifest.json";

const DISCOVERY_PATH = ".eve/discovery/agent-discovery-manifest.json";
const COMPILED_PATH = ".eve/compile/compiled-agent-manifest.json";
const LOCAL_OUTPUT_PATH = ".eve/zo/connection-manifest.json";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(record, key, label) {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label}.${key} must be a non-empty string`);
  }
  return value;
}

function requiredArray(record, key, label) {
  const value = record[key];
  if (!Array.isArray(value)) throw new Error(`${label}.${key} must be an array`);
  return value;
}

function connectionNames(manifest, label) {
  if (!isRecord(manifest)) return [];
  return requiredArray(manifest, "connections", label).map((connection, index) => {
    if (!isRecord(connection)) throw new Error(`${label}.connections[${index}] must be an object`);
    return requiredString(connection, "connectionName", `${label}.connections[${index}]`);
  });
}

function extensionContributionIndex(discovery, compiled) {
  const mounts = new Map();
  for (const [index, mount] of requiredArray(compiled, "extensionMounts", "compiled").entries()) {
    if (!isRecord(mount)) throw new Error(`compiled.extensionMounts[${index}] must be an object`);
    const namespace = requiredString(mount, "namespace", `compiled.extensionMounts[${index}]`);
    mounts.set(namespace, {
      packageName: requiredString(mount, "packageName", `compiled.extensionMounts[${index}]`),
      mountPath: requiredString(mount, "mountLogicalPath", `compiled.extensionMounts[${index}]`),
    });
  }

  const contributions = new Map();
  for (const [index, extension] of requiredArray(discovery, "resolvedExtensions", "discovery").entries()) {
    if (!isRecord(extension)) throw new Error(`discovery.resolvedExtensions[${index}] must be an object`);
    const label = `discovery.resolvedExtensions[${index}]`;
    const namespace = requiredString(extension, "namespace", label);
    const mount = mounts.get(namespace);
    if (mount === undefined) throw new Error(`${label} has no compiled extension mount for namespace ${namespace}`);
    const packageName = requiredString(extension, "packageName", label);
    if (packageName !== mount.packageName) {
      throw new Error(`${label}.packageName does not match the compiled mount`);
    }
    const overridden = new Set(connectionNames(extension.overrides, `${label}.overrides`));
    const names = new Set([
      ...connectionNames(extension.manifest, `${label}.manifest`),
      ...overridden,
    ]);
    for (const contribution of names) {
      const runtimeName = `${namespace}__${contribution}`;
      if (contributions.has(runtimeName)) {
        throw new Error(`duplicate extension connection ${runtimeName}`);
      }
      contributions.set(runtimeName, {
        kind: "extension_mount",
        mountPath: mount.mountPath,
        packageName,
        namespace,
        contribution,
        definedBy: overridden.has(contribution) ? "consumer_override" : "package",
      });
    }
  }
  return contributions;
}

export function buildConnectionManifest(discovery, compiled) {
  if (!isRecord(discovery) || discovery.kind !== "eve-agent-discovery-manifest") {
    throw new Error("discovery manifest has an unsupported kind");
  }
  if (!isRecord(compiled) || compiled.kind !== "eve-agent-compiled-manifest") {
    throw new Error("compiled manifest has an unsupported kind");
  }
  if (typeof discovery.version !== "number" || typeof compiled.version !== "number") {
    throw new Error("Eve manifest versions must be numbers");
  }

  const contributions = extensionContributionIndex(discovery, compiled);
  const connections = [];
  for (const [index, connection] of requiredArray(compiled, "connections", "compiled").entries()) {
    if (!isRecord(connection)) throw new Error(`compiled.connections[${index}] must be an object`);
    const label = `compiled.connections[${index}]`;
    const runtimeName = requiredString(connection, "connectionName", label);
    const origin = contributions.get(runtimeName);
    if (origin === undefined) continue;
    const protocol = requiredString(connection, "protocol", label);
    if (protocol !== "mcp" && protocol !== "openapi") {
      throw new Error(`${label}.protocol must be mcp or openapi`);
    }
    const url = connection.url;
    if (typeof url !== "string" || (protocol === "mcp" && url.length === 0)) {
      throw new Error(`${label}.url must be a string (and non-empty for mcp)`);
    }
    connections.push({
      runtimeName,
      protocol,
      url,
      description: requiredString(connection, "description", label),
      origin,
    });
    contributions.delete(runtimeName);
  }
  if (contributions.size > 0) {
    throw new Error(`compiled manifest omitted extension connections: ${[...contributions.keys()].join(", ")}`);
  }

  return {
    kind: CONNECTION_MANIFEST_KIND,
    version: CONNECTION_MANIFEST_VERSION,
    eve: {
      discoveryManifestVersion: discovery.version,
      compiledManifestVersion: compiled.version,
    },
    connections,
  };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function writeConnectionManifest(appRoot = process.cwd()) {
  const manifest = buildConnectionManifest(
    await readJson(join(appRoot, DISCOVERY_PATH)),
    await readJson(join(appRoot, COMPILED_PATH)),
  );
  await writeJson(join(appRoot, LOCAL_OUTPUT_PATH), manifest);
  if (process.env.VERCEL) {
    await writeJson(
      join(appRoot, ".vercel/output/static", CONNECTION_MANIFEST_PUBLIC_PATH),
      manifest,
    );
  }
  return manifest;
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  await writeConnectionManifest();
}
