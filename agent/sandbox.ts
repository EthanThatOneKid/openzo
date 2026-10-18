// Real bash on the user's real workspace — see ./lib/host-sandbox.ts for why
// openzo does not use eve's docker/microsandbox/just-bash ladder.
import { defineSandbox } from "eve/sandbox";
import { hostSandbox } from "./lib/host-sandbox";

export default defineSandbox({ backend: hostSandbox() });
