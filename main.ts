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
  readonly moves = new Map<string, string>();
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
  setFile(p: string, v: string | null): void {
    if (v === null) {
      if (this.moves.has(p)) this.moves.delete(p);
    } else {
      for (const [nw, org] of [...this.moves.entries()]) if (org === p) this.moves.delete(nw);
    }
    this.now.set(p, v);
  }
  recordMove(oldP: string, newP: string, content: string): void {
    let origin = oldP;
    if (this.moves.has(oldP)) {
      origin = this.moves.get(oldP)!;
      this.moves.delete(oldP);
    }
    this.moves.set(newP, origin);
    this.now.set(oldP, null);
    this.now.set(newP, content);
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

/* ---- section 5: line matching, and file line handling (section 3) ---- */

function splitFile(text: string): { lines: string[]; br: string; final: boolean } {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

function leading(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function findOccurrences(o: string[], f: string[], tier: number): number[] {
  const occ: number[] = [];
  if (o.length === 0 || o.length > f.length) return occ;
  for (let i = 0; i + o.length <= f.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normLine(o[j]!, tier) !== normLine(f[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) occ.push(i);
  }
  return occ;
}

function findTier(o: string[], f: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = findOccurrences(o, f, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

interface BodyOp {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  noNL: boolean;
}

function replacementFromOps(ops: BodyOp[], oTexts: string[], fileLines: string[], pos: number, tier: number): string[] {
  const out: string[] = [];
  let oIdx = 0;
  const ctxMap = new Map<number, number>();
  ops.forEach((op, idx) => {
    if (op.kind === 'ctx' || op.kind === 'old') {
      ctxMap.set(idx, oIdx);
      oIdx++;
    }
  });
  const p = tier === 2 && oTexts.length > 0 ? leading(oTexts[0]!) : '';
  const fl = tier === 2 && fileLines.length > pos ? leading(fileLines[pos]!) : '';
  ops.forEach((op, idx) => {
    if (op.kind === 'ctx') {
      out.push(fileLines[pos + ctxMap.get(idx)!]!);
    } else if (op.kind === 'new') {
      if (tier === 2) {
        if (op.text === '' || /^[ \t]*$/.test(op.text)) out.push(op.text);
        else if (op.text.startsWith(p)) out.push(fl + op.text.slice(p.length));
        else out.push(op.text);
      } else {
        out.push(op.text);
      }
    }
  });
  return out;
}

function reindentLines(newLines: string[], oTexts: string[], fileLines: string[], pos: number, tier: number): string[] {
  if (tier !== 2) return [...newLines];
  const p = leading(oTexts[0]!);
  const fl = leading(fileLines[pos]!);
  return newLines.map((l) => {
    if (l === '' || /^[ \t]*$/.test(l)) return l;
    if (l.startsWith(p)) return fl + l.slice(p.length);
    return l;
  });
}

function lastCtxPlus(ops: BodyOp[]): BodyOp | undefined {
  for (let k = ops.length - 1; k >= 0; k--) {
    if (ops[k]!.kind === 'ctx' || ops[k]!.kind === 'new') return ops[k]!;
  }
  return undefined;
}

interface Hunk {
  A: number;
  items: BodyOp[];
}

function applyHunks(origLines: string[], origFinal: boolean, hunks: Hunk[], strict: boolean, path: string): { lines: string[]; final: boolean } {
  let lines = [...origLines];
  let final = origFinal;
  let d = 0;
  for (const h of hunks) {
    const ops = h.items;
    const oTexts: string[] = [];
    for (const op of ops) if (op.kind === 'ctx' || op.kind === 'old') oTexts.push(op.text);
    if (oTexts.length === 0) {
      const nTexts = ops.filter((o) => o.kind === 'new').map((o) => o.text);
      const insertPos = Math.min(h.A + d, lines.length);
      const atEnd = insertPos === lines.length;
      if (atEnd && nTexts.length > 0) {
        const lastNew = [...ops].reverse().find((o) => o.kind === 'new');
        final = lastNew ? !lastNew.noNL : true;
      }
      lines.splice(insertPos, 0, ...nTexts);
      d += nTexts.length;
      continue;
    }
    const found = findTier(oTexts, lines, strict);
    if (!found) throw new Fail('no-match', path);
    const target = h.A - 1 + d;
    let best = found.occ[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.occ) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const pos = best;
    const replacement = replacementFromOps(ops, oTexts, lines, pos, found.tier);
    const atEnd = pos + oTexts.length === lines.length;
    if (atEnd) {
      const last = lastCtxPlus(ops);
      final = last ? !last.noNL : true;
    }
    lines.splice(pos, oTexts.length, ...replacement);
    d += replacement.length - oTexts.length;
  }
  return { lines, final };
}

/* ---- section 6: unified diffs ---- */

function parseUnifiedPath(line: string): string | null {
  let rest = line.slice(4);
  const tab = rest.indexOf('\t');
  if (tab >= 0) rest = rest.slice(0, tab);
  rest = rest.trim();
  if (rest === '/dev/null') return null;
  if (rest.startsWith('a/') || rest.startsWith('b/')) rest = rest.slice(2);
  return rest;
}

interface UnifiedBuilder {
  diffOld: string | null;
  diffNew: string | null;
  dashOld: string | null | undefined;
  dashNew: string | null | undefined;
  hasDash: boolean;
  renameOld: string | undefined;
  renameNew: string | undefined;
  isNew: boolean;
  isDeleted: boolean;
  hunks: Hunk[];
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const builders: UnifiedBuilder[] = [];
  let builder: UnifiedBuilder | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (!m || m[1]!.trim() === '' || m[2]!.trim() === '') throw new Exit2(`error: parse ${i + 1}`);
      builder = { diffOld: m[1]!.trim(), diffNew: m[2]!.trim(), dashOld: undefined, dashNew: undefined, hasDash: false, renameOld: undefined, renameNew: undefined, isNew: false, isDeleted: false, hunks: [] };
      builders.push(builder);
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (builder !== null && builder.hunks.length === 0 && !builder.hasDash) {
        builder.dashOld = parseUnifiedPath(line);
        builder.dashNew = parseUnifiedPath(lines[i + 1]!);
        builder.hasDash = true;
        i += 2;
        continue;
      }
      builder = { diffOld: null, diffNew: null, dashOld: parseUnifiedPath(line), dashNew: parseUnifiedPath(lines[i + 1]!), hasDash: true, renameOld: undefined, renameNew: undefined, isNew: false, isDeleted: false, hunks: [] };
      builders.push(builder);
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (builder === null) throw new Exit2(`error: parse ${i + 1}`);
      const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@.*$/.exec(line);
      if (!hm) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseInt(hm[1]!, 10);
      i++;
      const items: BodyOp[] = [];
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '') {
          items.push({ kind: 'ctx', text: '', noNL: false });
          i++;
          continue;
        }
        const c = bl[0]!;
        if (c === ' ' || c === '-' || c === '+') {
          items.push({ kind: c === ' ' ? 'ctx' : c === '-' ? 'old' : 'new', text: bl.slice(1), noNL: false });
          i++;
          continue;
        }
        if (c === '\\') {
          if (items.length > 0) items[items.length - 1]!.noNL = true;
          i++;
          continue;
        }
        break;
      }
      while (items.length > 0) {
        const last = items[items.length - 1]!;
        if (last.kind === 'ctx' && last.text === '') items.pop();
        else break;
      }
      builder.hunks.push({ A: a, items });
      continue;
    }
    if (builder !== null && builder.hunks.length === 0) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) {
        builder.renameOld = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        builder.renameNew = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        builder.isNew = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        builder.isDeleted = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  const edits: Edit[] = [];
  for (const b of builders) {
    let oldP: string | null;
    let newP: string | null;
    if (b.hasDash) {
      oldP = b.dashOld ?? null;
      newP = b.dashNew ?? null;
    } else if (b.renameOld !== undefined || b.renameNew !== undefined) {
      oldP = b.renameOld ?? b.diffOld;
      newP = b.renameNew ?? b.diffNew;
    } else {
      oldP = b.diffOld;
      newP = b.diffNew;
    }
    const hunks = b.hunks;
    const isNew = b.isNew;
    const isDeleted = b.isDeleted;
    edits.push((tree) => {
      if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
      if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
      const isCreate = oldP === null || isNew;
      const isDelete = newP === null || isDeleted;
      if (isCreate && isDelete) return;
      if (isCreate) {
        if (newP === null) return;
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const plus: string[] = [];
        let lastPlus: BodyOp | undefined;
        for (const h of hunks) for (const it of h.items) if (it.kind === 'new') {
          plus.push(it.text);
          lastPlus = it;
        }
        const text = plus.length === 0 ? '' : plus.join('\n') + (lastPlus && lastPlus.noNL ? '' : '\n');
        tree.setFile(newP, text);
        return;
      }
      if (isDelete) {
        if (oldP === null) return;
        if (tree.get(oldP) === null) throw new Fail('missing', oldP);
        tree.setFile(oldP, null);
        return;
      }
      if (oldP === null || newP === null) return;
      if (oldP !== newP) {
        if (tree.get(oldP) === null) throw new Fail('missing', oldP);
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const sf = splitFile(tree.get(oldP)!);
        const res = applyHunks(sf.lines, sf.final, hunks, strict, oldP);
        tree.recordMove(oldP, newP, joinFile(res.lines, sf.br, res.final));
        return;
      }
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      const sf = splitFile(tree.get(oldP)!);
      const res = applyHunks(sf.lines, sf.final, hunks, strict, oldP);
      tree.setFile(oldP, joinFile(res.lines, sf.br, res.final));
    });
  }
  return edits;
}

/* ---- section 7: SEARCH/REPLACE blocks ---- */

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    const searchLineNo = i + 1;
    let sep = -1;
    let j = i + 1;
    while (j < lines.length) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        sep = j;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') throw new Exit2(`error: parse ${searchLineNo}`);
      j++;
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchLineNo}`);
    let end = -1;
    j = sep + 1;
    while (j < lines.length) {
      const t = lines[j]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
      if (t === '<<<<<<< SEARCH') throw new Exit2(`error: parse ${searchLineNo}`);
      j++;
    }
    if (end < 0) throw new Exit2(`error: parse ${searchLineNo}`);
    const oldLines = lines.slice(searchIdx + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    let path: string | null = null;
    for (let k = searchIdx - 1; k > prevEnd; k--) {
      const l = lines[k]!;
      if (blank(l)) continue;
      const trimmed = l.trim();
      if (trimmed.startsWith('```')) continue;
      path = trimmed;
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${searchLineNo}`);
    }
    prevPath = path;
    prevEnd = end;
    const oldCopy = [...oldLines];
    const newCopy = [...newLines];
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldCopy.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.setFile(p, newCopy.length === 0 ? '' : newCopy.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const sf = splitFile(before);
      const found = findTier(oldCopy, sf.lines, strict);
      if (!found) throw new Fail('no-match', p);
      if (found.occ.length !== 1) throw new Fail('ambiguous', p);
      const pos = found.occ[0]!;
      const replacement = reindentLines(newCopy, oldCopy, sf.lines, pos, found.tier);
      const outLines = [...sf.lines.slice(0, pos), ...replacement, ...sf.lines.slice(pos + oldCopy.length)];
      tree.setFile(p, joinFile(outLines, sf.br, sf.final));
    });
    i = end + 1;
  }
  return edits;
}

/* ---- section 8: V4A patches ---- */

interface VChunk {
  anchor: string | null;
  ops: BodyOp[];
  eof: boolean;
}

interface VSec {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  chunks: VChunk[];
  addLines: string[];
  headerLine: number;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const firstIdx = lines.findIndex((l) => !blank(l));
  if (firstIdx < 0) throw new Exit2('error: parse 1');
  if (lines[firstIdx]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${firstIdx + 1}`);
  let lastIdx = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      lastIdx = k;
      break;
    }
  }
  if (lines[lastIdx]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSec[] = [];
  let cur: VSec | null = null;
  let curChunk: VChunk | null = null;
  let chunkStarted = false;
  const trimChunk = (c: VChunk): void => {
    while (c.ops.length > 0) {
      const last = c.ops[c.ops.length - 1]!;
      if (last.kind === 'ctx' && last.text === '') c.ops.pop();
      else break;
    }
  };
  const endChunk = (): void => {
    if (curChunk) {
      trimChunk(curChunk);
      if (cur) cur.chunks.push(curChunk);
      curChunk = null;
    }
  };
  const endSection = (): void => {
    if (cur) {
      endChunk();
      if (cur.kind === 'add') {
        while (cur.addLines.length > 0 && cur.addLines[cur.addLines.length - 1] === '') cur.addLines.pop();
      }
      sections.push(cur);
      cur = null;
      chunkStarted = false;
    }
  };
  let i = firstIdx + 1;
  while (i < lastIdx) {
    const line = lines[i]!;
    const lineNo = i + 1;
    if (line.startsWith('*** Add File:')) {
      endSection();
      cur = { kind: 'add', path: line.slice('*** Add File:'.length).trim(), moveTo: null, chunks: [], addLines: [], headerLine: lineNo };
      i++;
      continue;
    }
    if (line.startsWith('*** Delete File:')) {
      endSection();
      cur = { kind: 'delete', path: line.slice('*** Delete File:'.length).trim(), moveTo: null, chunks: [], addLines: [], headerLine: lineNo };
      i++;
      continue;
    }
    if (line.startsWith('*** Update File:')) {
      endSection();
      cur = { kind: 'update', path: line.slice('*** Update File:'.length).trim(), moveTo: null, chunks: [], addLines: [], headerLine: lineNo };
      i++;
      continue;
    }
    if (cur === null) {
      if (blank(line)) {
        i++;
        continue;
      }
      throw new Exit2(`error: parse ${lineNo}`);
    }
    if (cur.kind === 'add') {
      if (line.startsWith('+')) {
        cur.addLines.push(line.slice(1));
        i++;
        continue;
      }
      if (line === '') {
        cur.addLines.push('');
        i++;
        continue;
      }
      throw new Exit2(`error: parse ${lineNo}`);
    }
    if (cur.kind === 'delete') {
      if (blank(line)) {
        i++;
        continue;
      }
      throw new Exit2(`error: parse ${lineNo}`);
    }
    // update
    if (line.startsWith('*** Move to:')) {
      if (cur.moveTo !== null || chunkStarted || curChunk !== null) throw new Exit2(`error: parse ${lineNo}`);
      cur.moveTo = line.slice('*** Move to:'.length).trim();
      i++;
      continue;
    }
    if (line.trim() === '*** End of File') {
      if (curChunk === null) throw new Exit2(`error: parse ${lineNo}`);
      curChunk.eof = true;
      endChunk();
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      endChunk();
      const anchorText = line.slice(2).trim();
      curChunk = { anchor: anchorText === '' ? null : anchorText, ops: [], eof: false };
      chunkStarted = true;
      i++;
      continue;
    }
    if (line === '') {
      if (curChunk !== null) {
        curChunk.ops.push({ kind: 'ctx', text: '', noNL: false });
        i++;
        continue;
      }
      i++;
      continue;
    }
    const c0 = line[0]!;
    if (c0 === ' ' || c0 === '-' || c0 === '+') {
      if (curChunk === null) {
        if (chunkStarted) throw new Exit2(`error: parse ${lineNo}`);
        curChunk = { anchor: null, ops: [], eof: false };
        chunkStarted = true;
      }
      curChunk.ops.push({ kind: c0 === ' ' ? 'ctx' : c0 === '-' ? 'old' : 'new', text: line.slice(1), noNL: false });
      i++;
      continue;
    }
    throw new Exit2(`error: parse ${lineNo}`);
  }
  endSection();
  for (const s of sections) {
    if (s.kind === 'update' && s.chunks.length === 0 && s.moveTo === null) throw new Exit2(`error: parse ${s.headerLine}`);
  }
  const edits: Edit[] = [];
  for (const s of sections) {
    const kind = s.kind;
    const p = s.path;
    const moveTo = s.moveTo;
    const addLines = [...s.addLines];
    const chunks = s.chunks;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (kind === 'add') {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.setFile(p, addLines.length === 0 ? '' : addLines.join('\n') + '\n');
        return;
      }
      if (kind === 'delete') {
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.setFile(p, null);
        return;
      }
      if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
      const sf = splitFile(before);
      let curLines = [...sf.lines];
      const curFinal = sf.final;
      let cursor = 0;
      for (const chunk of chunks) {
        if (chunk.anchor !== null) {
          const slice = curLines.slice(cursor);
          const foundA = findTier([chunk.anchor], slice, strict);
          if (!foundA) throw new Fail('no-match', p);
          cursor = cursor + foundA.occ[0]! + 1;
        }
        const ops = chunk.ops;
        const oTexts: string[] = [];
        for (const op of ops) if (op.kind === 'ctx' || op.kind === 'old') oTexts.push(op.text);
        if (oTexts.length === 0) {
          const nTexts = ops.filter((o) => o.kind === 'new').map((o) => o.text);
          const insertPos = chunk.eof ? curLines.length : cursor;
          curLines.splice(insertPos, 0, ...nTexts);
          cursor = insertPos + nTexts.length;
          continue;
        }
        const slice = curLines.slice(cursor);
        let tier: number;
        let pos: number;
        if (chunk.eof) {
          const tiers = strict ? [0] : [0, 1, 2];
          let foundTier: { tier: number; occ: number[] } | null = null;
          for (const t of tiers) {
            const occAll = findOccurrences(oTexts, slice, t);
            const filtered = occAll.filter((q) => cursor + q + oTexts.length === curLines.length);
            if (filtered.length > 0) {
              foundTier = { tier: t, occ: filtered };
              break;
            }
          }
          if (!foundTier) throw new Fail('no-match', p);
          tier = foundTier.tier;
          pos = cursor + foundTier.occ[0]!;
        } else {
          const found = findTier(oTexts, slice, strict);
          if (!found) throw new Fail('no-match', p);
          tier = found.tier;
          pos = cursor + found.occ[0]!;
        }
        const replacement = replacementFromOps(ops, oTexts, curLines, pos, tier);
        curLines.splice(pos, oTexts.length, ...replacement);
        cursor = pos + replacement.length;
      }
      const text = joinFile(curLines, sf.br, curFinal);
      if (moveTo !== null) tree.recordMove(p, moveTo, text);
      else tree.setFile(p, text);
    });
  }
  return edits;
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
    const beforeMoves = new Map(tree.moves);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.clear();
      for (const [k, v] of beforeMoves) tree.moves.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed: string[] = [];
  for (const p of tree.now.keys()) {
    if (tree.original(p) !== tree.now.get(p)) changed.push(p);
  }
  const rows: { key: string; text: string }[] = [];
  const usedR = new Set<string>();
  for (const [nw, org] of tree.moves) {
    if (tree.original(org) !== null && tree.get(org) === null && tree.original(nw) === null && tree.get(nw) !== null) {
      rows.push({ key: nw, text: `R ${org} -> ${nw}` });
      usedR.add(org);
      usedR.add(nw);
    }
  }
  for (const p of changed) {
    if (usedR.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rowTexts = rows.map((r) => r.text);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
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
  return { code: 0, out: [...rowTexts, `ok: ${rowTexts.length} ${rowTexts.length === 1 ? 'file' : 'files'}`] };
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
