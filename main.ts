// main.ts is mend, the CLI SPEC.md specifies. It covers every section of SPEC.md: the command line,
// the output and exit codes, safe paths, format detection, the three-tier line matcher, unified
// diffs, SEARCH/REPLACE blocks, V4A patches, JSON edits, and the all-or-nothing write with move
// reporting. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands
// over to runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and
// write the CLI.

import { mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
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

/** A file as lines: its line break, its lines, and whether it ends with a break (SPEC section 3). */
interface FileModel {
  lines: string[];
  br: '\n' | '\r\n';
  final: boolean;
}

function parseFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br: '\n' | '\r\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function writeFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** One line compared at a tier: tier 0 exact, tier 1 trailing spaces/tabs off, tier 2 both ends off. */
function norm(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every position at or after `from` where `o` matches `lines` at `tier`; occurrences may overlap. */
function occurrences(lines: string[], o: string[], tier: number, from: number, eofOnly: boolean): number[] {
  const pos: number[] = [];
  for (let i = from; i + o.length <= lines.length; i += 1) {
    if (eofOnly && i + o.length !== lines.length) continue;
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (norm(lines[i + j]!, tier) !== norm(o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) pos.push(i);
  }
  return pos;
}

/** The first tier (0, 1, 2; only 0 with --strict) at which `o` occurs, with its positions. */
function findTier(lines: string[], o: string[], strict: boolean): { tier: number; pos: number[] } | null {
  return findTierFrom(lines, o, 0, strict, false);
}

function findTierFrom(lines: string[], o: string[], from: number, strict: boolean, eofOnly: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(lines, o, t, from, eofOnly);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** The first line at or after `from` equal to `anchor` at the first tier where one is (one line). */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i += 1) {
      if (norm(lines[i]!, t) === norm(anchor, t)) return i;
    }
  }
  return -1;
}

/** One body line of a unified hunk or a V4A chunk: context, old, or new; `noEol` when a `\` line follows it. */
interface BodyLine {
  kind: 'ctx' | 'del' | 'add';
  text: string;
  noEol: boolean;
}

/** Split a hunk/chunk body into its old lines O and its new lines N (SPEC section 5). */
function splitBody(body: BodyLine[]): { o: string[]; n: Array<{ text: string; oIndex: number }> } {
  const o: string[] = [];
  const n: Array<{ text: string; oIndex: number }> = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      n.push({ text: b.text, oIndex: o.length });
      o.push(b.text);
    } else if (b.kind === 'del') {
      o.push(b.text);
    } else {
      n.push({ text: b.text, oIndex: -1 });
    }
  }
  return { o, n };
}

/**
 * Build the new lines for a replacement at `at`: a context line is written as the file's own
 * matched line, never the patch's; at tier 2 every other line is re-indented (P of O's first
 * line replaced by F of the file's first matched line). With no first line (pure insertion)
 * the lines are written as they are.
 */
function buildReplacement(
  n: Array<{ text: string; oIndex: number }>,
  oFirst: string | null,
  fileFirst: string | null,
  tier: number,
  fileLines: string[],
  at: number,
): string[] {
  const p = oFirst === null ? '' : leadingWs(oFirst);
  const f = fileFirst === null ? '' : leadingWs(fileFirst);
  const out: string[] = [];
  for (const x of n) {
    if (x.oIndex >= 0) {
      out.push(fileLines[at + x.oIndex]!);
      continue;
    }
    let s = x.text;
    if (tier === 2 && s !== '' && s.trim() !== '' && s.startsWith(p)) s = f + s.slice(p.length);
    out.push(s);
  }
  return out;
}

function lastCtxAdd(body: BodyLine[]): BodyLine | undefined {
  let last: BodyLine | undefined;
  for (const b of body) if (b.kind === 'ctx' || b.kind === 'add') last = b;
  return last;
}

