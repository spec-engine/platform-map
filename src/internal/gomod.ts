// Reads go.mod (module path, require lines) and go.work (use lines) by
// line. Directives are `name arg` or `name ( ... )` blocks; a comment starts
// with `//`. Anything that does not parse is an error, not a guess.

export type GoModRead =
  | { ok: true; module?: string; requires: string[] }
  | { ok: false; reason: string };

export type GoWorkRead =
  | { ok: true; uses: string[] }
  | { ok: false; reason: string };

interface Directive {
  name: string;
  args: string[];
  line: number;
}

function unquote(s: string): string {
  return s.length >= 2 && s.startsWith('"') && s.endsWith('"')
    ? s.slice(1, -1)
    : s;
}

/** Flattens blocks so every entry is one `name args...` directive. */
function directives(text: string): Directive[] | string {
  const out: Directive[] = [];
  let block: { name: string; line: number } | null = null;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const cut = raw.indexOf("//");
    const line = (cut === -1 ? raw : raw.slice(0, cut)).trim();
    if (line.length === 0) continue;
    const tokens = line.split(/\s+/);
    if (block !== null) {
      if (line === ")") {
        block = null;
        continue;
      }
      out.push({ name: block.name, args: tokens, line: i + 1 });
      continue;
    }
    const name = tokens[0] ?? "";
    const args = tokens.slice(1);
    if (args[0] === "(") {
      if (args.length !== 1) return `line ${i + 1}: unexpected text after "("`;
      block = { name, line: i + 1 };
      continue;
    }
    out.push({ name, args, line: i + 1 });
  }
  if (block !== null) return `line ${block.line}: unclosed "${block.name} ("`;
  return out;
}

export function parseGoMod(text: string): GoModRead {
  const parsed = directives(text);
  if (typeof parsed === "string") return { ok: false, reason: parsed };
  let module: string | undefined;
  const requires: string[] = [];
  for (const d of parsed) {
    if (d.name === "module") {
      if (d.args.length !== 1)
        return { ok: false, reason: `line ${d.line}: module needs one path` };
      module = unquote(d.args[0] ?? "");
    } else if (d.name === "require") {
      if (d.args.length < 2)
        return {
          ok: false,
          reason: `line ${d.line}: require needs a path and a version`,
        };
      requires.push(unquote(d.args[0] ?? ""));
    }
  }
  const out: GoModRead = { ok: true, requires: [...new Set(requires)].sort() };
  if (module !== undefined) out.module = module;
  return out;
}

/** Paths from `use` lines, relative to the go.work directory, with `./`
 *  stripped. `use .` (the root itself) is dropped: the root is the repo. */
export function parseGoWork(text: string): GoWorkRead {
  const parsed = directives(text);
  if (typeof parsed === "string") return { ok: false, reason: parsed };
  const uses: string[] = [];
  for (const d of parsed) {
    if (d.name !== "use") continue;
    if (d.args.length !== 1)
      return { ok: false, reason: `line ${d.line}: use needs one path` };
    const p = unquote(d.args[0] ?? "")
      .replace(/^\.\//, "")
      .replace(/\/+$/, "");
    if (p !== "." && p.length > 0) uses.push(p);
  }
  return { ok: true, uses };
}
