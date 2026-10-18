import { fileTools } from "../lib/file-tools";

// Shadows eve's built-in `glob` by name (the filename is the wire name).
export default fileTools.tools.glob;
