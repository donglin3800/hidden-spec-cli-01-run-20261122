// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// It does all of SPEC.md: the command line, the output and exit codes, safe paths, format detection, JSON edits
// and the all-or-nothing write (sections 1 to 4, 9 and 10), three-tier line matching (section 5), unified diffs
// (section 6), SEARCH/REPLACE blocks (section 7) and V4A patches (section 8).
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { old: string; new: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Section 5: matching lines, and section 3: a file's lines and line break.
// ---------------------------------------------------------------------------

const stripTrailing = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWs = (s: string): string => (s.match(/^[ \t]*/) ?? [''])[0]!;

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrailing(a) === stripTrailing(b);
  return stripBoth(a) === stripBoth(b);
}

interface FileText {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileText {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

/** The first tier at which O occurs in lines (searching from `from`), and its positions there. */
function findTierFrom(
  O: string[],
  lines: string[],
  strict: boolean,
  from: number,
  eofOnly: boolean,
): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    let ps: number[] = [];
    for (let i = from; i + O.length <= lines.length; i++) {
      if (O.every((o, j) => lineEq(o, lines[i + j]!, t))) ps.push(i);
    }
    if (eofOnly) ps = ps.filter((p) => p + O.length === lines.length);
    if (ps.length > 0) return { tier: t, positions: ps };
  }
  return null;
}

function findTier(O: string[], lines: string[], strict: boolean): { tier: number; positions: number[] } | null {
  return findTierFrom(O, lines, strict, 0, false);
}

/**
 * Render the replacement lines N for a match of O at `pos` in `lines`.
 * `ctx[j]` is the O index of N[j] when N[j] is a context line, else -1: a context line is written as
 * the file's own matched line, and at tier 2 every other line is re-indented from P to F.
 */
