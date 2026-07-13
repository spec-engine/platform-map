// The single Phase-1 throwing case: a nonexistent root passed to detect()/map().
// Everything else degrades to a Diagnostic (DESIGN.md §5's never-fail-non-canonical
// contract) — this is the one exception, deliberately narrow.

/** Thrown when the root path passed to detect()/map() does not exist on disk.
 *  The message carries only a root-relative or basename reference — never an
 *  absolute filesystem path (determinism/§5: no absolute paths in any output,
 *  including thrown messages). */
export class RootNotFoundError extends Error {
  constructor(rootDisplay: string) {
    super(`platform-map: root not found: ${rootDisplay}`);
    this.name = "RootNotFoundError";
  }
}
