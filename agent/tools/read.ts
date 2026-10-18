import { fileTools } from "../lib/file-tools";

// The filename is the wire name: the model calls this `read`. Same for the
// edit/write/glob/grep siblings; read_file/write_file are vacated by the
// disable shims in ./read_file.ts and ./write_file.ts.
export default fileTools.tools.read;