function lastAdd(body: BodyLine[]): BodyLine | undefined {
  let last: BodyLine | undefined;
  for (const b of body) if (b.kind === 'add') last = b;
  return last;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<{ old: string; new: string }> = [];
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

/* ------------------------------------------------------------------ unified (SPEC 6) */

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

const DIFF_GIT = /^diff --git a\/(.+) b\/(.+)$/;
const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function headerPath(line: string): string | null {
  const t = line.slice(4).split('\t')[0]!.trim();
  if (t === '/dev/null') return null;
  return t.startsWith('a/') || t.startsWith('b/') ? t.slice(2) : t;
}

function parseUnified(lines: string[]): UniSection[] {
  const sections: UniSection[] = [];
  const n = lines.length;
  let cur: UniSection | null = null;
  let inHeader = false;
  let hasDashPair = false;
  let i = 0;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { oldPath: m[1]!, newPath: m[2]!, create: false, del: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      hasDashPair = false;
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      // A pair belongs to the current section's header only while that header has no
      // pair yet; a second pair starts a new section (SPEC section 6).
      if (cur !== null && inHeader && !hasDashPair) {
        cur.oldPath = headerPath(l);
        cur.newPath = headerPath(lines[i + 1]!);
        hasDashPair = true;
        i += 2;
        continue;
      }
      cur = { oldPath: headerPath(l), newPath: headerPath(lines[i + 1]!), create: false, del: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      hasDashPair = true;
      i += 2;
      continue;
    }
    if (cur === null) {
      if (l.startsWith('@@')) {
        if (HUNK_HEAD.exec(l) === null) throw new Exit2(`error: parse ${i + 1}`);
        throw new Exit2(`error: parse ${i + 1}`);
      }
      i += 1;
      continue;
    }
    if (inHeader) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('rename from ')) {
        if (!hasDashPair) cur.oldPath = l.slice(12).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('rename to ')) {
        if (!hasDashPair) cur.newPath = l.slice(10).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur.create = true;
        i += 1;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur.del = true;
        i += 1;
        continue;
      }
      if (l.startsWith('@@')) {
        const m = HUNK_HEAD.exec(l);
        if (m === null) throw new Exit2(`error: parse ${i + 1}`);
        const hunk: Hunk = { a: parseInt(m[1]!, 10), body: [] };
        i = collectHunkBody(lines, i + 1, hunk);
        cur.hunks.push(hunk);
        inHeader = false;
        continue;
      }
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      const m = HUNK_HEAD.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: parseInt(m[1]!, 10), body: [] };
      i = collectHunkBody(lines, i + 1, hunk);
      cur.hunks.push(hunk);
      continue;
    }
    i += 1;
  }
  return sections;
}

/** Collect a hunk body starting at `start`; returns the index of the first line after it. */
function collectHunkBody(lines: string[], start: number, hunk: Hunk): number {
  const raw: string[] = [];
  let j = start;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      raw.push(l);
      j += 1;
      continue;
    }
    break;
  }
  while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  for (let k = 0; k < raw.length; k += 1) {
    const l = raw[k]!;
    const noEol = k + 1 < raw.length && raw[k + 1]!.startsWith('\\');
    if (l === '') hunk.body.push({ kind: 'ctx', text: '', noEol });
    else if (l[0] === ' ') hunk.body.push({ kind: 'ctx', text: l.slice(1), noEol });
    else if (l[0] === '-') hunk.body.push({ kind: 'del', text: l.slice(1), noEol });
    else if (l[0] === '+') hunk.body.push({ kind: 'add', text: l.slice(1), noEol });
    // a `\` line refers to the body line before it and is not a line itself.
  }
  return j;
}

/** Apply one hunk to the model; returns N's length minus O's length. Throws Fail('no-match'). */
function applyHunk(model: FileModel, hunk: Hunk, strict: boolean, d: number, path: string): number {
  const { o, n } = splitBody(hunk.body);
  if (o.length === 0) {
    let at = hunk.a + d;
    if (at < 0) at = 0;
    if (at > model.lines.length) at = model.lines.length;
    const atEnd = at === model.lines.length;
    const ins = buildReplacement(n, null, null, 0, model.lines, at);
    model.lines.splice(at, 0, ...ins);
    if (atEnd) {
      const last = lastCtxAdd(hunk.body);
      model.final = !(last !== undefined && last.noEol);
    }
    return n.length;
  }
  const found = findTier(model.lines, o, strict);
  if (found === null) throw new Fail('no-match', path);
  const target = hunk.a - 1 + d;
  let at = found.pos[0]!;
  let best = Math.abs(at - target);
  for (const p of found.pos) {
    const dist = Math.abs(p - target);
    if (dist < best) {
      at = p;
      best = dist;
    }
  }
  const runsToEnd = at + o.length === model.lines.length;
  const repl = buildReplacement(n, o[0]!, model.lines[at]!, found.tier, model.lines, at);
  model.lines.splice(at, o.length, ...repl);
  if (runsToEnd) {
    const last = lastCtxAdd(hunk.body);
    model.final = !(last !== undefined && last.noEol);
  }
  return n.length - o.length;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseUnified(lines);
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => (tree: Tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    const isCreate = sec.create || oldP === null;
    if (isCreate) {
      const p = newP;
      if (p === null) return;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      for (const h of sec.hunks) for (const b of h.body) if (b.kind === 'add') plus.push(b.text);
      let final = true;
      for (const h of sec.hunks) {
        const last = lastAdd(h.body);
        if (last !== undefined) final = !last.noEol;
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (final ? '\n' : ''));
      return;
    }
    const isDelete = sec.del || newP === null;
    if (isDelete) {
      const p = oldP;
      if (p === null) return;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const p = oldP!;
    const target = newP!;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (target !== p && !safe(target)) throw new Fail('unsafe', target);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (target !== p && tree.get(target) !== null) throw new Fail('exists', target);
    const model = parseFile(before);
    let d = 0;
    for (const h of sec.hunks) d += applyHunk(model, h, strict, d, p);
    const text = writeFile(model);
    if (target === p) {
      tree.now.set(p, text);
    } else {
      tree.now.set(p, null);
      tree.now.set(target, text);
      tree.moves.push({ old: p, new: target });
    }
  });
}

