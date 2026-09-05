// Reads the TOML that package manifests use (pyproject.toml, Cargo.toml)
// without a TOML library: tables, arrays of tables, dotted keys, strings,
// numbers, booleans, arrays, inline tables, and comments. Dates and any
// other shape are reported as a parse error rather than guessed at.

export type TomlValue =
  | string
  | number
  | boolean
  | TomlValue[]
  | { [key: string]: TomlValue };
export type TomlTable = { [key: string]: TomlValue };

export type TomlRead =
  | { ok: true; value: TomlTable }
  | { ok: false; reason: string };

const BARE_KEY = /^[A-Za-z0-9_-]+/;
const NUMBER =
  /^[+-]?(?:0x[0-9A-Fa-f_]+|0o[0-7_]+|0b[01_]+|(?:\d[\d_]*)(?:\.\d[\d_]*)?(?:[eE][+-]?\d[\d_]*)?|inf|nan)$/;
const ESCAPES: Record<string, string> = {
  b: "\b",
  t: "\t",
  n: "\n",
  f: "\f",
  r: "\r",
  '"': '"',
  "\\": "\\",
};

export function isTable(v: unknown): v is TomlTable {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

class ParseError extends Error {}

class Parser {
  private pos = 0;
  private line = 1;
  readonly root: TomlTable = {};
  private current: TomlTable = this.root;

  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  parse(): TomlTable {
    for (;;) {
      this.skipBlank();
      if (this.pos >= this.text.length) return this.root;
      if (this.peek() === "[") this.header();
      else this.keyValue(this.current);
      this.endOfLine();
    }
  }

  private fail(msg: string): never {
    throw new ParseError(`line ${this.line}: ${msg}`);
  }

  private peek(offset = 0): string {
    return this.text[this.pos + offset] ?? "";
  }

  private advance(n = 1): void {
    for (let i = 0; i < n; i++) {
      if (this.text[this.pos] === "\n") this.line++;
      this.pos++;
    }
  }

  private skipSpaces(): void {
    while (this.peek() === " " || this.peek() === "\t") this.advance();
  }

  private skipComment(): void {
    if (this.peek() !== "#") return;
    while (this.pos < this.text.length && this.peek() !== "\n") this.advance();
  }

  /** Whitespace, comments, and newlines. */
  private skipBlank(): void {
    for (;;) {
      this.skipSpaces();
      this.skipComment();
      if (this.peek() === "\n" || this.peek() === "\r") this.advance();
      else return;
    }
  }

  private endOfLine(): void {
    this.skipSpaces();
    this.skipComment();
    if (this.pos >= this.text.length) return;
    if (this.peek() === "\r") this.advance();
    if (this.peek() !== "\n") this.fail(`unexpected "${this.peek()}"`);
    this.advance();
  }

  private header(): void {
    const array = this.peek(1) === "[";
    this.advance(array ? 2 : 1);
    this.skipSpaces();
    const path = this.key();
    this.skipSpaces();
    const close = array ? "]]" : "]";
    if (this.text.startsWith(close, this.pos)) this.advance(close.length);
    else this.fail(`expected "${close}"`);
    const parentPath = path.slice(0, -1);
    const last = path[path.length - 1] ?? "";
    const parent = this.table(this.root, parentPath);
    if (array) {
      const existing = parent[last];
      const list: TomlValue[] =
        existing === undefined ? [] : Array.isArray(existing) ? existing : [];
      if (existing !== undefined && !Array.isArray(existing))
        this.fail(`"${path.join(".")}" is not an array of tables`);
      const table: TomlTable = {};
      list.push(table);
      parent[last] = list;
      this.current = table;
    } else {
      this.current = this.table(parent, [last]);
    }
  }

  /** Walks (creating as needed) to the table at `path`, entering the last
   *  element of any array of tables on the way. */
  private table(from: TomlTable, path: string[]): TomlTable {
    let t = from;
    for (const seg of path) {
      const next = t[seg];
      if (next === undefined) {
        const created: TomlTable = {};
        t[seg] = created;
        t = created;
      } else if (Array.isArray(next)) {
        const last = next[next.length - 1];
        if (!isTable(last)) this.fail(`"${seg}" is not a table`);
        t = last;
      } else if (isTable(next)) {
        t = next;
      } else {
        this.fail(`"${seg}" is already a value, not a table`);
      }
    }
    return t;
  }

  /** A dotted key: bare or quoted segments separated by dots. */
  private key(): string[] {
    const parts: string[] = [];
    for (;;) {
      let part: string;
      if (this.peek() === '"') part = this.basicString();
      else if (this.peek() === "'") part = this.literalString();
      else {
        const m = BARE_KEY.exec(this.text.slice(this.pos));
        if (m === null) this.fail("expected a key");
        part = m[0];
        this.advance(part.length);
      }
      parts.push(part);
      this.skipSpaces();
      if (this.peek() !== ".") return parts;
      this.advance();
      this.skipSpaces();
    }
  }

  private keyValue(into: TomlTable): void {
    const path = this.key();
    if (this.peek() !== "=") this.fail('expected "="');
    this.advance();
    this.skipSpaces();
    const value = this.value();
    const parent = this.table(into, path.slice(0, -1));
    const last = path[path.length - 1] ?? "";
    if (last in parent) this.fail(`"${path.join(".")}" is defined twice`);
    parent[last] = value;
  }

  private value(): TomlValue {
    const c = this.peek();
    if (c === '"')
      return this.text.startsWith('"""', this.pos)
        ? this.multiline('"""')
        : this.basicString();
    if (c === "'")
      return this.text.startsWith("'''", this.pos)
        ? this.multiline("'''")
        : this.literalString();
    if (c === "[") return this.array();
    if (c === "{") return this.inlineTable();
    return this.scalar();
  }

  private scalar(): TomlValue {
    let end = this.pos;
    while (
      end < this.text.length &&
      !",]}#\n\r \t".includes(this.text[end] ?? "")
    )
      end++;
    const raw = this.text.slice(this.pos, end);
    if (raw.length === 0) this.fail("expected a value");
    this.advance(raw.length);
    if (raw === "true") return true;
    if (raw === "false") return false;
    if (NUMBER.test(raw)) {
      const n = Number(raw.replace(/_/g, ""));
      if (!Number.isNaN(n) || raw.endsWith("nan")) return n;
    }
    this.fail(`unsupported value "${raw}"`);
  }

  private basicString(): string {
    this.advance();
    let out = "";
    for (;;) {
      const c = this.peek();
      if (c === "") this.fail("unterminated string");
      if (c === "\n") this.fail("newline in string");
      if (c === '"') {
        this.advance();
        return out;
      }
      if (c === "\\") {
        const e = this.peek(1);
        if (e === "u" || e === "U") {
          const len = e === "u" ? 4 : 8;
          const hex = this.text.slice(this.pos + 2, this.pos + 2 + len);
          if (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== len)
            this.fail("bad unicode escape");
          out += String.fromCodePoint(Number.parseInt(hex, 16));
          this.advance(2 + len);
          continue;
        }
        const mapped = ESCAPES[e];
        if (mapped === undefined) this.fail(`bad escape "\\${e}"`);
        out += mapped;
        this.advance(2);
        continue;
      }
      out += c;
      this.advance();
    }
  }

  private literalString(): string {
    this.advance();
    const end = this.text.indexOf("'", this.pos);
    const nl = this.text.indexOf("\n", this.pos);
    if (end === -1 || (nl !== -1 && nl < end)) this.fail("unterminated string");
    const out = this.text.slice(this.pos, end);
    this.advance(out.length + 1);
    return out;
  }

  /** A `"""` or `'''` string. Escapes inside are left as written; these
   *  strings only ever hold descriptions and readmes, never names. */
  private multiline(quote: string): string {
    this.advance(3);
    if (this.peek() === "\n") this.advance();
    let end = this.text.indexOf(quote, this.pos);
    while (end !== -1 && quote === '"""' && this.text[end - 1] === "\\")
      end = this.text.indexOf(quote, end + 1);
    if (end === -1) this.fail("unterminated string");
    const out = this.text.slice(this.pos, end);
    this.advance(out.length + 3);
    return out;
  }

  private array(): TomlValue[] {
    this.advance();
    const out: TomlValue[] = [];
    for (;;) {
      this.skipBlank();
      if (this.peek() === "]") {
        this.advance();
        return out;
      }
      out.push(this.value());
      this.skipBlank();
      if (this.peek() === ",") this.advance();
      else if (this.peek() !== "]") this.fail('expected "," or "]"');
    }
  }

  private inlineTable(): TomlTable {
    this.advance();
    const out: TomlTable = {};
    this.skipBlank();
    if (this.peek() === "}") {
      this.advance();
      return out;
    }
    for (;;) {
      this.skipBlank();
      this.keyValue(out);
      this.skipBlank();
      if (this.peek() === ",") {
        this.advance();
        continue;
      }
      if (this.peek() === "}") {
        this.advance();
        return out;
      }
      this.fail('expected "," or "}"');
    }
  }
}

export function parseToml(text: string): TomlRead {
  try {
    return { ok: true, value: new Parser(text).parse() };
  } catch (e) {
    if (e instanceof ParseError) return { ok: false, reason: e.message };
    throw e;
  }
}

/** `get(doc, "tool", "uv", "workspace")`: the value at a key path, or undefined. */
export function get(doc: TomlTable, ...path: string[]): TomlValue | undefined {
  let v: TomlValue | undefined = doc;
  for (const seg of path) {
    if (!isTable(v)) return undefined;
    v = v[seg];
  }
  return v;
}

/** The string elements of an array value; nothing for any other shape. */
export function strings(v: TomlValue | undefined): string[] {
  return Array.isArray(v)
    ? v.filter((s): s is string => typeof s === "string")
    : [];
}
