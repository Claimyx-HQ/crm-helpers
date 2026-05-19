// Internal cross-runtime env-var accessor. Not part of the public API
// surface — not exported from `deno.json` — but importable from other
// modules in this package so we don't drift two copies of the shim.
//
// The package's primary consumer is Base44 (Deno), but the README also
// advertises Node.js support. Reading `Deno.env.get(...)` directly crashes
// on Node with `ReferenceError: Deno is not defined`, so every env read
// inside this package goes through {@link getEnv}.

/**
 * Read an environment variable across Deno and Node runtimes. Returns the
 * empty string when the variable is unset OR when neither `Deno` nor
 * `process` is available (e.g. an unusual runtime where every consumer
 * should explicitly guard on the empty value).
 *
 * Internal only — not re-exported from a public module entry point.
 */
export function getEnv(key: string): string {
  const denoGlobal = (globalThis as { Deno?: { env?: { get?: (k: string) => string | undefined } } }).Deno;
  if (denoGlobal?.env?.get) return denoGlobal.env.get(key) || '';
  const nodeProcess = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  if (nodeProcess?.env) return nodeProcess.env[key] || '';
  return '';
}
