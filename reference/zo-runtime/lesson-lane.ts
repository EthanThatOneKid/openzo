import type { StateFilesClient } from "@zocomputer/agent-sdk/state-files";

/** A lesson mounted in the lessons store (matches memory-fixtures' id + body shape). */
export type MountedLesson = {
  readonly id: string;
  readonly body: string;
};

/** Relative-key namespace lessons live under — same layout as memory-fixtures mounting. */
export const LESSON_PREFIX = "lessons/";

/** The store key for a lesson id. */
export function lessonKey(id: string): string {
  return `${LESSON_PREFIX}${id}.md`;
}

/** The lesson id encoded in a store key — inverse of {@link lessonKey}. */
export function lessonIdFromKey(key: string): string {
  const withoutPrefix = key.startsWith(LESSON_PREFIX)
    ? key.slice(LESSON_PREFIX.length)
    : key;
  return withoutPrefix.endsWith(".md")
    ? withoutPrefix.slice(0, -".md".length)
    : withoutPrefix;
}

/** A listed lesson whose body read failed — the key plus what `read` threw. */
export type LessonReadFailure = {
  readonly key: string;
  readonly error: unknown;
};

/** What {@link readMountedLessons} returns: the readable lessons plus any per-key read failures. */
export type MountedLessonsResult = {
  readonly lessons: readonly MountedLesson[];
  readonly failures: readonly LessonReadFailure[];
};

/**
 * Read mounted lessons through the state-files client (`list` + `read`). Sorted
 * by key so order is stable regardless of the backing store's iteration order.
 * A single failed read (deleted between list and read, transient error) is
 * isolated into `failures` rather than rejecting the whole read — otherwise one
 * bad object would drop every other mounted lesson from the prompt.
 */
export async function readMountedLessons(
  client: StateFilesClient,
): Promise<MountedLessonsResult> {
  const objects = [...(await client.list(LESSON_PREFIX))].sort((a, b) =>
    a.key.localeCompare(b.key),
  );
  const decoder = new TextDecoder();
  const lessons: MountedLesson[] = [];
  const failures: LessonReadFailure[] = [];
  for (const object of objects) {
    let bytes: Uint8Array;
    try {
      bytes = await client.read(object.key);
    } catch (error) {
      failures.push({ key: object.key, error });
      continue;
    }
    lessons.push({ id: lessonIdFromKey(object.key), body: decoder.decode(bytes) });
  }
  return { lessons, failures };
}

/** Compose mounted lessons into a markdown block for the system prompt. */
export function formatLessonsForInstructions(
  lessons: readonly MountedLesson[],
): string | null {
  if (lessons.length === 0) {
    return null;
  }
  const sections = lessons.map(
    (lesson) => `### ${lesson.id}\n\n${lesson.body.trim()}`,
  );
  return [
    "The following lessons are mounted in your memory. Treat them as accumulated guidance unless they conflict with platform safety or the user's explicit request.",
    "",
    sections.join("\n\n"),
  ].join("\n");
}
