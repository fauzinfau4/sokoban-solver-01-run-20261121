// Sokoban solver: push-optimal per room.
//
// Idea (from first principles, standard Sokoban search): the generator builds each level as a
// hallway with independent rooms off it, and a box pushed out of a room can never come back, so a
// level's push-optimum is the sum of its rooms' optima. This program therefore splits a level into
// its rooms, solves every room push-optimally on its own, and stitches the rooms together with
// hallway walks. A room is solved with A* over pushes: a state is the boxes' squares plus the
// player's reachable region (named by its lowest square), the cost is pushes made, the heuristic is
// the minimum-matching sum of walking distances from boxes to goals (admissible: one push moves one
// box one square, so it can shrink that sum by at most one), and two deadlocks are pruned: a box on
// a dead square (no pull path from any goal reaches it) and a frozen 2x2 block of walls and boxes
// holding a box off its goal. Search is budgeted by states expanded, never by the wall clock, so
// two executions write the same bytes.
//
// Original code written for this competition. No dependencies, no network, no clock, no randomness.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Four directions: dx, dy, move letter. Index order is the tie-break order everywhere.
const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const LETTER = ['u', 'd', 'l', 'r'];

/** A board: width, height, walls (1 = wall), total squares. */
type Board = { w: number; h: number; wall: Uint8Array; size: number };

/** A parsed XSB level. */
type Level = Board & { goals: number[]; boxes: number[]; player: number };

