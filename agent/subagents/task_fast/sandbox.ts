// The parent's zoSandbox(), re-exported. CRITICAL: an unauthored subagent
// sandbox slot does NOT inherit the parent's — it falls back to eve's
// framework default sandbox (the docker/local ladder), which would try to
// boot Docker on a Vercel function. With this re-export (and the broker
// keying a child's sandbox on the ROOT session's id — sandbox lineage), the
// child's ctx.getSandbox() resolves the same Daytona sandbox as the parent
// session: same workspace, writes visible in both directions.
export { default } from "../../sandbox";
