import { disableTool } from "eve/tools";

// Vacate eve's built-in `read_file` so the model sees only our `read`.
export default disableTool();
