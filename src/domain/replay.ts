/**
 * Reading a Pokémon Showdown replay (its battle log) into what each Pokémon did, turn by turn: switches, Mega
 * Evolution, moves and their targets, the chance results (misses, crits, flinches, conditions, full paralysis, sleep,
 * confusion...), HP after each hit and at the end of each turn, and the order things happened in. Turning that into
 * a gameplan branch is in replay-import.ts. Pure functions: no fetching here (see infra/replay.ts).
 */
import { baseSpecies } from './showdown.ts';

export type Player = 'p1' | 'p2';
export const PLAYERS: readonly Player[] = ['p1', 'p2'];

/** A Pokémon from an open team sheet (`|showteam|`): ids as Showdown packs them ("GarchompiteZ", "DracoMeteor"). */
export interface SheetMon { species: string; item: string; ability: string; moves: string[]; nature: string; gender: string; level: number | null }

/** Where a Pokémon stands: its player and slot ("a" left, "b" right). */
export interface Position { player: Player; slot: 'a' | 'b' }

export interface TargetResult { miss?: true; crit?: true; effects?: string[]; hp?: number }

/** One Pokémon's action in a turn, in the order it happened. `species` is the Pokémon (by species, not nickname). */
export interface ReplayAction {
  player: Player;
  slot: 'a' | 'b';
  species: string;
  kind: 'move' | 'switch';
  /** The move (empty when it couldn't move and the log doesn't name what it chose). */
  move: string;
  /** Single target's position and species, or `spread` with every position the move reached. */
  target?: Position;
  targetSpecies?: string;
  spread?: Position[];
  /** Switch: who came in. Pivot moves and forced switches: who came in afterwards. */
  switchTo?: string;
  mega?: true;
  cant?: 'par' | 'slp' | 'frz' | 'confusion' | 'flinch' | 'recharge';
  wake?: true;
  hits?: number;
  protectWorks?: true;
  targets: Record<string, TargetResult>;
  self?: string[];
  /** HP after it hurt itself in confusion (percent). */
  selfHp?: number;
}

export interface ReplayTurn {
  number: number;
  /** Who came in before the turn to replace a fainted Pokémon, by position. */
  replacements: (Position & { species: string })[];
  actions: ReplayAction[];
  /** Every known Pokémon's HP at the end of the turn, in percent, by player then species. */
  hpEnd: Record<Player, Record<string, number>>;
}

export interface ParsedReplay {
  format: string;
  players: Record<Player, string>;
  /** The six Pokémon each player registered (team preview), by species. */
  preview: Record<Player, string[]>;
  /** Open team sheets, when both players agreed to them. */
  sheets: Record<Player, SheetMon[] | null>;
  /** The two leads per player, in slot order (a, b). */
  leads: Record<Player, string[]>;
  /** Pokémon that came in later, in order of first appearance. */
  backs: Record<Player, string[]>;
  turns: ReplayTurn[];
  winner: Player | null;
  forfeit: Player | null;
}

export class ReplayError extends Error {
  override readonly name = 'ReplayError';
}

const parsePosition = (ident: string): (Position & { name: string }) | null => {
  const m = /^(p[12])([ab]): (.+)$/.exec(ident.trim());
  return m ? { player: m[1] as Player, slot: m[2] as 'a' | 'b', name: m[3]! } : null;
};
/** "Indeedee-F, L50, F" → "Indeedee-F". */
const speciesOf = (details: string): string => details.split(',')[0]!.trim();
/** "20/100r", "0 fnt", "63/100 par" → 20, 0, 63 (percent; spectators see percentages). */
const hpOf = (hp: string): number | null => {
  const m = /^(\d+(?:\.\d+)?)(?:\/(\d+))?/.exec(hp.trim());
  if (!m) return null;
  const now = Number(m[1]);
  const max = m[2] ? Number(m[2]) : 100;
  return max > 0 ? Math.round((now / max) * 1000) / 10 : null;
};
const tagged = (parts: readonly string[], tag: string): string | null => {
  const found = parts.find((p) => p.startsWith(`[${tag}]`));
  return found === undefined ? null : found.slice(tag.length + 2).trim();
};

/** "Garchomp||GarchompiteZ|RoughSkin|DracoMeteor,Flamethrower|Modest||F|||50|]Whimsicott||..." */
function parseSheet(packed: string): SheetMon[] {
  return packed.split(']').filter(Boolean).map((p) => {
    const f = p.split('|');
    return {
      species: (f[1] || f[0] || '').trim(), item: f[2] ?? '', ability: f[3] ?? '',
      moves: (f[4] ?? '').split(',').filter(Boolean), nature: f[5] ?? '', gender: f[7] ?? '',
      level: f[10] ? Number(f[10]) || null : null,
    };
  });
}

