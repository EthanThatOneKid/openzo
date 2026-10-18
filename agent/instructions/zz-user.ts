// The user's active persona and standing rules, fetched from the openzo host at
// the start of every conversation (host/profile.ts), so edits in Settings or
// via the manage_profile tool apply to the next conversation with no restart.
// Falls back to the OPENZO_PERSONA / OPENZO_RULES env the host sets at boot.
import { defineDynamic, defineInstructions } from "eve/instructions";
import { hostApi, hostApiAvailable } from "../lib/host-api";

interface Profile {
  activePersona: { name: string; prompt: string } | null;
  rules: { id: number; condition: string; instruction: string; enabled: boolean }[];
  legacy: { persona: string; rules: string };
}

export default defineDynamic({
  events: {
    "session.started": async () => {
      const user = process.env.OPENZO_USER?.trim();
      let profile: Profile | null = null;
      if (hostApiAvailable()) profile = await hostApi<Profile>("GET", "/profile", undefined, 10_000).catch(() => null);
      const persona = profile?.activePersona?.prompt ?? (profile ? profile.legacy.persona : process.env.OPENZO_PERSONA?.trim());
      const legacyRules = profile ? profile.legacy.rules : process.env.OPENZO_RULES?.trim();
      const parts: string[] = [];
      if (user) {
        const now = new Date();
        parts.push(`You are working for the openzo user "${user}". Their workspace is /workspace. Current time: ${now.toISOString()}.`);
      }
      if (persona?.trim()) parts.push(`## Persona${profile?.activePersona ? ` — ${profile.activePersona.name}` : ""}\n\n${persona.trim()}`);
      const ruleLines = (profile?.rules ?? [])
        .filter((r) => r.enabled)
        .map((r) => (r.condition ? `- [rule ${r.id}] When ${r.condition}: ${r.instruction}` : `- [rule ${r.id}] ${r.instruction}`));
      if (legacyRules?.trim()) ruleLines.push(legacyRules.trim());
      if (ruleLines.length) parts.push(`## Standing rules from the user\n\nFollow these unless the user overrides them in the conversation (conditional rules apply only when their condition holds):\n\n${ruleLines.join("\n")}`);
      parts.push(
        "When the user asks you to remember a preference or always/never do something, save it as a rule with manage_profile instead of only acknowledging it.",
      );
      return defineInstructions({ markdown: parts.join("\n\n") });
    },
  },
});
