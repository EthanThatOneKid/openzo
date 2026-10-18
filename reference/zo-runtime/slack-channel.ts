import { connectSlackCredentials } from "@vercel/connect/eve";
import { slackChannel } from "eve/channels/slack";

// Slack rides Vercel Connect: Zo bakes ZO_CONNECTOR_SLACK_UID (this agent's
// connector) into the Vercel project env at deploy time, and Connect mints the
// bot token per request and verifies inbound webhooks — no Slack secrets live
// in this repo. Vercel Connect forwards the workspace's Slack events to this
// channel's route (/eve/v1/slack) once the connector is installed.
//
// Without the env var the channel still mounts but holds no credentials, so
// inbound events fail verification and are rejected — connecting Slack later
// needs no code change here.
const connectorUid = process.env.ZO_CONNECTOR_SLACK_UID;

export default slackChannel(
  connectorUid ? { credentials: connectSlackCredentials(connectorUid) } : {},
);
