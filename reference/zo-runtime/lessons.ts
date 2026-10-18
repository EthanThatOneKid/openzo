import { defineDynamic, defineInstructions } from "eve/instructions";

import { createLessonsReader } from "../shared/lesson-client";
import {
  formatLessonsForInstructions,
  readMountedLessons,
} from "../shared/lesson-lane";

// Session-scoped like every dynamic instruction — part of the cached prefix.
// Reads the `lessons` external-state store at session start so adversarial
// memory fixtures (M6 conformance proof) actually reach the model.
export default defineDynamic({
  events: {
    "session.started": async (_event, context) => {
      // The store is session-partitioned, so the broker rejects a handle
      // request without the session id (`eve_session_required`). The resolve
      // context carries it explicitly; the reader has no ambient fallback.
      const sessionId = context.session.id.trim();
      try {
        const reader = createLessonsReader(
          sessionId.length > 0 ? { getSessionId: () => sessionId } : {},
        );
        const { lessons, failures } = await readMountedLessons(reader);
        for (const failure of failures) {
          // A per-key read failure is isolated so the other lessons still
          // reach the prompt — but log it for the same vacuous-proof reason
          // as the outer catch.
          console.warn(
            `lessons instruction: reading mounted lesson "${failure.key}" failed`,
            failure.error,
          );
        }
        const markdown = formatLessonsForInstructions(lessons);
        if (markdown === null) {
          return defineInstructions({ markdown: "" });
        }
        return defineInstructions({ markdown });
      } catch (error) {
        // Unbound lessons store or broker unavailable — stay a blank slate,
        // but log it: a silent read failure is indistinguishable from an
        // empty store, which would let a mounted-lessons proof pass vacuously.
        console.warn("lessons instruction: reading mounted lessons failed", error);
        return defineInstructions({ markdown: "" });
      }
    },
  },
});