/** Status conditions and stat changes that some moves always cause: those come from the simulation, not the log. */
export interface KnownEffects { always: (move: string, effect: string) => boolean }

/**
 * Parses a battle log. `known.always(move, effect)` says whether a move always causes an effect (the simulation
 * applies those itself), so only chance effects are recorded.
 */
export function parseReplayLog(log: string, known: KnownEffects = { always: () => false }): ParsedReplay {
  const out: ParsedReplay = {
    format: '', players: { p1: '', p2: '' }, preview: { p1: [], p2: [] }, sheets: { p1: null, p2: null },
    leads: { p1: [], p2: [] }, backs: { p1: [], p2: [] }, turns: [], winner: null, forfeit: null,
  };
  if (!/\|gametype\|doubles/.test(log)) throw new ReplayError('This replay isn\'t a doubles battle.');

  const active: Record<string, string> = {};        // "p1a" -> species
  const nick: Record<string, string> = {};          // "p1:Indeedee" -> "Indeedee-F"
  const hp: Record<Player, Record<string, number>> = { p1: {}, p2: {} };
  const seen: Record<Player, Set<string>> = { p1: new Set(), p2: new Set() };
  const protectedLast: Record<string, boolean> = {}; // "p1:Species" -> its last action was a working Protect
  let started = false;
  let turn: ReplayTurn | null = null;
  let pending: ReplayTurn['replacements'] = [];
  let current: ReplayAction | null = null;           // the action whose effects are being read
  let afterUpkeep = false;
  let lastBoostSource = '';                          // an -ability / -enditem line just before a boost
  const megaPending: Record<string, true> = {};
  const forcedOut: Record<string, true> = {};        // positions sent out by Eject Button, Red Card, Emergency Exit...

  const speciesAt = (ident: string): string => {
    const pos = parsePosition(ident);
    if (!pos) return '';
    return active[`${pos.player}${pos.slot}`] ?? nick[`${pos.player}:${pos.name}`] ?? pos.name;
  };
  const enter = (pos: Position & { name: string }, species: string): void => {
    active[`${pos.player}${pos.slot}`] = species;
    nick[`${pos.player}:${pos.name}`] = species;
    // By base species: a Mega that switches out comes back in as "Garchomp-Mega-Z", still the same Pokémon.
    const base = baseSpecies(species);
    if (!seen[pos.player].has(base)) {
      seen[pos.player].add(base);
      if (started && !out.leads[pos.player].some((s) => baseSpecies(s) === base)) out.backs[pos.player].push(species);
    }
  };
  /** This turn's action of the Pokémon now standing at `pos`. */
  const actionOf = (pos: Position): ReplayAction | undefined => {
    const species = active[`${pos.player}${pos.slot}`];
    return turn?.actions.find((a) => a.player === pos.player && a.slot === pos.slot && a.species === species);
  };
  const newAction = (pos: Position, species: string, init: Partial<ReplayAction>): ReplayAction => {
    const a: ReplayAction = { player: pos.player, slot: pos.slot, species, kind: 'move', move: '', targets: {}, ...init };
    if (megaPending[`${pos.player}${pos.slot}`]) { a.mega = true; delete megaPending[`${pos.player}${pos.slot}`]; }
    turn!.actions.push(a);
    return a;
  };
  const target = (a: ReplayAction, species: string): TargetResult => (a.targets[species] ??= {});

  for (const raw of log.split('\n')) {
    const parts = raw.split('|');
    if (parts.length < 2) continue;
    const [, cmd = '', a1 = '', a2 = '', a3 = ''] = parts;
    const rest = parts.slice(2);
    const boostLine = cmd === '-boost' || cmd === '-unboost';
    if (!boostLine && cmd !== '') lastBoostSource = '';

    switch (cmd) {
      case 'tier': out.format = a1; break;
      case 'player': if (a1 === 'p1' || a1 === 'p2') out.players[a1] ||= a2; break;
      case 'poke': if (a1 === 'p1' || a1 === 'p2') out.preview[a1].push(speciesOf(a2)); break;
      case 'showteam': if (a1 === 'p1' || a1 === 'p2') out.sheets[a1] = parseSheet(rest.slice(1).join('|')); break;
      case 'start': break;
      case 'turn': {
        started = true;
        turn = { number: Number(a1) || out.turns.length + 1, replacements: pending, actions: [], hpEnd: { p1: {}, p2: {} } };
        pending = [];
        out.turns.push(turn);
        current = null;
        afterUpkeep = false;
        break;
      }
      case 'upkeep': {
        if (turn) turn.hpEnd = { p1: { ...hp.p1 }, p2: { ...hp.p2 } };
        afterUpkeep = true;
        current = null;
        break;
      }
      case 'switch': case 'drag': {
        const pos = parsePosition(a1);
        if (!pos) break;
        const species = speciesOf(a2);
        const before = active[`${pos.player}${pos.slot}`];
        const level = hpOf(a3);
        enter(pos, species);
        if (level !== null) hp[pos.player][species] = level;
        if (!started) { out.leads[pos.player].push(species); break; }
        if (afterUpkeep || !turn) { pending.push({ player: pos.player, slot: pos.slot, species }); break; }
        // A pivot move or a forced switch: credited to the action of the Pokémon that left.
        const leaving = before ? turn.actions.filter((x) => x.player === pos.player && x.slot === pos.slot && x.species === before).pop() : undefined;
        const key = `${pos.player}${pos.slot}`;
        if (leaving && (leaving.kind === 'move' || forcedOut[key])) { leaving.switchTo = species; delete forcedOut[key]; break; }
        if (before) newAction(pos, before, { kind: 'switch', switchTo: species });
        break;
      }
      // A form change (Mega Evolution) keeps the Pokémon's identity: it's still the one that came in.
      case 'detailschange': break;
      case '-mega': {
        const pos = parsePosition(a1);
        if (pos) megaPending[`${pos.player}${pos.slot}`] = true;
        break;
      }
      case 'move': {
        const pos = parsePosition(a1);
        if (!pos || !turn) break;
        // Moves called by other moves (Instruct, a locked-in move...) aren't new choices.
        if (tagged(rest, 'from')?.startsWith('move:')) { current = null; break; }
        const species = speciesAt(a1);
        const existing = actionOf(pos);
        const a = existing && !existing.move && existing.kind === 'move' ? existing : newAction(pos, species, {});
        a.move = a2;
        const tpos = parsePosition(a3);
        if (tpos) { a.target = { player: tpos.player, slot: tpos.slot }; a.targetSpecies = speciesAt(a3); }
        const spread = tagged(rest, 'spread');
        if (spread !== null) {
          a.spread = spread.split(',').map((s) => s.trim()).filter((s) => /^p[12][ab]$/.test(s)).map((s) => ({ player: s.slice(0, 2) as Player, slot: s[2] as 'a' | 'b' }));
        }
        if (rest.includes('[miss]') && tpos) target(a, speciesAt(a3)).miss = true;
        current = a;
        break;
      }
      case 'cant': {
        const pos = parsePosition(a1);
        if (!pos || !turn) break;
        const why = a2.replace(/^move: /, '');
        const map: Record<string, ReplayAction['cant']> = { par: 'par', slp: 'slp', frz: 'frz', flinch: 'flinch', recharge: 'recharge' };
        const cant = map[why];
        const a = actionOf(pos) ?? newAction(pos, speciesAt(a1), {});
        if (cant) a.cant = cant;
        current = null;
        break;
      }
      case '-curestatus': {
        const pos = parsePosition(a1);
        if (!pos || !turn || (a2 !== 'slp' && a2 !== 'frz') || tagged(rest, 'from')) break;
        // Woke up / thawed on its own, right before acting.
        const a = actionOf(pos) ?? newAction(pos, speciesAt(a1), {});
        a.wake = true;
        break;
      }
      case '-end': {
        const pos = parsePosition(a1);
        if (pos && turn && a2 === 'confusion') { const a = actionOf(pos) ?? newAction(pos, speciesAt(a1), {}); a.wake = true; }
        break;
      }
      case '-miss': {
        if (current && a2) target(current, speciesAt(a2)).miss = true;
        break;
      }
      case '-crit': {
        if (current) target(current, speciesAt(a1)).crit = true;
        break;
      }
      case '-hitcount': {
        if (current) current.hits = Number(a2) || undefined;
        break;
      }
      case '-singleturn': {
        const pos = parsePosition(a1);
        if (!pos || !current || !/protect|detect|shield|obstruct|bunker|silk trap|bulwark|wide guard|quick guard/i.test(a2)) break;
        const key = `${pos.player}:${current.species}`;
        if (protectedLast[key]) current.protectWorks = true;
        break;
      }
      case '-damage': {
        const pos = parsePosition(a1);
        if (!pos) break;
        const species = speciesAt(a1);
        const level = hpOf(a2);
        if (level !== null) hp[pos.player][species] = level;
        const from = tagged(rest, 'from');
        if (from === 'confusion' && turn) {
          const a = actionOf(pos) ?? newAction(pos, species, {});
          a.cant = 'confusion';
          if (level !== null) a.selfHp = level;
          break;
        }
        if (!from && current && level !== null && !(current.player === pos.player && current.slot === pos.slot && current.species === species)) {
          target(current, species).hp = level;
        }
        break;
      }
      case '-heal': case '-sethp': {
        const pos = parsePosition(a1);
        const level = hpOf(a2);
        if (pos && level !== null) hp[pos.player][speciesAt(a1)] = level;
        break;
      }
      case 'faint': {
        const pos = parsePosition(a1);
        if (pos) hp[pos.player][speciesAt(a1)] = 0;
        break;
      }
      case '-status': {
        const from = tagged(rest, 'from');
        if (!current || !a1) break;
        const species = speciesAt(a1);
        // A contact ability (Static, Flame Body...) hitting back at the attacker.
        if (from?.startsWith('ability:') && species === current.species) { (current.self ??= []).push(a2); break; }
        if (from || known.always(current.move, a2)) break;
        if (species !== current.species) (target(current, species).effects ??= []).push(a2);
        break;
      }
      case '-start': {
        if (current && a2 === 'confusion' && !tagged(rest, 'from') && speciesAt(a1) !== current.species && !known.always(current.move, 'confusion')) {
          (target(current, speciesAt(a1)).effects ??= []).push('confusion');
        }
        break;
      }
      case '-ability': case '-enditem': case '-item': {
        lastBoostSource = cmd;
        const pos = parsePosition(a1);
        if (pos && cmd === '-enditem' && /eject (button|pack)/i.test(a2)) forcedOut[`${pos.player}${pos.slot}`] = true;
        if (pos && cmd === '-ability' && /emergency exit|wimp out/i.test(a2)) forcedOut[`${pos.player}${pos.slot}`] = true;
        break;
      }
      case '-activate': {
        lastBoostSource = cmd;
        const pos = parsePosition(a1);
        if (pos && /red card/i.test(a2)) {
          const by = parsePosition(tagged(rest, 'of') ?? '');
          if (by) forcedOut[`${by.player}${by.slot}`] = true;
        }
        break;
      }
      case '-boost': case '-unboost': {
        if (!current || lastBoostSource || tagged(rest, 'from')) break;
        const stat = a2;
        const amount = Number(a3) || 1;
        const effect = `${stat}${cmd === '-boost' ? '+' : '-'}${amount}`;
        if (known.always(current.move, effect)) break;
        const species = speciesAt(a1);
        if (species === current.species && parsePosition(a1)?.player === current.player) (current.self ??= []).push(effect);
        else (target(current, species).effects ??= []).push(effect);
        break;
      }
      case '-message': {
        const m = /^(.+) forfeited\.$/.exec(a1);
        if (m) out.forfeit = out.players.p1 === m[1] ? 'p1' : out.players.p2 === m[1] ? 'p2' : null;
        break;
      }
      case 'win': out.winner = out.players.p1 === a1 ? 'p1' : out.players.p2 === a1 ? 'p2' : null; break;
      default: break;
    }

    // Protect streaks: remember who protected successfully this turn.
    if (cmd === 'turn') {
      for (const k of Object.keys(protectedLast)) delete protectedLast[k];
      const prev = out.turns[out.turns.length - 2];
      for (const a of prev?.actions ?? []) {
        if (/^(protect|detect|spiky shield|king's shield|baneful bunker|obstruct|silk trap|burning bulwark|wide guard|quick guard)$/i.test(a.move) && !a.cant) {
          protectedLast[`${a.player}:${a.species}`] = true;
        }
      }
    }
  }
  if (!out.turns.length) throw new ReplayError('This replay has no turns.');
  // The battle can end before the last turn's end: its HP is as the log left it.
  const last = out.turns[out.turns.length - 1]!;
  if (!Object.keys(last.hpEnd.p1).length && !Object.keys(last.hpEnd.p2).length) last.hpEnd = { p1: { ...hp.p1 }, p2: { ...hp.p2 } };
  return out;
}
