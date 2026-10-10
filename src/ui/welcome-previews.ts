/**
 * Small pictures for the welcome tour, drawn with the app's own components (same classes, real sprites) so they
 * always look like the current UI, in light and dark mode. The content is a sample matchup: "Floette Balance"
 * against "Eric Rios". They are decorative: inert, hidden from screen readers (each step's text says the same).
 */
import { esc } from './dom.ts';
import { itemIcon, monIcon } from './icons.ts';
import { ICON_CHEVRON, ICON_COPY } from './views/result-card.ts';

const MY_TEAM = [
  ['Rillaboom', 'Miracle Seed'], ['Aerodactyl-Mega', 'Aerodactylite'], ['Sneasler', 'Grassy Seed'],
  ['Floette-Mega', 'Floettite'], ['Kingambit', 'Life Orb'], ['Kommo-o', 'Leftovers'],
] as const;
const OPP_TEAM = [
  ['Gholdengo', 'Life Orb'], ['Volcarona', 'Rocky Helmet'], ['Garchomp-Mega-Z', 'Garchompite Z'],
  ['Incineroar', 'Sitrus Berry'], ['Rillaboom', 'Miracle Seed'], ['Raichu-Mega-Y', 'Raichunite Y'],
] as const;

const strip = (team: readonly (readonly [string, string])[]): string =>
  `<div class="team-strip">${team.map(([mon, item]) => `<div class="cell">${monIcon(mon)}${itemIcon(item, 'xs')}</div>`).join('')}</div>`;

const teamBox = (side: 'me' | 'opp', title: string, team: readonly (readonly [string, string])[]): string =>
  `<div class="box ${side}"><div class="box-head"><span class="t">${esc(title)}</span></div>${strip(team)}</div>`;

/** Lead and back slots; a Mega in the paste starts the battle in base form, as on the real screen. */
const slots = (side: 'me' | 'opp', lead: [string, string], back: [string, string]): string => {
  const slot = (name: string): string => `<div class="slot filled">${monIcon(name, 'sm')}<span class="nm">${esc(name)}</span></div>`;
  return `<div class="box ${side}"><div class="box-head"><span class="t">${side === 'me' ? 'Your lead and back' : 'Opponent lead and back'}</span></div>
    <div class="slots-label">Lead</div><div class="slots">${slot(lead[0])}${slot(lead[1])}</div>
    <div class="slots-label">Back</div><div class="slots">${slot(back[0])}${slot(back[1])}</div></div>`;
};

const act = (side: 'me' | 'opp', mon: string, move: string, target = ''): string =>
  `<div class="act ${side}">${monIcon(mon, 'xs')}<div class="txt"><div class="mv">${esc(move)}</div>${target ? `<div class="tg">→ ${esc(target)}</div>` : ''}</div></div>`;

const turnCard = (title: string, mine: string[], theirs: string[], extra = '', cls = '', head = ''): string =>
  `<div class="turn ${cls}"><div class="turn-head"><span class="ttl">${esc(title)}</span><span class="spacer"></span>${head}</div>
    <div class="acts"><div class="col">${mine.join('')}</div><div class="col">${theirs.join('')}</div></div>${extra}</div>`;

const miniHp = (mon: string, pct: number): string =>
  `<span class="mini-hp ${pct ? '' : 'ko'}">${monIcon(mon, 'xs')}${pct ? `<span class="hp-bar"><i class="ok" data-w="${pct}"></i></span>` : '<span class="ko-tag">KO</span>'}</span>`;

const TURN_1_ME = [act('me', 'Rillaboom', 'Wood Hammer', 'Raichu'), act('me', 'Kommo-o', 'Flamethrower', 'Gholdengo')];
const TURN_1_OPP = [act('opp', 'Gholdengo', 'Nasty Plot'), act('opp', 'Raichu', 'Mega + Fake Out', 'Kommo-o')];
const TURN_1_SUMMARY = `<div class="sum-hp"><div class="me">${miniHp('Rillaboom', 100)}${miniHp('Kommo-o', 92)}</div><div class="opp">${miniHp('Gholdengo', 100)}${miniHp('Raichu-Mega-Y', 0)}</div></div>
  <div class="fx-strip"><span class="fx">Grassy Terrain<small>4 left</small></span></div>`;

