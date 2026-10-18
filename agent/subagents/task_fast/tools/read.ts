// Re-export of the parent's read. Unlike the SDK's local-fs task kit, this
// needs no child-safe override: the parent's sandbox-backed instance already
// disables attachments (no media follow-up delivery on this topology), so its
// media hints are honest in a child too.
export { default } from "../../../tools/read";
