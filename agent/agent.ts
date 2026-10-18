// openzo root agent. The model lane is resolved from env in ./lib/models.ts;
// the gateway register import keeps the seed's bare-slug routing alive for the
// "zo" lane and is inert for every lane that passes a model instance.
import "@zocomputer/agent-sdk/ai/register";
import { STDLIB_EXTERNAL_DEPENDENCIES } from "@zocomputer/agent-sdk";
import { defineAgent } from "eve";
import { activeLane, resolveModel } from "./lib/models";

export default defineAgent({
  model: resolveModel("main"),
  ...(activeLane() === "zo" ? { reasoning: "medium" as const } : {}),
  build: { externalDependencies: [...STDLIB_EXTERNAL_DEPENDENCIES] },
});
