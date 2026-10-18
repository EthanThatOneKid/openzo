import { disableTool } from "eve/tools";

// Vacate eve's built-in `write_file` so the model sees only our `write`.
export default disableTool();