/* ------------------------------------------------------- SEARCH/REPLACE (SPEC 7) */

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSR(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let prevReplaceEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= prevReplaceEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine}`);
    blocks.push({ path, oldLines: lines.slice(i + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevReplaceEnd = rep + 1;
    i = rep + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks;
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  return parseSR(lines).map((b) => (tree: Tree) => {
    const p = b.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (b.oldLines.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const model = parseFile(before);
    const found = findTier(model.lines, b.oldLines, strict);
    if (found === null) throw new Fail('no-match', p);
    if (found.pos.length > 1) throw new Fail('ambiguous', p);
    const at = found.pos[0]!;
    const pLead = leadingWs(b.oldLines[0]!);
    const fLead = leadingWs(model.lines[at]!);
    const repl = b.newLines.map((s) => {
      if (found.tier === 2 && s !== '' && s.trim() !== '' && s.startsWith(pLead)) return fLead + s.slice(pLead.length);
      return s;
    });
    model.lines.splice(at, b.oldLines.length, ...repl);
    tree.now.set(p, writeFile(model));
  });
}

/* ------------------------------------------------------------------- V4A (SPEC 8) */

interface V4AChunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

interface V4ASection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  addLines: string[];
  chunks: V4AChunk[];
}

const ADD_PREFIX = '*** Add File: ';
const DEL_PREFIX = '*** Delete File: ';
const UPD_PREFIX = '*** Update File: ';
const MOVE_PREFIX = '*** Move to: ';

function parseV4A(lines: string[]): V4ASection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4ASection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (l.startsWith(ADD_PREFIX)) {
      kind = 'add';
      path = l.slice(ADD_PREFIX.length).trim();
    } else if (l.startsWith(DEL_PREFIX)) {
      kind = 'delete';
      path = l.slice(DEL_PREFIX.length).trim();
    } else if (l.startsWith(UPD_PREFIX)) {
      kind = 'update';
      path = l.slice(UPD_PREFIX.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const headerLine = i + 1;
    let j = i + 1;
    const raw: string[] = [];
    const rawStart = j;
    while (j < last) {
      const m = lines[j]!;
      if (m.startsWith(ADD_PREFIX) || m.startsWith(DEL_PREFIX) || m.startsWith(UPD_PREFIX)) break;
      raw.push(m);
      j += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
    const lineNo = (k: number): number => rawStart + k + 1;
    if (kind === 'add') {
      const addLines: string[] = [];
      for (let k = 0; k < raw.length; k += 1) {
        const m = raw[k]!;
        if (m === '') addLines.push('');
        else if (m[0] === '+') addLines.push(m.slice(1));
        else throw new Exit2(`error: parse ${lineNo(k)}`);
      }
      sections.push({ kind, path, moveTo: null, addLines, chunks: [] });
    } else if (kind === 'delete') {
      for (let k = 0; k < raw.length; k += 1) {
        if (!blank(raw[k]!)) throw new Exit2(`error: parse ${lineNo(k)}`);
      }
      sections.push({ kind, path, moveTo: null, addLines: [], chunks: [] });
    } else {
      let moveTo: string | null = null;
      const chunks: V4AChunk[] = [];
      let k = 0;
      if (raw.length > 0 && raw[0]!.startsWith(MOVE_PREFIX)) {
        moveTo = raw[0]!.slice(MOVE_PREFIX.length).trim();
        k = 1;
      }
      let cur: V4AChunk | null = null;
      let firstChunk = true;
      while (k < raw.length) {
        const m = raw[k]!;
        if (m.startsWith('@@')) {
          cur = { anchor: m.slice(2).trim(), body: [], eof: false };
          chunks.push(cur);
          firstChunk = false;
          k += 1;
          continue;
        }
        if (m === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${lineNo(k)}`);
          cur.eof = true;
          cur = null;
          k += 1;
          continue;
        }
        if (m === '' || m[0] === ' ' || m[0] === '-' || m[0] === '+') {
          if (cur === null) {
            if (!firstChunk) throw new Exit2(`error: parse ${lineNo(k)}`);
            cur = { anchor: null, body: [], eof: false };
            chunks.push(cur);
            firstChunk = false;
          }
          const noEol = false;
          if (m === '') cur.body.push({ kind: 'ctx', text: '', noEol });
          else if (m[0] === ' ') cur.body.push({ kind: 'ctx', text: m.slice(1), noEol });
          else if (m[0] === '-') cur.body.push({ kind: 'del', text: m.slice(1), noEol });
          else cur.body.push({ kind: 'add', text: m.slice(1), noEol });
          k += 1;
          continue;
        }
        throw new Exit2(`error: parse ${lineNo(k)}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
      sections.push({ kind, path, moveTo, addLines: [], chunks });
    }
    i = j;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  return parseV4A(lines).map((sec) => (tree: Tree) => {
    const p = sec.path;
    if (sec.kind === 'add') {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (!safe(p)) throw new Fail('unsafe', p);
    const newP = sec.moveTo;
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (newP !== null && newP !== p && tree.get(newP) !== null) throw new Fail('exists', newP);
    const model = parseFile(before);
    let cursor = 0;
    for (const chunk of sec.chunks) {
      if (chunk.anchor !== null) {
        const at = findAnchor(model.lines, chunk.anchor, cursor, strict);
        if (at < 0) throw new Fail('no-match', p);
        cursor = at + 1;
      }
      const { o, n } = splitBody(chunk.body);
      if (o.length === 0) {
        const at = chunk.eof ? model.lines.length : cursor;
        const ins = buildReplacement(n, null, null, 0, model.lines, at);
        model.lines.splice(at, 0, ...ins);
        cursor = at + ins.length;
        continue;
      }
      const found = findTierFrom(model.lines, o, cursor, strict, chunk.eof);
      if (found === null) throw new Fail('no-match', p);
      const at = found.pos[0]!;
      const repl = buildReplacement(n, o[0]!, model.lines[at]!, found.tier, model.lines, at);
      model.lines.splice(at, o.length, ...repl);
      cursor = at + repl.length;
    }
    const text = writeFile(model);
    if (newP === null || newP === p) {
      tree.now.set(p, text);
    } else {
      tree.now.set(p, null);
      tree.now.set(newP, text);
      tree.moves.push({ old: p, new: newP });
    }
  });
}

/* ------------------------------------------------------------------ JSON (SPEC 9) */

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

/* ------------------------------------------------------------------ driver */

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

function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
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
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
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
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const covered = new Set<string>();
  const rows: Array<{ key: string; text: string }> = [];
  for (const mv of tree.moves) {
    const oldWas = tree.original(mv.old);
    const oldNow = tree.get(mv.old);
    const newWas = tree.original(mv.new);
    const newNow = tree.get(mv.new);
    if (oldWas !== null && oldNow === null && newWas === null && newNow !== null) {
      rows.push({ key: mv.new, text: `R ${mv.old} -> ${mv.new}` });
      covered.add(mv.old);
      covered.add(mv.new);
    }
  }
  for (const p of [...tree.now.keys()].sort(byteCompare)) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteCompare(a.key, b.key));
  const out = rows.map((r) => r.text);
  if (!check) {
    for (const p of [...tree.now.keys()].sort(byteCompare)) {
      if (tree.now.get(p) === null) rmSync(p, { force: true });
    }
    for (const p of [...tree.now.keys()].sort(byteCompare)) {
      const v = tree.now.get(p)!;
      if (v === null) continue;
      try {
        if (statSync(p).isDirectory()) {
          // A file may take the place of a directory the patch emptied (a move
          // of a/b to a): remove the empty directory so the write below works.
          if (readdirSync(p).length === 0) rmdirSync(p);
        }
      } catch {
        // not there, or not a directory: writing below creates what is needed.
      }
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, v);
    }
  }
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
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
