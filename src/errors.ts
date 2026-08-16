// [SEC-01] The TWO throwing cases in the whole library: a nonexistent root
// passed to detect()/map(), and a present-but-malformed canonical
// platform-map.json. Everything else degrades to a Diagnostic.

/** Thrown when the root path passed to detect()/map() does not exist on disk.
 *  The message carries only a root-relative or basename reference, never an
 *  absolute path (no absolute paths in any output, thrown messages included). */
export class RootNotFoundError extends Error {
  constructor(rootDisplay: string) {
    super(`platform-map: root not found: ${rootDisplay}`);
    this.name = "RootNotFoundError";
  }
}

/** Thrown when a PRESENT `platform-map.json` cannot be read, parsed as JSON,
 *  or shape-validated. An ABSENT config is fine (config is optional forever)
 *  and a malformed ADAPTER source only degrades to a diagnostic; canonical is
 *  the sole configuration source allowed to throw. The caller-supplied message
 *  MUST carry a root-relative path only, never an absolute one. */
export class MalformedConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedConfigError";
  }
}