export const PREVIEWS = {
  /** The matchup this tour uses as its example. */
  hello: `<div class="pv-row">${teamBox('me', 'Floette Balance', MY_TEAM)}<span class="pv-vs">vs</span>${teamBox('opp', 'Eric Rios', OPP_TEAM)}</div>`,

  /** The sidebar folder and the team it holds. */
  team: `<div class="pv-row">
    <div class="pv-side"><div class="folder open"><div class="folder-row"><span class="caret">▸</span><span class="name">Floette Balance</span><span class="count">1</span></div>
      <div class="plans"><div class="plan-row active"><span class="name">vs Eric Rios</span></div><div class="add-plan">+ New gameplan</div></div></div></div>
    ${teamBox('me', 'Floette Balance', MY_TEAM)}</div>`,

  /** The opponent's team and two tabs with different backs. */
  tabs: `<div class="pv-col">${teamBox('opp', 'Eric Rios', OPP_TEAM)}
    <div class="tabbar pv-tabs"><span class="tab-add">+</span><div class="sheet-tabs">
      <div class="sheet-tab on"><span class="nm">Plan 1</span><span class="tab-menu">▾</span></div><div class="sheet-tab"><span class="nm">Plan 2</span></div></div></div></div>`,

  /** Leads and backs, then two alternative first turns. */
  turns: `<div class="pv-row pv-top">${slots('me', ['Rillaboom', 'Kommo-o'], ['Aerodactyl', 'Sneasler'])}
    <div class="pv-col">${turnCard('Turn 1', TURN_1_ME, TURN_1_OPP)}
      ${turnCard('Turn 1', [act('me', 'Rillaboom', 'Fake Out', 'Gholdengo'), act('me', 'Kommo-o', 'Clangorous Soul')], [act('opp', 'Gholdengo', 'Nasty Plot'), act('opp', 'Raichu', 'Focus Blast', 'Rillaboom')], '', 'pv-alt')}</div></div>`,

  /** A turn card with who is left, and its open log. */
  results: turnCard('Turn 1', TURN_1_ME, TURN_1_OPP, `${TURN_1_SUMMARY}
    <div class="turn-result"><ol class="res-log">
      <li class="me">${monIcon('Rillaboom', 'xs')}<div class="txt"><b>Wood Hammer</b><div class="tgt">→ ${monIcon('Raichu-Mega-Y', 'xs')} Raichu-Mega-Y <span class="dmg">147.9–174.9%</span> <span class="ko-tag">KO</span></div></div></li>
    </ol></div>`, 'open', `<span class="card-btn expand open">${ICON_CHEVRON}</span>`),
} as const;

const ICON_CURSOR = '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3l14 8-6 1.5L10 19Z" fill="#fff" stroke="#181b2b" stroke-width="1.6" stroke-linejoin="round"/></svg>';

/** Pictures for the "What's new" box (news.ts); each one loops a short animation of the feature. */
export const NEWS_PREVIEWS = {
  /** The pointer presses a turn card's copy button and the copy slides in right beside it. */
  copyTurn: `<div class="pv-row pv-top pv-copy">
    ${turnCard('Turn 1', TURN_1_ME, TURN_1_OPP, '', '', `<span class="card-btn pv-copy-btn">${ICON_COPY}<span class="pv-cursor">${ICON_CURSOR}</span></span><span class="card-btn">${ICON_CHEVRON}</span>`)}
    ${turnCard('Turn 1', TURN_1_ME, TURN_1_OPP, '', 'selected pv-copy-new', `<span class="card-btn">${ICON_COPY}</span><span class="card-btn">${ICON_CHEVRON}</span>`)}
  </div>`,
} as const;
