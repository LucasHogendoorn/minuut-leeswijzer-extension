// node --import ./test/register.mjs --test test/
// Maps the Workers-only module "cloudflare:workers" to a tiny stand-in, so the
// Worker's own modules load in plain Node for the tests. No dependencies.
import { register } from "node:module";

const stub = "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }";
const hooks = `
export async function resolve(specifier, context, next) {
  if (specifier === "cloudflare:workers") return { url: "data:text/javascript," + encodeURIComponent(${JSON.stringify(stub)}), shortCircuit: true };
  return next(specifier, context);
}`;
register("data:text/javascript," + encodeURIComponent(hooks));

// Workers-only: crypto.subtle.timingSafeEqual (used by the stats endpoint).
if (!crypto.subtle.timingSafeEqual) {
  const { timingSafeEqual } = await import("node:crypto");
  crypto.subtle.timingSafeEqual = (a, b) => timingSafeEqual(new Uint8Array(a), new Uint8Array(b));
}
