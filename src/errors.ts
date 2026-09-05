/** Thrown when the directory given to a command does not exist. Every other
 *  problem becomes a diagnostic. The message carries only the basename. */
export class DirectoryNotFoundError extends Error {
  constructor(basename: string) {
    super(`directory not found: ${basename}`);
    this.name = "DirectoryNotFoundError";
  }
}
