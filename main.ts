// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
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

/** Shared context for the three formats I write: strict matching, and the move pairs edits record. */
interface Ctx {
  strict: boolean;
  moves: Array<[string, string]>;
}

interface FileParts {
  lines: string[];
  br: string;
  eol: boolean;
}

/** A file's lines under section 3: split at its own break, dropping the empty piece after a final break. */
function splitFile(text: string): FileParts {
  if (text === '') return { lines: [], br: '\n', eol: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const eol = text.endsWith(br);
  if (eol) parts.pop();
  return { lines: parts, br, eol };
}

function joinFile(p: FileParts): string {
  if (p.lines.length === 0) return '';
  return p.lines.join(p.br) + (p.eol ? p.br : '');
}

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/** Positions where O occurs in lines from `from`, at one tier. */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  const on = o.map((x) => normLine(x, tier));
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normLine(lines[i + j]!, tier) !== on[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** Section 5: the first tier (0, then 1, then 2; only 0 when strict) at which O occurs at least once. */
function tiered(lines: string[], o: string[], strict: boolean, from: number): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

type Op = { kind: 'ctx' | 'del' | 'add'; text: string };

function opOld(ops: Op[]): string[] {
  return ops.filter((o) => o.kind !== 'add').map((o) => o.text);
}

function opNew(ops: Op[]): string[] {
  return ops.filter((o) => o.kind !== 'del').map((o) => o.text);
}

/** Section 5 re-indentation of one added line at tier 2. */
function reindent(text: string, tier: number, f: string, p: string): string {
  if (tier !== 2) return text;
  if (text === '' || text.trim() === '') return text;
  if (!text.startsWith(p)) return text;
  return f + text.slice(p.length);
}

/**
 * The lines that replace O at position pos: context lines are the file's own
 * matched lines, added lines are re-indented at tier 2.
 */
function buildNew(fileLines: string[], pos: number, ops: Op[], tier: number): string[] {
  const o = opOld(ops);
  const f = o.length > 0 ? leadingWs(fileLines[pos]!) : '';
  const p = o.length > 0 ? leadingWs(o[0]!) : '';
  const out: string[] = [];
  let oi = 0;
  for (const op of ops) {
    if (op.kind === 'ctx') {
      out.push(fileLines[pos + oi]!);
      oi += 1;
    } else if (op.kind === 'del') {
      oi += 1;
    } else {
      out.push(reindent(op.text, tier, f, p));
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Section 6: unified diffs                                            */
/* ------------------------------------------------------------------ */

interface Hunk {
  a: number;
  ops: Op[];
  /** a `\` line follows the hunk's last context or `+` line */
  noEol: boolean;
  /** a `\` line follows the hunk's last `+` line */
  plusNoEol: boolean;
}

function parseDiffGit(line: string): [string, string] | null {
  const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line);
  return m ? [m[1]!, m[2]!] : null;
}

function stripAB(p: string): string | null {
  if (p === '/dev/null') return null;
  if (p.startsWith('a/')) return p.slice(2);
  if (p.startsWith('b/')) return p.slice(2);
  return p;
}

/** The path of a `--- ` / `+++ ` header line: after the four characters, up to the first tab, trimmed. */
function headerPath(line: string): string | null {
  return stripAB(line.slice(4).split('\t')[0]!.trim());
}

function parseHunkHeader(line: string): number | null {
  const m = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(line);
  return m ? parseInt(m[1]!, 10) : null;
}

type BodyLine = { kind: 'ctx' | 'del' | 'add' | 'mark'; text: string };

/** A hunk body: lines starting with ` `, `-`, `+`, `\`, or empty; trailing empty context lines are not part of it. */
function collectBody(lines: string[], i: number): { body: BodyLine[]; next: number } {
  const body: BodyLine[] = [];
  let j = i;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') body.push({ kind: 'ctx', text: '' });
    else if (l.startsWith(' ')) body.push({ kind: 'ctx', text: l.slice(1) });
    else if (l.startsWith('-')) body.push({ kind: 'del', text: l.slice(1) });
    else if (l.startsWith('+')) body.push({ kind: 'add', text: l.slice(1) });
    else if (l.startsWith('\\')) body.push({ kind: 'mark', text: l });
    else break;
    j += 1;
  }
  while (body.length > 0) {
    const last = body[body.length - 1]!;
    if (last.kind === 'ctx' && last.text === '') body.pop();
    else break;
  }
  return { body, next: j };
}

function hunkFromBody(a: number, body: BodyLine[]): Hunk {
  const ops: Op[] = [];
  let lastCA = -1;
  let lastAdd = -1;
  body.forEach((b, idx) => {
    if (b.kind === 'ctx' || b.kind === 'add') lastCA = idx;
    if (b.kind === 'add') lastAdd = idx;
  });
  const noEol = lastCA >= 0 && body[lastCA + 1]?.kind === 'mark';
  const plusNoEol = lastAdd >= 0 && body[lastAdd + 1]?.kind === 'mark';
  for (const b of body) {
    if (b.kind === 'ctx') ops.push({ kind: 'ctx', text: b.text });
    else if (b.kind === 'del') ops.push({ kind: 'del', text: b.text });
    else if (b.kind === 'add') ops.push({ kind: 'add', text: b.text });
  }
  return { a, ops, noEol, plusNoEol };
}

/** Apply a section's hunks in order to a file's text, following section 6. */
function applyHunks(before: string, hunks: Hunk[], strict: boolean, path: string): string {
  const parts = splitFile(before);
  const lines = parts.lines;
  let eol = parts.eol;
  let d = 0;
  for (const h of hunks) {
    const o = opOld(h.ops);
    const n = opNew(h.ops);
    if (o.length > 0) {
      const found = tiered(lines, o, strict, 0);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let pos = found.occ[0]!;
      let best = Math.abs(pos - target);
      for (const q of found.occ) {
        const dist = Math.abs(q - target);
        if (dist < best) {
          best = dist;
          pos = q;
        }
      }
      const touches = pos + o.length === lines.length;
      const repl = buildNew(lines, pos, h.ops, found.tier);
      lines.splice(pos, o.length, ...repl);
      if (touches) eol = !h.noEol;
    } else {
      const at = Math.min(Math.max(h.a + d, 0), lines.length);
      const touches = at === lines.length;
      lines.splice(at, 0, ...n);
      if (touches) eol = !h.noEol;
    }
    d += n.length - o.length;
  }
  return joinFile({ lines, br: parts.br, eol });
}

interface RawSec {
  gitA: string | null;
  gitB: string | null;
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renOld: string | null | undefined;
  renNew: string | null | undefined;
  hasPair: boolean;
  newFile: boolean;
  delFile: boolean;
  inHeader: boolean;
  hunks: Hunk[];
}

function unifiedSectionEdit(s: RawSec, ctx: Ctx): Edit {
  const oldPath = s.pairOld !== undefined ? s.pairOld : s.renOld !== undefined ? s.renOld : s.gitA;
  const newPath = s.pairNew !== undefined ? s.pairNew : s.renNew !== undefined ? s.renNew : s.gitB;
  const isCreation = oldPath === null || s.newFile;
  const isDeletion = !isCreation && (newPath === null || s.delFile);
  return (tree) => {
    if (isCreation) {
      if (newPath === null) return;
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const adds: string[] = [];
      let lastPlusNoEol = false;
      for (const h of s.hunks) {
        for (const op of h.ops) {
          if (op.kind === 'add') {
            adds.push(op.text);
            lastPlusNoEol = h.plusNoEol;
          }
        }
      }
      tree.now.set(newPath, adds.length === 0 ? '' : adds.join('\n') + (lastPlusNoEol ? '' : '\n'));
      return;
    }
    if (isDeletion) {
      if (oldPath === null) return;
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
      return;
    }
    if (oldPath !== null && newPath !== null && oldPath !== newPath) {
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      const before = tree.get(oldPath);
      if (before === null) throw new Fail('missing', oldPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const result = applyHunks(before, s.hunks, ctx.strict, oldPath);
      tree.now.set(oldPath, null);
      tree.now.set(newPath, result);
      ctx.moves.push([oldPath, newPath]);
      return;
    }
    const p = oldPath ?? newPath;
    if (p === null) return;
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const result = applyHunks(before, s.hunks, ctx.strict, p);
    tree.now.set(p, result);
  };
}

function unifiedEdits(lines: string[], ctx: Ctx): Edit[] {
  const secs: RawSec[] = [];
  let cur: RawSec | null = null;
  const startSec = (gitA: string | null = null, gitB: string | null = null): RawSec => {
    const s: RawSec = {
      gitA,
      gitB,
      pairOld: undefined,
      pairNew: undefined,
      renOld: undefined,
      renNew: undefined,
      hasPair: false,
      newFile: false,
      delFile: false,
      inHeader: true,
      hunks: [],
    };
    secs.push(s);
    cur = s;
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git')) {
      const g = parseDiffGit(l);
      if (g === null) throw new Exit2(`error: parse ${i + 1}`);
      startSec(g[0], g[1]);
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && cur.inHeader && !cur.hasPair) {
        cur.pairOld = headerPath(l);
        cur.pairNew = headerPath(lines[i + 1]!);
        cur.hasPair = true;
      } else {
        const s = startSec();
        s.pairOld = headerPath(l);
        s.pairNew = headerPath(lines[i + 1]!);
        s.hasPair = true;
      }
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseHunkHeader(l);
      if (a === null) throw new Exit2(`error: parse ${i + 1}`);
      const { body, next } = collectBody(lines, i + 1);
      cur.hunks.push(hunkFromBody(a, body));
      cur.inHeader = false;
      i = next;
      continue;
    }
    if (cur !== null && cur.inHeader) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('rename from ')) {
        const p = l.slice('rename from '.length).trim();
        cur.renOld = p === '/dev/null' ? null : p;
      } else if (l.startsWith('rename to ')) {
        const p = l.slice('rename to '.length).trim();
        cur.renNew = p === '/dev/null' ? null : p;
      } else if (l.startsWith('new file mode')) cur.newFile = true;
      else if (l.startsWith('deleted file mode')) cur.delFile = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return secs.map((s) => unifiedSectionEdit(s, ctx));
}

/* ------------------------------------------------------------------ */
/* Section 7: SEARCH/REPLACE blocks                                    */
/* ------------------------------------------------------------------ */

function srEdit(path: string, oldLines: string[], newLines: string[], ctx: Ctx): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const parts = splitFile(before);
    const found = tiered(parts.lines, oldLines, ctx.strict, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const ops: Op[] = [
      ...oldLines.map((t): Op => ({ kind: 'del', text: t })),
      ...newLines.map((t): Op => ({ kind: 'add', text: t })),
    ];
    const repl = buildNew(parts.lines, pos, ops, found.tier);
    const lines2 = parts.lines.slice();
    lines2.splice(pos, oldLines.length, ...repl);
    tree.now.set(path, joinFile({ lines: lines2, br: parts.br, eol: parts.eol }));
  };
}

function searchReplaceEdits(lines: string[], ctx: Ctx): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
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
    let m = -1;
    for (let j = s + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        m = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (m < 0) throw new Exit2(`error: parse ${s + 1}`);
    let r = -1;
    for (let j = m + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        r = j;
        break;
      }
    }
    if (r < 0) throw new Exit2(`error: parse ${s + 1}`);
    edits.push(srEdit(path, lines.slice(s + 1, m), lines.slice(m + 1, r), ctx));
    prevEnd = r;
    prevPath = path;
    i = r + 1;
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* Section 8: V4A patches                                              */
/* ------------------------------------------------------------------ */

interface V4AChunk {
  anchor: string | null;
  eof: boolean;
  ops: Op[];
}

interface V4ASection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  lines: string[];
  chunks: V4AChunk[];
  lineNo: number;
}