function renderN(lines: string[], pos: number, O: string[], N: string[], ctx: number[], tier: number): string[] {
  if (O.length === 0) return [...N];
  const F = leadingWs(lines[pos]!);
  const P = leadingWs(O[0]!);
  return N.map((nl, j) => {
    if (ctx[j]! >= 0) return lines[pos + ctx[j]!]!;
    if (tier === 2) {
      if (nl !== '' && nl.trim() !== '' && nl.startsWith(P)) return F + nl.slice(P.length);
      return nl;
    }
    return nl;
  });
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs.
// ---------------------------------------------------------------------------

interface Hunk {
  A: number;
  O: string[];
  N: string[];
  ctx: number[];
  plus: string[];
  lastNBackslash: boolean;
  lastPlusBs: boolean;
}

function buildHunk(A: number, body: string[]): Hunk {
  interface BE {
    kind: 'ctx' | 'old' | 'new';
    text: string;
    bs: boolean;
  }
  const entries: BE[] = [];
  for (const raw of body) {
    if (raw.startsWith('\\')) {
      if (entries.length > 0) entries[entries.length - 1]!.bs = true;
      continue;
    }
    if (raw === '') entries.push({ kind: 'ctx', text: '', bs: false });
    else if (raw.startsWith(' ')) entries.push({ kind: 'ctx', text: raw.slice(1), bs: false });
    else if (raw.startsWith('-')) entries.push({ kind: 'old', text: raw.slice(1), bs: false });
    else if (raw.startsWith('+')) entries.push({ kind: 'new', text: raw.slice(1), bs: false });
  }
  const O: string[] = [];
  const N: string[] = [];
  const ctx: number[] = [];
  const nBs: boolean[] = [];
  const plus: string[] = [];
  let lastPlusBs = false;
  for (const e of entries) {
    if (e.kind === 'ctx') {
      const oi = O.length;
      O.push(e.text);
      N.push(e.text);
      ctx.push(oi);
      nBs.push(e.bs);
    } else if (e.kind === 'old') {
      O.push(e.text);
    } else {
      N.push(e.text);
      ctx.push(-1);
      nBs.push(e.bs);
      plus.push(e.text);
      lastPlusBs = e.bs;
    }
  }
  return { A, O, N, ctx, plus, lastNBackslash: N.length > 0 ? nBs[nBs.length - 1]! : false, lastPlusBs };
}

/** Apply a section's hunks in order to a file's text; throws Fail on a hunk failure. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = splitFile(text);
  const lines = f.lines;
  let final = f.final;
  const br = f.br;
  let d = 0;
  for (const h of hunks) {
    if (h.O.length === 0) {
      let at = h.A + d;
      if (at < 0) at = 0;
      if (at > lines.length) at = lines.length;
      const atEnd = at === lines.length;
      lines.splice(at, 0, ...h.N);
      if (atEnd && h.N.length > 0) final = !h.lastNBackslash;
      d += h.N.length;
    } else {
      const found = findTier(h.O, lines, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.A - 1 + d;
      let pos = found.positions[0]!;
      let best = Math.abs(pos - target);
      for (const p of found.positions) {
        const dist = Math.abs(p - target);
        if (dist < best) {
          best = dist;
          pos = p;
        }
      }
      const touchesEnd = pos + h.O.length === lines.length;
      const rep = renderN(lines, pos, h.O, h.N, h.ctx, found.tier);
      lines.splice(pos, h.O.length, ...rep);
      if (touchesEnd) {
        if (h.N.length === 0) final = lines.length > 0;
        else final = !h.lastNBackslash;
      }
      d += h.N.length - h.O.length;
    }
  }
  return joinFile(lines, br, final);
}

interface UniSection {
  oldPath: string | null | undefined;
  newPath: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  diffOld: string | undefined;
  diffNew: string | undefined;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** The path after a `--- ` / `+++ ` marker: up to the first tab, spaces removed, a/ or b/ removed, /dev/null as null. */
function unifiedPath(raw: string): string | null {
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

function headerPath(line: string): string {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  return t.trim();
}

function unifiedSectionEdit(sec: UniSection, strict: boolean): Edit {
  const oldP = sec.oldPath !== undefined ? sec.oldPath : sec.renameFrom !== undefined ? sec.renameFrom : sec.diffOld;
  const newP = sec.newPath !== undefined ? sec.newPath : sec.renameTo !== undefined ? sec.renameTo : sec.diffNew;
  const oldPath = oldP === undefined ? (newP ?? null) : oldP;
  const newPath = newP === undefined ? (oldP ?? null) : newP;
  const isCreate = oldPath === null || sec.isCreate;
  const isDelete = !isCreate && (newPath === null || sec.isDelete);
  const isMove = !isCreate && !isDelete && oldPath !== null && newPath !== null && oldPath !== newPath;
  if (isCreate) {
    const np = newPath;
    return (tree) => {
      if (np === null) throw new Fail('unsafe', '');
      if (!safe(np)) throw new Fail('unsafe', np);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const out: string[] = [];
      let lastPlusBs = false;
      let anyPlus = false;
      for (const h of sec.hunks) {
        for (const p of h.plus) out.push(p);
        if (h.plus.length > 0) {
          anyPlus = true;
          lastPlusBs = h.lastPlusBs;
        }
      }
      tree.now.set(np, out.length === 0 ? '' : out.join('\n') + (anyPlus && lastPlusBs ? '' : '\n'));
    };
  }
  if (isDelete) {
    const op = oldPath;
    return (tree) => {
      if (op === null) throw new Fail('unsafe', '');
      if (!safe(op)) throw new Fail('unsafe', op);
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
    };
  }
  if (isMove) {
    const op = oldPath as string;
    const np = newPath as string;
    return (tree) => {
      if (!safe(op)) throw new Fail('unsafe', op);
      if (!safe(np)) throw new Fail('unsafe', np);
      if (tree.get(op) === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const res = applyHunks(tree.get(op)!, sec.hunks, strict, op);
      tree.now.set(op, null);
      tree.now.set(np, res);
      tree.moves.push({ old: op, new: np });
    };
  }
  const p = oldPath as string;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (tree.get(p) === null) throw new Fail('missing', p);
    tree.now.set(p, applyHunks(tree.get(p)!, sec.hunks, strict, p));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  let i = 0;
  const newSection = (diffOld?: string, diffNew?: string): UniSection => {
    const s: UniSection = {
      oldPath: undefined,
      newPath: undefined,
      renameFrom: undefined,
      renameTo: undefined,
      diffOld,
      diffNew,
      isCreate: false,
      isDelete: false,
      hunks: [],
    };
    sections.push(s);
    return s;
  };
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection(m[1], m[2]);
      inHeader = true;
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const A = parseInt(m[1]!, 10);
      i++;
      const body: string[] = [];
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl.startsWith('diff --git ')) break;
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\')) {
          body.push(bl);
          i++;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push(buildHunk(A, body));
      inHeader = false;
      continue;
    }
    if (!inHeader && line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      cur = newSection();
      inHeader = true;
      cur.oldPath = unifiedPath(headerPath(line));
      cur.newPath = unifiedPath(headerPath(lines[i + 1]!));
      i += 2;
      continue;
    }
    if (cur === null) {
      i++;
      continue;
    }
    if (inHeader) {
      if (line.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          cur.oldPath = unifiedPath(headerPath(line));
          cur.newPath = unifiedPath(headerPath(lines[i + 1]!));
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (line.startsWith('+++ ')) {
        cur.newPath = unifiedPath(headerPath(line));
        i++;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.isCreate = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.isDelete = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => unifiedSectionEdit(sec, strict));
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks.
// ---------------------------------------------------------------------------

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  interface Block {
    path: string;
    oldLines: string[];
    newLines: string[];
  }
  const blocks: Block[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const s = i;
    let path: string | null = null;
    for (let j = s - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = s + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq === -1) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new Exit2(`error: parse ${s + 1}`);
    blocks.push({ path, oldLines: lines.slice(s + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => {
    const { path, oldLines, newLines } = b;
    return (tree: Tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (oldLines.length === 0) {
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(path);
      if (before === null) throw new Fail('missing', path);
      const f = splitFile(before);
      const found = findTier(oldLines, f.lines, strict);
      if (found === null) throw new Fail('no-match', path);
      if (found.positions.length > 1) throw new Fail('ambiguous', path);
      const pos = found.positions[0]!;
      const rep = renderN(f.lines, pos, oldLines, newLines, newLines.map(() => -1), found.tier);
      const outLines = f.lines.slice();
      outLines.splice(pos, oldLines.length, ...rep);
      tree.now.set(path, joinFile(outLines, f.br, f.final));
    };
  });
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches.
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  O: string[];
  N: string[];
  ctx: number[];
  eof: boolean;
}

function matchV4aSection(line: string): { kind: 'add' | 'delete' | 'update'; path: string } | null {
  if (line.startsWith('*** Add File: ')) return { kind: 'add', path: line.slice('*** Add File: '.length).trim() };
  if (line.startsWith('*** Delete File: ')) return { kind: 'delete', path: line.slice('*** Delete File: '.length).trim() };
  if (line.startsWith('*** Update File: ')) return { kind: 'update', path: line.slice('*** Update File: '.length).trim() };
  return null;
}

/** The first line at or after `from` equal to the anchor at the first tier where one is, else -1. */
function findAnchor(anchor: string, lines: string[], from: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let k = from; k < lines.length; k++) {
      if (lineEq(anchor, lines[k]!, t)) return k;
    }
  }
  return -1;
}

function v4aSectionEdit(
  sec: { kind: 'add' | 'delete' | 'update'; path: string },
  collected: { no: number; text: string }[],
  startLine: number,
  strict: boolean,
): Edit {
  const path = sec.path;
  if (sec.kind === 'add') {
    const fileLines: string[] = [];
    for (const c of collected) {
      if (c.text.startsWith('+')) fileLines.push(c.text.slice(1));
      else if (c.text === '') fileLines.push('');
      else throw new Exit2(`error: parse ${c.no}`);
    }
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
    };
  }
  if (sec.kind === 'delete') {
    for (const c of collected) throw new Exit2(`error: parse ${c.no}`);
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    };
  }
  let moveTo: string | null = null;
  let idx = 0;
  if (collected.length > 0 && collected[0]!.text.startsWith('*** Move to: ')) {
    moveTo = collected[0]!.text.slice('*** Move to: '.length).trim();
    idx = 1;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  let sawChunk = false;
  for (; idx < collected.length; idx++) {
    const c = collected[idx]!;
    const l = c.text;
    if (l.startsWith('@@')) {
      const anchorText = l.slice(2).trim();
      cur = { anchor: anchorText === '' ? null : anchorText, O: [], N: [], ctx: [], eof: false };
      chunks.push(cur);
      sawChunk = true;
    } else if (l.trimEnd() === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${c.no}`);
      cur.eof = true;
      cur = null;
    } else if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      if (cur === null) {
        if (sawChunk) throw new Exit2(`error: parse ${c.no}`);
        cur = { anchor: null, O: [], N: [], ctx: [], eof: false };
        chunks.push(cur);
        sawChunk = true;
      }
      if (l === '') {
        const oi = cur.O.length;
        cur.O.push('');
        cur.N.push('');
        cur.ctx.push(oi);
      } else if (l.startsWith(' ')) {
        const oi = cur.O.length;
        const t = l.slice(1);
        cur.O.push(t);
        cur.N.push(t);
        cur.ctx.push(oi);
      } else if (l.startsWith('-')) {
        cur.O.push(l.slice(1));
      } else {
        cur.N.push(l.slice(1));
        cur.ctx.push(-1);
      }
    } else {
      throw new Exit2(`error: parse ${c.no}`);
    }
  }
  if (!sawChunk && moveTo === null) throw new Exit2(`error: parse ${startLine}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitFile(before);
    const curLines = f.lines;
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const ai = findAnchor(ch.anchor, curLines, cursor, strict);
        if (ai === -1) throw new Fail('no-match', path);
        cursor = ai + 1;
      }
      if (ch.O.length === 0) {
        const at = ch.eof ? curLines.length : cursor;
        curLines.splice(at, 0, ...ch.N);
        cursor = at + ch.N.length;
      } else {
        const found = findTierFrom(ch.O, curLines, strict, cursor, ch.eof);
        if (found === null) throw new Fail('no-match', path);
        const pos = found.positions[0]!;
        const rep = renderN(curLines, pos, ch.O, ch.N, ch.ctx, found.tier);
        curLines.splice(pos, ch.O.length, ...rep);
        cursor = pos + rep.length;
      }
    }
    const out = joinFile(curLines, f.br, f.final);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push({ old: path, new: moveTo });
    } else {
      tree.now.set(path, out);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    const sec = matchV4aSection(line);
    if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
    const startLine = i + 1;
    const collected: { no: number; text: string }[] = [];
    i++;
    while (i < last) {
      const l = lines[i]!;
      if (matchV4aSection(l) !== null) break;
      collected.push({ no: i + 1, text: l });
      i++;
    }
    while (collected.length > 0 && blank(collected[collected.length - 1]!.text)) collected.pop();
    edits.push(v4aSectionEdit(sec, collected, startLine, strict));
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; text: string }[] = [];
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const m of tree.moves) {
    if (tree.original(m.old) !== null && tree.get(m.old) === null && tree.original(m.new) === null && tree.get(m.new) !== null) {
      const di = rows.findIndex((r) => r.text === `D ${m.old}`);
      if (di >= 0) rows.splice(di, 1);
      const ai = rows.findIndex((r) => r.text === `A ${m.new}`);
      if (ai >= 0) rows.splice(ai, 1);
      rows.push({ key: m.new, text: `R ${m.old} -> ${m.new}` });
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