/** Parse level.txt in XSB. Short rows pad as walls, like the checker. */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const size = w * h;
  const wall = new Uint8Array(size).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  return { w, h, wall, size, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/** The hallway row: the row the player starts on (the generator puts the player on the hallway). */
function hallwayRow(b: Board, player: number): number {
  return Math.floor(player / b.w);
}

/** One room: its boxes and its goals. */
type Room = { boxes: number[]; goals: number[] };

/**
 * Split a level into rooms: flood-fill the floor with the hallway row blocked; every component
 * holding boxes is a room. Null when the level is not a set of rooms (a box or goal in the hallway,
 * or a room whose boxes and goals do not match).
 */
function roomsOf(level: Level, hall: number): Room[] | null {
  const { w, wall, size } = level;
  const comp = new Int32Array(size).fill(-1);
  const rooms: Room[] = [];
  const stack: number[] = [];
  for (let s = 0; s < size; s++) {
    if (wall[s] || Math.floor(s / w) === hall || comp[s] >= 0) continue;
    const id = rooms.length;
    rooms.push({ boxes: [], goals: [] });
    comp[s] = id;
    stack.length = 0;
    stack.push(s);
    while (stack.length > 0) {
      const p = stack.pop()!;
      for (let k = 0; k < 4; k++) {
        const q = p + DY[k] * w + DX[k];
        if (!wall[q] && Math.floor(q / w) !== hall && comp[q] < 0) {
          comp[q] = id;
          stack.push(q);
        }
      }
    }
  }
  for (const b of level.boxes) {
    const r = comp[b];
    if (r < 0) return null;
    rooms[r]!.boxes.push(b);
  }
  for (const g of level.goals) {
    const r = comp[g];
    if (r < 0) return null;
    rooms[r]!.goals.push(g);
  }
  const kept = rooms.filter((r) => r.boxes.length > 0);
  if (kept.some((r) => r.boxes.length !== r.goals.length)) return null;
  return kept;
}

/**
 * The squares from which a box can still reach some goal by pushes, ignoring the other boxes:
 * reverse-pull breadth-first search from the goals. A box on any other square is dead.
 */
function liveSquares(b: Board, goals: number[]): Uint8Array {
  const live = new Uint8Array(b.size);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (let k = 0; k < 4; k++) {
      const d = DY[k] * b.w + DX[k];
      const y = x - d;
      if (!b.wall[y] && !b.wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/** Walking distances from one goal to every square, over floor only (boxes ignored). */
function distFrom(b: Board, goal: number): Int32Array {
  const dist = new Int32Array(b.size).fill(-1);
  const queue = [goal];
  dist[goal] = 0;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    for (let k = 0; k < 4; k++) {
      const q = p + DY[k] * b.w + DX[k];
      if (!b.wall[q] && dist[q] < 0) {
        dist[q] = dist[p]! + 1;
        queue.push(q);
      }
    }
  }
  return dist;
}

/** All permutations of 0..n-1, for the minimum-matching heuristic. */
function permutations(n: number): number[][] {
  const out: number[][] = [];
  const cur: number[] = [];
  const used = new Array<boolean>(n).fill(false);
  const rec = (): void => {
    if (cur.length === n) { out.push([...cur]); return; }
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      used[i] = true;
      cur.push(i);
      rec();
      cur.pop();
      used[i] = false;
    }
  };
  rec();
  return out;
}

/** Result of a push search: pushes made and the moves (lowercase LURD). */
type Solved = { pushes: number; moves: string };

/**
 * Push-optimal solve of one (sub-)level by A* over pushes, or null when the state cap runs out.
 * `hall` is the hallway row: a solved state only counts when the player can still walk out to it.
 * `heuristic` picks A* (minimum matching) or plain breadth-first search (heuristic 0).
 */
function solvePush(
  b: Board,
  boxes0: number[],
  goals: number[],
  player0: number,
  hall: number,
  maxExpand: number,
  heuristic: boolean,
): Solved | null {
  const { w, size } = b;
  const n = boxes0.length;
  if (n === 0) return { pushes: 0, moves: '' };
  const goalSet = new Uint8Array(size);
  for (const g of goals) goalSet[g] = 1;
  const live = liveSquares(b, goals);
  for (const box of boxes0) if (!live[box]) return null;

  const dists = goals.map((g) => distFrom(b, g));
  const perms = permutations(n);
  const pow = Math.pow(size, n);

  // Encode sorted boxes as one number, base `size`. Decode by repeated mod/div.
  const encode = (bs: number[]): number => {
    let k = 0;
    for (let i = 0; i < n; i++) k = k * size + bs[i]!;
    return k;
  };
  const decode = (k: number, out: number[]): void => {
    for (let i = n - 1; i >= 0; i--) {
      out[i] = k % size;
      k = Math.floor(k / size);
    }
  };

  // Minimum-matching heuristic, cached per box configuration (it ignores the player).
  const hCache = new Map<number, number>();
  const heuristicOf = (bs: number[]): number => {
    const key = encode(bs);
    const cached = hCache.get(key);
    if (cached !== undefined) return cached;
    let best = Infinity;
    for (const perm of perms) {
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const d = dists[perm[i]!]![bs[i]!]!;
        if (d < 0) { sum = Infinity; break; }
        sum += d;
      }
      if (sum < best) best = sum;
    }
    hCache.set(key, best);
    return best;
  };

  // Scratch: occupancy, region marks (stamp per fill), a second stamp array for the expanding
  // state's own region (region() below stamps `seen`, so it must not share it), region stack.
  const occ = new Uint8Array(size);
  const seen = new Int32Array(size);
  const seenP = new Int32Array(size);
  const stack = new Int32Array(size);
  const bsBuf = new Array<number>(n);
  const bs2 = new Array<number>(n);
  let stamp = 0;
  let stampP = 0;

  /** Flood the player's region from `from` around walls and boxes; returns [lowest, touchesHall]. */
  const region = (from: number): [number, boolean] => {
    const mark = ++stamp;
    let low = from;
    let touch = Math.floor(from / w) === hall;
    let sp = 0;
    stack[sp++] = from;
    seen[from] = mark;
    while (sp > 0) {
      const p = stack[--sp]!;
      if (p < low) low = p;
      if (Math.floor(p / w) === hall) touch = true;
      for (let k = 0; k < 4; k++) {
        const q = p + DY[k] * w + DX[k];
        if (!b.wall[q] && !occ[q] && seen[q] !== mark) {
          seen[q] = mark;
          stack[sp++] = q;
        }
      }
    }
    return [low, touch];
  };

  /** Whether the box just pushed to `t` sits in a frozen 2x2 block holding a box off its goal. */
  const frozenAt = (t: number): boolean => {
    for (const a of [t, t - 1, t - w, t - w - 1]) {
      const c1 = a + 1;
      const c2 = a + w;
      const c3 = c2 + 1;
      if (!(b.wall[a] || occ[a]) || !(b.wall[c1] || occ[c1]) || !(b.wall[c2] || occ[c2]) || !(b.wall[c3] || occ[c3])) continue;
      if ((occ[a] && !goalSet[a]) || (occ[c1] && !goalSet[c1]) || (occ[c2] && !goalSet[c2]) || (occ[c3] && !goalSet[c3])) return true;
    }
    return false;
  };

  // State storage, in parallel arrays. A state's key is (regionLow, boxes) folded into one number.
  const stBoxes: number[] = [];
  const stPlayer: number[] = [];
  const stLow: number[] = [];
  const stParent: number[] = [];
  const stFrom: number[] = [];
  const stDir: number[] = [];
  const stG: number[] = [];
  const stF: number[] = [];
  const stTouch: number[] = [];
  const closed = new Map<number, number>();

  const startBoxes = [...boxes0].sort((a, b2) => a - b2);
  for (const box of startBoxes) occ[box] = 1;
  const [startLow, startTouch] = region(player0);
  for (const box of startBoxes) occ[box] = 0;
  const h0 = heuristic ? heuristicOf(startBoxes) : 0;
  if (h0 === Infinity) return null;
  stBoxes.push(encode(startBoxes));
  stPlayer.push(player0);
  stLow.push(startLow);
  stParent.push(-1);
  stFrom.push(-1);
  stDir.push(-1);
  stG.push(0);
  stF.push(h0);
  stTouch.push(startTouch ? 1 : 0);
  closed.set(startLow * pow + stBoxes[0]!, 0);

  // Binary heap of state ids, ordered by (f asc, g desc, id asc): deterministic ties.
  const heap: number[] = [0];
  const heapLess = (a: number, b: number): boolean =>
    stF[a]! < stF[b]! || (stF[a]! === stF[b]! && (stG[a]! > stG[b]! || (stG[a]! === stG[b]! && a < b)));
  const heapPush = (id: number): void => {
    let i = heap.length;
    heap.push(id);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!heapLess(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): number => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && heapLess(heap[c + 1]!, heap[c]!)) c++;
        if (!heapLess(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };

  const solved = (bs: number[]): boolean => {
    for (let i = 0; i < n; i++) if (!goalSet[bs[i]!]!) return false;
    return true;
  };

  let expanded = 0;
  let found = -1;
  while (heap.length > 0) {
    const s = heapPop();
    // Skip a stale heap entry: the same position was later reached with fewer pushes.
    if (closed.get(stLow[s]! * pow + stBoxes[s]!) !== s) continue;
    decode(stBoxes[s]!, bsBuf);
    if (solved(bsBuf) && stTouch[s]!) { found = s; break; }
    if (expanded >= maxExpand) break;
    expanded++;
    for (const box of bsBuf) occ[box] = 1;
    const hereMark = ++stampP;
    // Mark this state's region once, so every push can test whether its square is reachable.
    {
      let sp = 0;
      stack[sp++] = stPlayer[s]!;
      seenP[stPlayer[s]!] = hereMark;
      while (sp > 0) {
        const p = stack[--sp]!;
        for (let k = 0; k < 4; k++) {
          const q = p + DY[k] * w + DX[k];
          if (!b.wall[q] && !occ[q] && seenP[q] !== hereMark) {
            seenP[q] = hereMark;
            stack[sp++] = q;
          }
        }
      }
    }
    for (let bi = 0; bi < n && found < 0; bi++) {
      const from = bsBuf[bi]!;
      for (let k = 0; k < 4; k++) {
        const d = DY[k] * w + DX[k];
        const to = from + d;
        const behind = from - d;
        if (b.wall[to] || occ[to] || !live[to]) continue;
        if (seenP[behind] !== hereMark) continue;
        occ[from] = 0;
        occ[to] = 1;
        if (frozenAt(to)) {
          occ[to] = 0;
          occ[from] = 1;
          continue;
        }
        for (let i = 0; i < n; i++) bs2[i] = bsBuf[i]!;
        bs2[bi] = to;
        bs2.sort((a, b2) => a - b2);
        const h2 = heuristic ? heuristicOf(bs2) : 0;
        const [low2, touch2] = region(from);
        occ[to] = 0;
        occ[from] = 1;
        if (h2 === Infinity) continue;
        const g2 = stG[s]! + 1;
        const key2 = low2 * pow + encode(bs2);
        const prev = closed.get(key2);
        if (prev !== undefined && stG[prev]! <= g2) continue;
        const id = stBoxes.length;
        stBoxes.push(encode(bs2));
        stPlayer.push(from);
        stLow.push(low2);
        stParent.push(s);
        stFrom.push(from);
        stDir.push(k);
        stG.push(g2);
        stF.push(g2 + h2);
        stTouch.push(touch2 ? 1 : 0);
        closed.set(key2, id);
        heapPush(id);
      }
    }
    for (const box of bsBuf) occ[box] = 0;
  }
  if (found < 0) return null;

  // Rebuild the moves: walk to each push's square, then push (lowercase; the checker replays it).
  const pushes: { from: number; dir: number }[] = [];
  for (let s = found; s > 0; s = stParent[s]!) pushes.push({ from: stFrom[s]!, dir: stDir[s]! });
  pushes.reverse();
  let moves = '';
  let player = player0;
  const cur = [...startBoxes];
  const walk = (from: number, to: number): string => {
    if (from === to) return '';
    const prev = new Int32Array(size).fill(-1);
    const how = new Array<string>(size);
    const queue = [from];
    prev[from] = from;
    for (let qi = 0; qi < queue.length; qi++) {
      const p = queue[qi]!;
      if (p === to) break;
      for (let k = 0; k < 4; k++) {
        const q = p + DY[k] * w + DX[k];
        if (b.wall[q] || occ[q] || prev[q] !== -1) continue;
        prev[q] = p;
        how[q] = LETTER[k]!;
        queue.push(q);
      }
    }
    if (prev[to] === -1) throw new Error('walk: push square out of reach');
    let out = '';
    for (let p = to; p !== from; p = prev[p]!) out = how[p]! + out;
    return out;
  };
  for (const { from, dir } of pushes) {
    for (const box of cur) occ[box] = 1;
    const d = DY[dir]! * w + DX[dir]!;
    moves += walk(player, from - d);
    for (const box of cur) occ[box] = 0;
    moves += LETTER[dir]!;
    const at = cur.indexOf(from);
    cur[at] = from + d;
    cur.sort((a, b2) => a - b2);
    player = from;
  }
  return { pushes: pushes.length, moves };
}

/** The square the player stands on after playing `moves` from `from`. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

/** Solve one level: room by room, with whole-level fallbacks. Returns the moves. */
function solveLevel(text: string): string {
  const level = parseLevel(text);
  if (level.boxes.length === 0) return '';
  const hall = hallwayRow(level, level.player);
  const rooms = hall >= 0 ? roomsOf(level, hall) : null;
  if (rooms !== null && hall >= 0) {
    let moves = '';
    let player = level.player;
    const done = new Array<boolean>(rooms.length).fill(false);
    for (let ri = 0; ri < rooms.length; ri++) {
      const room = rooms[ri]!;
      const wall = level.wall.slice();
      for (let oj = 0; oj < rooms.length; oj++) {
        if (oj === ri) continue;
        // A room already solved has its boxes standing on its goals; one not yet solved still
        // has them where they started. Either way they are walls to this room's search.
        for (const b of done[oj]! ? rooms[oj]!.goals : rooms[oj]!.boxes) wall[b] = 1;
      }
      const sub: Board = { w: level.w, h: level.h, wall, size: level.size };
      let res = solvePush(sub, room.boxes, room.goals, player, hall, 250_000, true);
      if (res === null) res = solvePush(sub, room.boxes, room.goals, player, hall, 1_000_000, false);
      if (res === null) return '';
      moves += res.moves;
      player = endOf(level.w, player, res.moves);
      done[ri] = true;
    }
    return moves;
  }
  // No rooms found: try the whole level at once (small levels only, in practice).
  const res = solvePush(level, level.boxes, level.goals, level.player, hall, 200_000, true);
  return res === null ? '' : res.moves;
}

for (const id of readdirSync(I).sort()) {
  const moves = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