function v4aSectionEdit(s: V4ASection, ctx: Ctx): Edit {
  if (s.kind === 'add') {
    return (tree) => {
      if (!safe(s.path)) throw new Fail('unsafe', s.path);
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, s.lines.length === 0 ? '' : s.lines.join('\n') + '\n');
    };
  }
  if (s.kind === 'delete') {
    return (tree) => {
      if (!safe(s.path)) throw new Fail('unsafe', s.path);
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
    };
  }
  return (tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    const before = tree.get(s.path);
    if (before === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    const parts = splitFile(before);
    const lines = parts.lines.slice();
    let cursor = 0;
    for (const ch of s.chunks) {
      if (ch.anchor !== null) {
        const found = tiered(lines, [ch.anchor], ctx.strict, cursor);
        if (found === null) throw new Fail('no-match', s.path);
        cursor = found.occ[0]! + 1;
      }
      const o = opOld(ch.ops);
      const n = opNew(ch.ops);
      if (o.length === 0) {
        const at = ch.eof ? lines.length : cursor;
        lines.splice(at, 0, ...n);
        cursor = at + n.length;
      } else {
        let chosen: { tier: number; pos: number } | null = null;
        const tiers = ctx.strict ? [0] : [0, 1, 2];
        for (const t of tiers) {
          let occ = occurrences(lines, o, t, cursor);
          if (ch.eof) occ = occ.filter((q) => q + o.length === lines.length);
          if (occ.length > 0) {
            chosen = { tier: t, pos: occ[0]! };
            break;
          }
        }
        if (chosen === null) throw new Fail('no-match', s.path);
        const repl = buildNew(lines, chosen.pos, ch.ops, chosen.tier);
        lines.splice(chosen.pos, o.length, ...repl);
        cursor = chosen.pos + repl.length;
      }
    }
    const result = joinFile({ lines, br: parts.br, eol: parts.eol });
    if (s.moveTo !== null) {
      tree.now.set(s.path, null);
      tree.now.set(s.moveTo, result);
      ctx.moves.push([s.path, s.moveTo]);
    } else {
      tree.now.set(s.path, result);
    }
  };
}

