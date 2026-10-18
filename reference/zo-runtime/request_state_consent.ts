import { createRequestStateConsentTool } from "@zocomputer/agent-sdk/state-consent";

// The filename is the wire name the model sees (`request_state_consent`). The
// tool parks on eve's approval rail: when a state operation returns
// `consent_required`, the model is steered to call this with the 409's envelope,
// and the call suspends as a durable input request until the consumer grants
// (or denies) — the approval decision is the consumer's client-side action, not
// the agent's. See bead zo-oxg.27.3.
export default createRequestStateConsentTool();
