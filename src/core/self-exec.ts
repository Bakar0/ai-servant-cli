// Helpers for re-invoking `servant` from within itself, in a way that works both when run
// from source (`bun run src/index.ts …`) and as a `bun build --compile` standalone binary.
//
// In a compiled binary the embedded module filesystem lives under `/$bunfs/`, so
// `import.meta.url` looks like `file:///$bunfs/root/servant` and `process.argv[1]` is a
// virtual path, not a real script. `process.execPath` is the binary itself. In dev,
// `process.execPath` is the `bun` runtime and `process.argv[1]` is the real script path.

/** True when running inside a `bun build --compile` standalone binary. */
export function isCompiled(): boolean {
  return import.meta.url.includes("/$bunfs/");
}

/**
 * The argv prefix that re-invokes this same `servant` entrypoint, ready to have subcommand
 * args appended. Compiled: `[<binary>]`. Dev: `[<bun>, <script path>]`.
 */
export function servantReinvokeArgv(): string[] {
  if (isCompiled()) return [process.execPath];
  const script = process.argv[1];
  // Fall back to a bare `servant` on PATH if argv[1] is somehow absent in dev.
  return script ? [process.execPath, script] : ["servant"];
}