function v4aEdits(lines: string[], ctx: Ctx): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  interface Raw {
    kind: 'add' | 'delete' | 'update';
    path: string;
    lineNo: number;
    raw: Array<{ text: string; idx: number }>;
  }
  const rawSecs: Raw[] = [];
  let curSec: Raw | null = null;
  for (let idx = first + 1; idx < last; idx++) {
    const l = lines[idx]!;
    if (l.startsWith('*** Add File: ')) {
      curSec = { kind: 'add', path: l.slice('*** Add File: '.length).trim(), lineNo: idx + 1, raw: [] };
      rawSecs.push(curSec);
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      curSec = { kind: 'delete', path: l.slice('*** Delete File: '.length).trim(), lineNo: idx + 1, raw: [] };
      rawSecs.push(curSec);
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      curSec = { kind: 'update', path: l.slice('*** Update File: '.length).trim(), lineNo: idx + 1, raw: [] };
      rawSecs.push(curSec);
      continue;
    }
    if (blank(l)) {
      if (curSec !== null) curSec.raw.push({ text: l, idx });
      continue;
    }
    if (curSec === null) throw new Exit2(`error: parse ${idx + 1}`);
    curSec.raw.push({ text: l, idx });
  }
  for (const s of rawSecs) {
    while (s.raw.length > 0 && blank(s.raw[s.raw.length - 1]!.text)) s.raw.pop();
  }
  const sections: V4ASection[] = [];
  for (const s of rawSecs) {
    if (s.kind === 'add') {
      const fileLines: string[] = [];
      for (const { text, idx } of s.raw) {
        if (text.startsWith('+')) fileLines.push(text.slice(1));
        else if (blank(text)) fileLines.push('');
        else throw new Exit2(`error: parse ${idx + 1}`);
      }
      sections.push({ kind: 'add', path: s.path, moveTo: null, lines: fileLines, chunks: [], lineNo: s.lineNo });
      continue;
    }
    if (s.kind === 'delete') {
      if (s.raw.length > 0) throw new Exit2(`error: parse ${s.raw[0]!.idx + 1}`);
      sections.push({ kind: 'delete', path: s.path, moveTo: null, lines: [], chunks: [], lineNo: s.lineNo });
      continue;
    }
    let moveTo: string | null = null;
    let pos = 0;
    while (pos < s.raw.length && blank(s.raw[pos]!.text)) pos += 1;
    if (pos < s.raw.length && s.raw[pos]!.text.startsWith('*** Move to: ')) {
      moveTo = s.raw[pos]!.text.slice('*** Move to: '.length).trim();
      pos += 1;
    }
    const chunks: V4AChunk[] = [];
    let curChunk: V4AChunk | null = null;
    for (; pos < s.raw.length; pos++) {
      const { text, idx } = s.raw[pos]!;
      if (text.startsWith('@@')) {
        const anchor = text.slice(2).trim();
        curChunk = { anchor: anchor === '' ? null : anchor, eof: false, ops: [] };
        chunks.push(curChunk);
        continue;
      }
      if (text.startsWith(' ') || text.startsWith('-') || text.startsWith('+') || text === '' || blank(text)) {
        if (curChunk === null) {
          if (chunks.length === 0) {
            curChunk = { anchor: null, eof: false, ops: [] };
            chunks.push(curChunk);
          } else if (blank(text)) {
            continue;
          } else {
            throw new Exit2(`error: parse ${idx + 1}`);
          }
        }
        if (text.startsWith(' ')) curChunk.ops.push({ kind: 'ctx', text: text.slice(1) });
        else if (text.startsWith('-')) curChunk.ops.push({ kind: 'del', text: text.slice(1) });
        else if (text.startsWith('+')) curChunk.ops.push({ kind: 'add', text: text.slice(1) });
        else curChunk.ops.push({ kind: 'ctx', text: '' });
        continue;
      }
      if (text.trim() === '*** End of File') {
        if (curChunk === null) throw new Exit2(`error: parse ${idx + 1}`);
        curChunk.eof = true;
        curChunk = null;
        continue;
      }
      throw new Exit2(`error: parse ${idx + 1}`);
    }
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${s.lineNo}`);
    sections.push({ kind: 'update', path: s.path, moveTo, lines: [], chunks, lineNo: s.lineNo });
  }
  return sections.map((s) => v4aSectionEdit(s, ctx));
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
  const ctx: Ctx = { strict, moves: [] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, ctx)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, ctx)
            : v4aEdits(lines, ctx);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: Array<{ key: string; text: string }> = [];
  const usedOld = new Set<string>();
  const usedNew = new Set<string>();
  for (const [o, n] of ctx.moves) {
    if (usedOld.has(o) || usedNew.has(n)) continue;
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && tree.get(n) !== null) {
      rows.push({ key: n, text: `R ${o} -> ${n}` });
      usedOld.add(o);
      usedNew.add(n);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (usedOld.has(p) || usedNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const outRows = rows.map((r) => r.text);
  return { code: 0, out: [...outRows, `ok: ${outRows.length} ${outRows.length === 1 ? 'file' : 'files'}`] };
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
