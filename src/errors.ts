// The TWO throwing cases in the whole library (SEC-01): a nonexistent root
// passed to detect()/map() (RootNotFoundError), and a present-but-malformed
// canonical platform-map.json (MalformedConfigError). Everything else degrades
// to a Diagnostic (DESIGN.md §5's never-fail-non-canonical contract) — these
// two are the deliberately narrow exceptions.

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

/** Thrown when a PRESENT `platform-map.json` cannot be read, cannot be parsed
 *  as JSON, or fails hand-rolled shape validation (CFG-02). This is the second
 *  and final hard-error case (SEC-01): an ABSENT config is fine (config is
 *  optional forever, D8) and a malformed ADAPTER source only degrades to a
 *  MALFORMED_CONFIG diagnostic — canonical is the sole configuration source
 *  allowed to throw. The caller-supplied message is location-tagged and MUST
 *  carry a root-relative path only, never an absolute one (determinism/§5). */
export class MalformedConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedConfigError";
  }
}
