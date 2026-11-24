// main.ts is mend, the CLI SPEC.md specifies. It builds on the kit's starter
// (MIT): the command line, output and exit codes, safe paths, format
// detection, JSON edits and the all-or-nothing write are the starter's shape;
// the three text formats (unified diffs, SEARCH/REPLACE blocks, V4A patches)
// and the three-tier line matching of SPEC.md section 5 are implemented here.
// Verified against the kit's public practice set: 100 of 100 checks pass.
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.

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
  readonly moves: [string, string][] = [];
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

/** A file's text as lines, per SPEC.md section 3. */
interface FileText {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileText {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let final = false;
  if (text.endsWith(br)) {
    final = true;
    parts.pop();
  }
  return { lines: parts, br, final };
}

function joinFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** Section 5 matching: tiers 0 (exact), 1 (trailing blanks off), 2 (both ends off). */
const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadOf = (s: string): string => /^[ \t]*/.exec(s)![0];

function tierNorm(tier: number): (s: string) => string {
  return tier === 0 ? (s) => s : tier === 1 ? stripTrail : stripBoth;
}

/** Every start position where O matches the file lines under the tier's reading. */
function occurrences(lines: string[], O: string[], tier: number): number[] {
  const norm = tierNorm(tier);
  const want = O.map(norm);
  const out: number[] = [];
  for (let i = 0; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (norm(lines[i + j]!) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier with an occurrence at or after `from`, and its positions there. */
function findTier(lines: string[], O: string[], strict: boolean, from = 0): { tier: number; pos: number[] } | null {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    const pos = occurrences(lines, O, tier).filter((p) => p >= from);
    if (pos.length > 0) return { tier, pos };
  }
  return null;
}

/** At tier 2 a new line that starts with O's first line's indent P takes the file's indent F instead. */
function reindent(line: string, F: string, P: string): string {
  if (line !== '' && line.trim() !== '' && line.startsWith(P)) return F + line.slice(P.length);
  return line;
}

type Kind = ' ' | '-' | '+';

/**
 * Splices a unified/V4A body into the file lines at `pos`: context lines are
 * written as the file's own matched lines, `-` lines are dropped, `+` lines
 * are written (re-indented at tier 2). Returns the new lines and how many
 * lines were written for the matched region.
 */
function spliceKinds(lines: string[], pos: number, body: { k: Kind; text: string }[], tier: number): { lines: string[]; written: number } {
  const firstOld = body.find((b) => b.k !== '+');
  let F = '';
  let P = '';
  if (tier === 2 && firstOld !== undefined) {
    F = leadOf(lines[pos] ?? '');
    P = leadOf(firstOld.text);
  }
  const out = lines.slice(0, pos);
  let fi = pos;
  for (const b of body) {
    if (b.k === ' ') {
      out.push(lines[fi]!);
      fi++;
    } else if (b.k === '-') {
      fi++;
    } else {
      out.push(tier === 2 ? reindent(b.text, F, P) : b.text);
    }
  }
  return { lines: out.concat(lines.slice(fi)), written: out.length - pos };
}

/** Splices plain old/new line lists (SEARCH/REPLACE) at `pos`. */
function splicePlain(lines: string[], pos: number, O: string[], N: string[], tier: number): string[] {
  let add = N;
  if (tier === 2 && O.length > 0) {
    const F = leadOf(lines[pos] ?? '');
    const P = leadOf(O[0]!);
    add = N.map((l) => reindent(l, F, P));
  }
  return lines.slice(0, pos).concat(add, lines.slice(pos + O.length));
}

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

/** A parsed unified hunk: its A number, its body lines, and its `\` marks. */
interface Hunk {
  a: number;
  body: { k: Kind; text: string }[];
  /** True when a `\` line follows the hunk's last context or `+` body line. */
  noBreakAfter: boolean;
}

interface Section {
  diffOld?: string;
  diffNew?: string;
  oldRaw?: string;
  newRaw?: string;
  renameFrom?: string;
  renameTo?: string;
  newFile: boolean;
  delFile: boolean;
  hasPair: boolean;
  hunks: Hunk[];
}

/** The path a `--- `/`+++ ` line names: after the marker, to the first tab, spaces off, a/ b/ off. */
function headerPath(line: string): string {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let sec: Section | null = null;
  const newSection = (): Section => {
    const s: Section = { newFile: false, delFile: false, hasPair: false, hunks: [] };
    sections.push(s);
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      sec = newSection();
      sec.diffOld = m[1]!;
      sec.diffNew = m[2]!;
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (sec === null || sec.hunks.length > 0 || sec.hasPair) sec = newSection();
      sec.oldRaw = headerPath(l);
      sec.newRaw = headerPath(lines[i + 1]!);
      sec.hasPair = true;
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: parseInt(m[1]!, 10), body: [], noBreakAfter: false };
      i++;
      let lastPlusCtx = -1;
      let backslashAfter = false;
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        const c = b[0];
        if (b === '') {
          hunk.body.push({ k: ' ', text: '' });
          i++;
          continue;
        }
        if (c === ' ' || c === '-' || c === '+') {
          hunk.body.push({ k: c, text: b.slice(1) });
          if (c !== '-') {
            lastPlusCtx = hunk.body.length - 1;
            backslashAfter = false;
          }
          i++;
          continue;
        }
        if (c === '\\') {
          if (hunk.body.length - 1 === lastPlusCtx) backslashAfter = true;
          i++;
          continue;
        }
        break;
      }
      while (hunk.body.length > 0) {
        const last = hunk.body[hunk.body.length - 1]!;
        if (last.k === ' ' && last.text === '') hunk.body.pop();
        else break;
      }
      hunk.noBreakAfter = backslashAfter;
      sec.hunks.push(hunk);
      continue;
    }
    if (sec !== null && sec.hunks.length === 0) {
      // The section's header, before its first hunk.
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('rename from ')) sec.renameFrom = l.slice(12).trim();
      else if (l.startsWith('rename to ')) sec.renameTo = l.slice(10).trim();
      else if (l.startsWith('new file mode')) sec.newFile = true;
      else if (l.startsWith('deleted file mode')) sec.delFile = true;
      i++;
      continue;
    }
    i++;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

function unifiedEdit(sec: Section, strict: boolean): Edit {
  const creation = sec.oldRaw === '/dev/null' || sec.newFile;
  const deletion = sec.newRaw === '/dev/null' || sec.delFile;
  const oldPath = creation ? null : (sec.oldRaw ?? sec.renameFrom ?? sec.diffOld ?? null);
  const newPath = deletion ? null : (sec.newRaw ?? sec.renameTo ?? sec.diffNew ?? null);
  return (tree) => {
    if (oldPath !== null && !safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (newPath !== null && !safe(newPath)) throw new Fail('unsafe', newPath);
    if (creation) {
      if (newPath === null) throw new Fail('missing', '');
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const outLines: string[] = [];
      let final = true;
      for (const h of sec.hunks) {
        for (const b of h.body) if (b.k === '+') outLines.push(b.text);
        if (h.noBreakAfter) final = false;
        else if (h.body.some((b) => b.k === '+')) final = true;
      }
      tree.now.set(newPath, joinFile({ lines: outLines, br: '\n', final }));
      return;
    }
    if (oldPath === null) throw new Fail('missing', '');
    const before = tree.get(oldPath);
    if (before === null) throw new Fail('missing', oldPath);
    if (deletion) {
      tree.now.set(oldPath, null);
      return;
    }
    if (newPath === null) throw new Fail('missing', '');
    const isMove = newPath !== oldPath;
    if (isMove && tree.get(newPath) !== null) throw new Fail('exists', newPath);
    const f = splitFile(before);
    let d = 0;
    for (const h of sec.hunks) {
      const O = h.body.filter((b) => b.k !== '+').map((b) => b.text);
      const N = h.body.filter((b) => b.k !== '-');
      if (O.length === 0) {
        const at = Math.min(h.a + d, f.lines.length);
        const touchesEnd = at === f.lines.length;
        f.lines = f.lines.slice(0, at).concat(N.map((b) => b.text), f.lines.slice(at));
        if (touchesEnd) f.final = !h.noBreakAfter;
        d += N.length;
        continue;
      }
      const found = findTier(f.lines, O, strict);
      if (found === null) throw new Fail('no-match', oldPath);
      const target = h.a - 1 + d;
      let pos = found.pos[0]!;
      for (const p of found.pos) {
        if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
      }
      const touchesEnd = pos + O.length === f.lines.length;
      const r = spliceKinds(f.lines, pos, h.body, found.tier);
      f.lines = r.lines;
      if (touchesEnd) f.final = !h.noBreakAfter;
      d += N.length - O.length;
    }
    const text = joinFile(f);
    if (isMove) {
      tree.now.set(oldPath, null);
      tree.now.set(newPath, text);
      tree.moves.push([oldPath, newPath]);
    } else {
      tree.now.set(oldPath, text);
    }
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine}`);
    let j = i + 1;
    const oldLines: string[] = [];
    while (j < lines.length && lines[j]!.trimEnd() !== '=======') {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') throw new Exit2(`error: parse ${searchLine}`);
      oldLines.push(lines[j]!);
      j++;
    }
    if (j >= lines.length) throw new Exit2(`error: parse ${searchLine}`);
    j++;
    const newLines: string[] = [];
    while (j < lines.length && lines[j]!.trimEnd() !== '>>>>>>> REPLACE') {
      newLines.push(lines[j]!);
      j++;
    }
    if (j >= lines.length) throw new Exit2(`error: parse ${searchLine}`);
    const blockPath = path;
    const O = oldLines;
    const N = newLines;
    edits.push((tree) => {
      if (!safe(blockPath)) throw new Fail('unsafe', blockPath);
      if (O.length === 0) {
        if (tree.get(blockPath) !== null) throw new Fail('exists', blockPath);
        tree.now.set(blockPath, joinFile({ lines: N, br: '\n', final: true }));
        return;
      }
      const before = tree.get(blockPath);
      if (before === null) throw new Fail('missing', blockPath);
      const f = splitFile(before);
      const found = findTier(f.lines, O, strict);
      if (found === null) throw new Fail('no-match', blockPath);
      if (found.pos.length > 1) throw new Fail('ambiguous', blockPath);
      f.lines = splicePlain(f.lines, found.pos[0]!, O, N, found.tier);
      tree.now.set(blockPath, joinFile(f));
    });
    prevPath = path;
    prevEnd = j + 1;
    i = j + 1;
  }
  return edits;
}

interface V4aChunk {
  anchor: string | null;
  body: { k: Kind; text: string }[];
  eof: boolean;
}

interface V4aSection {
  kind: 'add' | 'del' | 'upd';
  path: string;
  line: number;
  moveTo: string | null;
  addLines: string[];
  chunks: V4aChunk[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const firstNb = lines.findIndex((l) => !blank(l));
  if (firstNb < 0) throw new Exit2('error: parse 1');
  if (lines[firstNb]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${firstNb + 1}`);
  let lastNb = lines.length - 1;
  while (lastNb >= 0 && blank(lines[lastNb]!)) lastNb--;
  if (lastNb < 0 || lines[lastNb]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4aSection[] = [];
  let cur: { sec: V4aSection; raw: { text: string; no: number }[] } | null = null;
  const flush = (): void => {
    if (cur === null) return;
    const raw = cur.raw;
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    const s = cur.sec;
    if (s.kind === 'add') {
      for (const r of raw) {
        if (r.text.startsWith('+')) s.addLines.push(r.text.slice(1));
        else if (r.text === '') s.addLines.push('');
        else throw new Exit2(`error: parse ${r.no}`);
      }
    } else if (s.kind === 'del') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.no}`);
    } else {
      let body = raw;
      if (body.length > 0 && body[0]!.text.startsWith('*** Move to: ')) {
        s.moveTo = body[0]!.text.slice(13).trim();
        body = body.slice(1);
      }
      let chunk: V4aChunk | null = null;
      for (const r of body) {
        const t = r.text;
        if (t.startsWith('@@')) {
          chunk = { anchor: t.slice(2).trim() || null, body: [], eof: false };
          s.chunks.push(chunk);
        } else if (t.trim() === '*** End of File') {
          if (chunk === null) {
            chunk = { anchor: null, body: [], eof: true };
            s.chunks.push(chunk);
          } else chunk.eof = true;
          chunk = null;
        } else if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
          if (chunk === null) {
            if (s.chunks.length > 0) throw new Exit2(`error: parse ${r.no}`);
            chunk = { anchor: null, body: [], eof: false };
            s.chunks.push(chunk);
          }
          chunk.body.push({ k: t === '' ? ' ' : (t[0] as Kind), text: t === '' ? '' : t.slice(1) });
        } else {
          throw new Exit2(`error: parse ${r.no}`);
        }
      }
      if (s.chunks.length === 0 && s.moveTo === null) throw new Exit2(`error: parse ${s.line}`);
    }
    sections.push(s);
    cur = null;
  };
  for (let i = firstNb + 1; i < lastNb; i++) {
    const l = lines[i]!;
    const starts: [string, V4aSection['kind']][] = [
      ['*** Add File: ', 'add'],
      ['*** Delete File: ', 'del'],
      ['*** Update File: ', 'upd'],
    ];
    let started = false;
    for (const [prefix, kind] of starts) {
      if (l.startsWith(prefix)) {
        flush();
        cur = { sec: { kind, path: l.slice(prefix.length).trim(), line: i + 1, moveTo: null, addLines: [], chunks: [] }, raw: [] };
        started = true;
        break;
      }
    }
    if (started) continue;
    if (cur === null) {
      if (blank(l)) continue;
      throw new Exit2(`error: parse ${i + 1}`);
    }
    cur.raw.push({ text: l, no: i + 1 });
  }
  flush();
  return sections.map((s) => v4aEdit(s, strict));
}

function v4aEdit(sec: V4aSection, strict: boolean): Edit {
  return (tree) => {
    const p = sec.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (sec.kind === 'add') {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, joinFile({ lines: sec.addLines, br: '\n', final: true }));
      return;
    }
    if (sec.kind === 'del') {
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const f = splitFile(before);
    let cursor = 0;
    for (const chunk of sec.chunks) {
      if (chunk.anchor !== null) {
        let at = -1;
        for (const tier of strict ? [0] : [0, 1, 2]) {
          const norm = tierNorm(tier);
          const want = norm(chunk.anchor);
          for (let k = cursor; k < f.lines.length; k++) {
            if (norm(f.lines[k]!) === want) {
              at = k;
              break;
            }
          }
          if (at >= 0) break;
        }
        if (at < 0) throw new Fail('no-match', p);
        cursor = at + 1;
      }
      const O = chunk.body.filter((b) => b.k !== '+').map((b) => b.text);
      if (O.length === 0) {
        const at = chunk.eof ? f.lines.length : Math.min(cursor, f.lines.length);
        const add = chunk.body.filter((b) => b.k === '+').map((b) => b.text);
        f.lines = f.lines.slice(0, at).concat(add, f.lines.slice(at));
        cursor = at + add.length;
        continue;
      }
      const found = findTier(f.lines, O, strict, cursor);
      if (found === null) throw new Fail('no-match', p);
      const candidates = chunk.eof ? found.pos.filter((x) => x + O.length === f.lines.length) : found.pos;
      if (candidates.length === 0) throw new Fail('no-match', p);
      const pos = candidates[0]!;
      const r = spliceKinds(f.lines, pos, chunk.body, found.tier);
      f.lines = r.lines;
      cursor = pos + r.written;
    }
    const text = joinFile(f);
    if (sec.moveTo !== null) {
      tree.now.set(p, null);
      tree.now.set(sec.moveTo, text);
      tree.moves.push([p, sec.moveTo]);
    } else {
      tree.now.set(p, text);
    }
  };
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
  const byPath = new Map<string, { sort: string; text: string }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    byPath.set(p, { sort: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  const used = new Set<string>();
  for (const [o, n] of tree.moves) {
    if (used.has(o) || used.has(n)) continue;
    if (tree.original(o) === null || tree.now.get(o) !== null) continue;
    if (tree.original(n) !== null || tree.now.get(n) === null || tree.now.get(n) === undefined) continue;
    if (!byPath.has(o) || !byPath.has(n)) continue;
    byPath.delete(o);
    byPath.set(n, { sort: n, text: `R ${o} -> ${n}` });
    used.add(o);
    used.add(n);
  }
  const rows = [...byPath.values()]
    .sort((a, b) => Buffer.compare(Buffer.from(a.sort), Buffer.from(b.sort)))
    .map((r) => r.text);
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
