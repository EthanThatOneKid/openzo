// The user's own persona and rules from openzo Settings. The host passes them
// to this runtime as env at boot; resolved per session so a settings change
// (which restarts the runtime) applies to the next conversation.
import { defineDynamic, defineInstructions } from "eve/instructions";

export default defineDynamic({
  events: {
    "session.started": () => {
      const persona = process.env.OPENZO_PERSONA?.trim();
      const rules = process.env.OPENZO_RULES?.trim();
      const user = process.env.OPENZO_USER?.trim();
      const parts: string[] = [];
      if (user) parts.push(`You are working for the openzo user "${user}". Their workspace is /workspace.`);
      if (persona) parts.push(`## Persona\n\n${persona}`);
      if (rules) parts.push(`## Standing rules from the user\n\nFollow these unless the user overrides them in the conversation:\n\n${rules}`);
      return parts.length ? defineInstructions({ markdown: parts.join("\n\n") }) : null;
    },
  },
});
