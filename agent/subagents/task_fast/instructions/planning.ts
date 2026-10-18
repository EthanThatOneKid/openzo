import { createPlanningInstruction } from "@zocomputer/agent-sdk";

// The todo-planning playbook — same SDK section as the parent's stack; the
// child keeps eve's built-in todo tool, so it needs the matching discipline.
export default createPlanningInstruction();
