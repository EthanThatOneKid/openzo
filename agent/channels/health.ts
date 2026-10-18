import { GET, defineChannel } from "eve/channels";

// Boot healthcheck: a trivial GET /health served BY the deployed agent function.
// Its value isn't the 200 body — it's that REACHING it proves the serverless
// function actually booted and its whole module graph loaded. A build can pass
// while the function dies on first request (e.g. the eve zod/v4
// ERR_MODULE_NOT_FOUND — a missing-module crash 500s before it can answer), so
// apps/api pings this once at the ready->promote transition and only promotes a
// deployment whose agent boots. Behind Vercel Deployment Protection; the pinger
// carries the project bypass secret, so no eve-layer auth is needed here.
export default defineChannel({
  routes: [GET("/health", () => Promise.resolve(Response.json({ ok: true })))],
});
