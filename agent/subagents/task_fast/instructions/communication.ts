import { createCommunicationInstruction } from "@zocomputer/agent-sdk";

// The reporting contract — same SDK section as the parent's stack. The
// child's final message is its entire deliverable (see task.ts), so the
// lead-with-the-outcome rules matter even more here. No hitl section (the
// ask_question shim vacates the tool) and no subagents section (the task
// contract bounds onward delegation instead).
export default createCommunicationInstruction();
