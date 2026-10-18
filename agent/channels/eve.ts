// The HTTP channel the openzo host proxies to. Every request reaching a
// user's runtime comes through the host, which signs a short-lived HS256 JWT
// with OPENZO_AGENT_SECRET (principal = the user). With a secret set, the JWT
// is the only way in — loopback is not trusted, because on the process driver
// every user's runtime shares 127.0.0.1. Without one (running the agent alone
// in development), localDev() admits loopback calls only.
import { jwtHmac, localDev } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

const secret = process.env.OPENZO_AGENT_SECRET?.trim();

export default eveChannel({
  auth: secret
    ? [jwtHmac({ algorithm: "HS256", secret, issuer: "openzo-host", audiences: ["openzo-agent"] })]
    : [localDev()],
});
