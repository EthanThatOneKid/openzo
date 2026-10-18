import { fileTools } from "../lib/file-tools";

// The SDK sandbox bash replaces eve's built-in bash with bounded output,
// spill files the sandbox-backed `read` can reach, and foreground_ms
// auto-backgrounding into the shared task registry (see ./tasks.ts).
export default fileTools.tools.bash;
