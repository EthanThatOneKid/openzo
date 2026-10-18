// Deploy fix: force the complete `zod` into the traced function output.
//
// When a deployed agent pulls `@zocomputer/agent-sdk`, eve/nitro externalizes
// `@ai-sdk/provider-utils` into its own `_libs/ai-sdk__provider-utils.mjs` chunk. That
// chunk imports the peer `zod/v4`. Because the chunk is EXTERNAL, nitro's node-file-trace
// does not follow its imports — so while eve's bundled code pulls deep zod paths
// (`zod/v4/core`, `zod/v4/locales`), nothing ever traces the `zod/v4` BARREL
// (`zod/v4/index.js`). At runtime:
//   ERR_MODULE_NOT_FOUND: Cannot find module '/var/task/node_modules/zod/v4/index.js'
//     imported from /var/task/_libs/ai-sdk__provider-utils.mjs
//
// `traceDeps` is Nitro's option for force-including extra packages in the externals
// trace (Nitro passes `options.traceDeps` into the externals tracer; there is no
// `externals.traceInclude` reader). `"zod*"` pulls the complete zod (all of v4 incl. the
// barrel, and v3 which provider-utils also imports) into the function output. eve loads
// this config and doesn't set `traceDeps`, so it merges cleanly.
//
// Verify locally (no deploy needed): build the agent, then direct-import the external
// chunk — it must resolve, proving the barrel shipped:
//   node --input-type=module -e 'import("./.output/server/_libs/ai-sdk__provider-utils.mjs")'
//
// COMPLEMENTARY FIX (see `overrides.zod` in package.json): `traceDeps` guarantees the
// zod barrel *ships*, but not that a SINGLE zod ships. `@vercel/cli-config` pins an exact
// `zod: 4.1.11` while this agent pins `zod: ^4.4.3`, so a plain install leaves TWO zod
// copies in the tree. Nitro then hoists ONE of them to `node_modules/zod`, and the
// bundle's bare `import { z } from "zod"` (agent-sdk's defineOp calling `z.toJSONSchema`)
// binds to whichever copy won hoisting — not necessarily this agent's ^4.4.3. When the
// hoisted copy is a zod that predates top-level `z.toJSONSchema` (any zod < 4.0, which the
// ai-sdk peer range `^3.25.76 || ^4.1.8` permits), the deployed function throws at runtime:
//   TypeError: z.toJSONSchema is not a function   (at defineOp)
// `overrides.zod: "^4.4.3"` collapses the whole tree to a single zod 4.4.3 so hoisting is
// unambiguous and the bundle always binds a zod that has `z.toJSONSchema`.
export default {
  traceDeps: ["zod*"],
};
