import { STAT_LABEL } from '../../domain/stats.ts';
import type { EndMon, HitResult, LogEntry, StatChange, StatusTarget } from '../../domain/simulation/log.ts';
import { fieldEffects } from '../../domain/simulation/state.ts';
import type { StatusId } from '../../domain/simulation/tables.ts';
import { CHANCE_LABEL, STATUS_LABEL, STATUS_SHORT } from '../../domain/simulation/tables.ts';
import type { BattleState } from '../../domain/simulation/state.ts';
import type { FlowNode, Side } from '../../domain/types.ts';
import type { SimView } from '../../state/sim-service.ts';
import { esc } from '../dom.ts';
import { monIcon } from '../icons.ts';
import { formOf, renamedForms, showNames } from '../names.ts';

export const ICON_CHEVRON = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>`;

/** Up to two decimals, so fixed fractions read exactly (6.25%, 12.5%). */
const fmtPct = (n: number): string => String(Math.round(n * 100) / 100);
/** How names are shown in a result: Pokémon by their current form, and messages with those names rewritten. */
interface Names { mon(side: Side, key: string): string; text(message: string): string }

const namesFor = (st: BattleState | null | undefined, fallback: Partial<Record<Side, readonly string[]>> = {}): Names => {
  const forms = renamedForms(st, fallback);
  return { mon: (side, key) => formOf(st, side, key), text: (m) => showNames(m, forms) };
};

function statChips(changes: readonly StatChange[] | undefined): string {
  return (changes ?? [])
    .filter((c) => c.delta !== 0)
    .map((c) => `<span class="bchip ${c.delta > 0 ? 'up' : 'down'}">${c.delta > 0 ? '+' : '−'}${Math.abs(c.delta)} ${STAT_LABEL[c.stat]}</span>`)
    .join('');
}

const statusChip = (s: StatusId | null | undefined): string =>
  s ? `<span class="schip ${s}" title="${esc(STATUS_LABEL[s])}">${STATUS_SHORT[s]}</span>` : '';

/** A condition that was inflicted, plus the berry that cured it if one did. */
const inflictedText = (s: StatusId | undefined, cured: string | undefined): string =>
  s ? (cured ? `<s class="muted">${STATUS_SHORT[s]}</s> <span class="muted">cured by ${esc(cured)}</span>` : statusChip(s)) : '';

function hitText(r: HitResult, n: Names): string {
  if (r.protected) return '<span class="muted">protected</span>';
  if (r.substitute) return `<span class="muted">${r.substitute === 'broken' ? 'breaks the Substitute' : 'hits the Substitute'}</span>`;
  if (r.missed) return '<span class="chance">missed</span>';
  if (r.blockedBy) return `<span class="muted">blocked by ${esc(n.text(r.blockedBy))}</span>`;
  if (r.immune || r.minPct === undefined || r.maxPct === undefined) return '<span class="muted">no effect</span>';
  const range = r.minPct === r.maxPct ? `${fmtPct(r.minPct)}%` : `${fmtPct(r.minPct)}–${fmtPct(r.maxPct)}%`;
  const ko = r.koChance ? ` <span class="ko-tag">${r.koChance === 100 ? 'KO' : `${r.koChance}% KO`}</span>` : '';
  const changes = r.changes?.length ? ` ${statChips(r.changes)}` : '';
  const status = r.status ? ` ${inflictedText(r.status, r.cured)}` : '';
  const endured = r.endured ? ` <span class="muted">holds on with ${esc(r.endured)}</span>` : '';
  const power = r.power ? ` <span class="bchip up" title="Power this turn, from the battle so far">${r.power} BP</span>` : '';
  const hits = r.hits ? ` <span class="muted">${r.hits} hit${r.hits === 1 ? '' : 's'}</span>` : '';
  const crit = r.crit ? ' <span class="chance">critical hit</span>' : '';
  const chance = (r.effects ?? []).map((fx) => ` <span class="chance">${esc(chanceLabel(fx))}</span>`).join('');
  // HP the turn recorded (a replay): compared with what the calculator expected.
  const actual = r.actualPct !== undefined
    ? ` <span class="actual" title="HP afterwards as recorded; the calculator's estimate is the range before it">→ ${fmtPct(r.actualPct)}% left (actual)</span>` : '';
  return `<span class="dmg">${range}</span>${power}${hits}${crit}${ko}${actual}${endured}${changes}${status}${chance}`;
}

/** "spd-1" → "−1 Sp. Def"; conditions and flinch by name. */
function chanceLabel(fx: string): string {
  if (/^(atk|def|spa|spd|spe)[+-]\d(,(atk|def|spa|spd|spe)[+-]\d)*$/.test(fx)) {
    return fx.split(',').map((p) => `${p[3] === '+' ? '+' : '−'}${p.slice(4)} ${STAT_LABEL[p.slice(0, 3) as keyof typeof STAT_LABEL]}`).join(', ');
  }
  const [base, rest] = fx.split(' (');
  return (CHANCE_LABEL[base ?? ''] ?? fx) + (rest ? ` (${rest}` : '');
}

function statusTargetText(t: StatusTarget, n: Names): string {
  if (t.protected) return '<span class="muted">protected</span>';
  if (t.blocked) return `<span class="muted">fails (${esc(n.text(t.blocked))})</span>`;
  return inflictedText(t.status, t.cured);
}

function logRow(e: LogEntry, n: Names): string {
  const icon = (side: Side, name: string): string => monIcon(n.mon(side, name), 'xs');
  const name = (side: Side, key: string): string => esc(n.mon(side, key));
  let body = '';
  switch (e.type) {
    case 'hit':
      body = `<b>${esc(e.move)}</b>`
        + (e.results.length
          ? e.results.map((r) => `<div class="tgt">→ ${icon(r.side, r.mon)} ${name(r.side, r.mon)} ${hitText(r, n)}</div>`).join('')
          : '<div class="tgt muted">no target left</div>')
        + (e.self?.some((c) => c.delta !== 0) ? `<div class="tgt">${name(e.side, e.mon)} ${statChips(e.self)}</div>` : '');
      break;
    case 'boost':
      body = `<b>${esc(n.text(e.move))}</b> ${statChips(e.changes) || '<span class="muted">no change</span>'}`;
      break;
    case 'debuff':
      body = `<b>${esc(e.move)}</b>${e.targets.map((t) => `<div class="tgt">→ ${icon(t.side, t.mon)} ${name(t.side, t.mon)} ${t.protected ? '<span class="muted">protected</span>' : t.blocked ? `<span class="muted">blocked by ${esc(n.text(t.blocked))}</span>` : (statChips(t.changes) || '<span class="muted">no effect</span>')}</div>`).join('')}`;
      break;
    case 'status':
      body = `<b>${esc(e.move)}</b>${e.targets.map((t) => `<div class="tgt">→ ${icon(t.side, t.mon)} ${name(t.side, t.mon)} ${statusTargetText(t, n)}</div>`).join('')}`;
      break;
    case 'residual':
      body = `<span class="muted">${esc(e.text)}</span> <span class="dmg">${e.pct > 0 ? '+' : '−'}${fmtPct(Math.abs(e.pct))}%</span>${e.fainted ? ' <span class="ko-tag">KO</span>' : ''}`;
      break;
    case 'cure': body = `<i class="muted">${esc(n.text(e.text))}</i>`; break;
    case 'switch':
      body = `${e.via ? `<b>${esc(e.via)}</b> ` : ''}${e.replace ? 'fainted, replaced by' : 'switches to'} ${icon(e.side, e.in)} <b>${name(e.side, e.in)}</b>`;
      break;
    case 'effect': body = `<b>${esc(n.text(e.source))}</b> <span class="muted">${esc(n.text(e.text))}</span>`; break;
    case 'protect':
    case 'field': body = `<b>${esc(n.text(e.move))}</b> <span class="muted">${esc(n.text(e.text))}</span>`; break;
    case 'mega': body = `Mega Evolves into <b>${esc(e.species)}</b>`; break;
    case 'skip': body = `<i class="muted">${esc(n.text(e.why))}</i>`; break;
    case 'other': body = `<b>${esc(e.move)}</b> <span class="muted">${esc(e.note)}</span>`; break;
  }
  return `<li class="${e.side}">${icon(e.side, e.mon)}<div class="txt">${body}</div></li>`;
}

function hpRow(x: EndMon): string {
  const tone = x.fainted ? '' : x.pct > 50 ? 'ok' : x.pct > 20 ? 'mid' : 'low';
  const range = !x.fainted && x.lo !== x.hi ? `<small class="muted">${x.lo}–${x.hi}</small>` : '';
  const tip = x.fainted
    ? (x.mayLive ? `Faints on the average roll; could survive a low one (${x.lo}–${x.hi}%)` : 'Faints')
    : `${x.lo}–${x.hi}% depending on rolls`;
  const charging = (x.charging ? `<span class="bchip up" title="${esc(`Charging ${x.charging}: it attacks on its next action`)}">charging ${esc(x.charging)}</span>` : '')
    + (x.effects ?? []).map((fx) => `<span class="bchip vol">${esc(fx)}</span>`).join('');
  const lost = x.lostItem ? `<s class="muted lost-item" title="${esc(`${x.lostItem}: used up or removed`)}">${esc(x.lostItem)}</s>` : '';
  return `<div class="hp-row ${x.fainted ? 'ko' : ''}" title="${esc(tip)}">${monIcon(x.species, 'xs')}<span class="hp-name">${esc(x.species)}</span>${statusChip(x.condition)}${lost}
    <span class="hp-bar"><i class="${tone}" data-w="${x.pct}"></i></span>
    <span class="hp-pct">${x.fainted ? 'KO' : `${x.pct}%`}</span>${range}${x.mayFaint ? '<span class="ko-tag">may KO</span>' : ''}
    ${x.actual !== undefined ? '<span class="actual" title="HP at the end of the turn as recorded">actual</span>' : ''}${charging}${statChips(x.boosts)}</div>`;
}

/**
 * The "Turn result" half of a turn card. `start` is the state the turn begins from (for names in messages of an
 * unfinished turn); `picks` names everyone brought, for when no state is known.
 */
export function resultHTML(node: FlowNode, sim: SimView, start: BattleState | null, picks: Partial<Record<Side, readonly string[]>> = {}): string {
  let inner = '';
  if (!sim.enabled) return '';
  if (sim.status === 'loading') inner = '<div class="res-msg">Loading the calculator…</div>';
  else if (sim.status === 'error') inner = '<div class="res-msg">Calculator unavailable. Reload the page to retry.</div>';
  else {
    const r = sim.results.get(node.id);
    if (!r) inner = '';
    else if (r.status === 'blocked') inner = `<div class="res-msg">${r.over ? 'The battle already ended earlier in this branch.' : 'Finish the previous turn to see this result.'}</div>`;
    else if (r.status === 'incomplete') {
      const n = namesFor(start, picks);
      inner = `<div class="res-msg">Complete every action to see the result:<ul>${r.missing.map((m) => `<li>${esc(n.text(m))}</li>`).join('')}</ul></div>`;
    }
    else if (r.status === 'error') inner = `<div class="res-msg bad">${esc(r.message)}</div>`;
    else {
      const n = namesFor(r.state);
      const group = (side: 'me' | 'opp', label: string): string => {
        const rows = r.end.filter((x) => x.side === side).map(hpRow).join('');
        return rows ? `<div class="res-sub">${label}</div>${rows}` : '';
      };
      inner = (r.entry.length ? `<div class="res-sub">On entry</div><ol class="res-log">${r.entry.map((e) => logRow(e, n)).join('')}</ol>` : '')
        + `<div class="res-sub">In order</div><ol class="res-log">${r.log.map((e) => logRow(e, n)).join('')}</ol>`
        + `<div class="res-sub">End of turn</div>${group('me', 'You')}${group('opp', 'Opponent')}`;
    }
  }
  return `<div class="turn-result">${inner}</div>`;
}

const ordinal = (n: number): string => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;

const hpTone = (pct: number): string => (pct > 50 ? 'ok' : pct > 20 ? 'mid' : 'low');

/**
 * One Pokémon in the card summary: when it acted this turn (a small number), sprite plus a small HP bar, or a KO tag.
 * Details are in the tooltip.
 */
function miniHp(x: EndMon, order: number | undefined): string {
  const tip = (order ? `Acted ${ordinal(order)}. ` : '') + (x.fainted ? `${x.species}: KO`
    : `${x.species}: ${x.pct}% (${x.lo}–${x.hi}% depending on rolls)${x.charging ? `, charging ${x.charging}` : ''}`);
  const badge = order ? `<span class="act-order" aria-label="${esc(`acted ${ordinal(order)}`)}">${order}</span>` : '';
  return `<span class="mini-hp ${x.fainted ? 'ko' : ''}" title="${esc(tip)}">${badge}${monIcon(x.species, 'xs')}${x.fainted
    ? '<span class="ko-tag">KO</span>'
    : `<span class="hp-bar"><i class="${hpTone(x.pct)}" data-w="${x.pct}"></i></span>`}${statusChip(x.condition)}</span>`;
}

/**
 * The compact result shown on every turn card: each side's Pokémon after the turn (HP bar or KO), or a one-line
 * reason when there is no result yet. The full log is in {@link resultHTML}, opened from the card.
 */
export function summaryHTML(node: FlowNode, sim: SimView, start: BattleState | null, picks: Partial<Record<Side, readonly string[]>> = {}): string {
  if (!sim.enabled) return '';
  if (sim.status === 'loading') return '<div class="sum-msg">Loading the calculator…</div>';
  if (sim.status === 'error') return '<div class="sum-msg bad">Calculator unavailable. Reload the page to retry.</div>';
  const r = sim.results.get(node.id);
  if (!r) return '';
  if (r.status === 'blocked') return `<div class="sum-msg">${r.over ? 'The battle already ended in this branch.' : 'Finish the previous turn first.'}</div>`;
  if (r.status === 'error') return `<div class="sum-msg bad">${esc(r.message)}</div>`;
  if (r.status === 'incomplete') {
    const n = namesFor(start, picks);
    const more = r.missing.length > 1 ? ` <span class="muted">+${r.missing.length - 1} more</span>` : '';
    return `<div class="sum-msg" title="${esc(r.missing.map(n.text).join('\n'))}">To do: ${esc(n.text(r.missing[0] ?? ''))}${more}</div>`;
  }
  // Who is on the field after the turn, plus anyone who fainted during it (not Pokémon that fell in earlier turns).
  const shown = (x: EndMon): boolean => r.state.active[x.side].includes(x.name) && !x.fainted
    || (x.fainted && start?.mons[x.side][x.name]?.fainted !== true);
  const side = (s: Side): string => r.end.filter((x) => x.side === s && shown(x)).map((x) => miniHp(x, r.order[`${x.side}:${x.name}`])).join('');
  return `<div class="sum-hp"><div class="me">${side('me')}</div><div class="opp">${side('opp')}</div></div>`;
}

/** Whether a turn card has a full log (or list of missing things) to open. */
export function hasDetails(node: FlowNode, sim: SimView): boolean {
  if (!sim.enabled || sim.status !== 'ready') return false;
  const status = sim.results.get(node.id)?.status;
  return status === 'ready' || status === 'incomplete';
}

/**
 * Strip along the bottom of a turn card listing the field effects in play during that turn (weather, terrain,
 * Trick Room, and Tailwind/screens per side) with how long each lasts. Empty when nothing is up.
 */
export function fieldStripHTML(node: FlowNode, sim: SimView): string {
  if (!sim.enabled || sim.status !== 'ready') return '';
  const r = sim.results.get(node.id);
  if (!r || (r.status !== 'ready' && r.status !== 'incomplete')) return '';
  const effects = fieldEffects(r.field);
  if (!effects.length) return '';
  const chips = effects.map((fx) => {
    const whose = fx.side === 'me' ? 'your side' : fx.side === 'opp' ? "the opponent's side" : '';
    const when = fx.left === null ? 'stays until removed' : fx.left ? `${fx.left} more turn${fx.left > 1 ? 's' : ''} after this one` : 'ends after this turn';
    const tip = `${fx.label}${whose ? ` on ${whose}` : ''}: ${when}`;
    const sideTag = fx.side ? `<em>${fx.side === 'me' ? 'You' : 'Opp'}</em>` : '';
    return `<span class="fx ${fx.side ?? ''}" title="${esc(tip)}">${esc(fx.label)}${sideTag}${fx.left === null ? '' : `<small>${fx.left ? `${fx.left} left` : 'ends'}</small>`}</span>`;
  }).join('');
  return `<div class="fx-strip" aria-label="Field effects in play">${chips}</div>`;
}

/** Banner under the top bar explaining why turn results are off, loading, or degraded. */
export function noticeHTML(sim: SimView): string {
  if (!sim.enabled) return sim.reasons.length ? `<div class="notice info">Turn results are off. To enable them: ${sim.reasons.map(esc).join('; ')}.</div>` : '';
  if (sim.status === 'loading') return '<div class="notice info">Loading the damage calculator…</div>';
  if (sim.status === 'error') return `<div class="notice">Turn results aren't available: ${esc(sim.message)}. Reload the page to retry.</div>`;
  if (!sim.native) return '<div class="notice">This calculator build has no Champions mode, so damage uses Gen 9 rules with Champions stats. Results may differ slightly.</div>';
  return '';
}
