import { AVATARS } from '../domain/avatars.ts';
import { setAvatar } from '../infra/auth.ts';
import { session } from '../state/account.ts';
import { esc, must } from './dom.ts';
import { modal, toast } from './overlays.ts';

/** The image for a profile picture (portraits from PMD Collab, see public/avatars/CREDITS.md). */
export const avatarUrl = (avatar: string): string => `/avatars/${encodeURIComponent(avatar)}.png`;

/** Names the file-safe spelling can't show (punctuation, symbols, accents). */
const LABELS: Readonly<Record<string, string>> = {
  Nidoran_F: 'Nidoran♀', Nidoran_M: 'Nidoran♂', Farfetch_d: 'Farfetch’d', Sirfetch_d: 'Sirfetch’d',
  Mr_Mime: 'Mr. Mime', Mime_Jr_: 'Mime Jr.', Mr_Rime: 'Mr. Rime', Ho_Oh: 'Ho-Oh', Porygon_Z: 'Porygon-Z', Type_Null: 'Type: Null',
  Jangmo_o: 'Jangmo-o', Hakamo_o: 'Hakamo-o', Kommo_o: 'Kommo-o', Wo_Chien: 'Wo-Chien', Chien_Pao: 'Chien-Pao', Ting_Lu: 'Ting-Lu',
  Chi_Yu: 'Chi-Yu', Flabebe: 'Flabébé',
};

/** How a profile picture's Pokémon is written: "Mr_Mime" -> "Mr. Mime", "Iron_Valiant" -> "Iron Valiant". */
export const avatarLabel = (avatar: string): string => LABELS[avatar] ?? avatar.replace(/_/g, ' ');

/** Lowercase, without accents, spaces or punctuation: what search compares. */
const searchKey = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9♀♂]/g, '');

/**
 * Account menu → Change profile picture: every allowed portrait in Pokédex order, with a search box. The current
 * one is highlighted; Save stores the pick on the account (it then shows wherever you sign in).
 */
export async function openAvatarPicker(onChange: () => void): Promise<void> {
  const state = session.state;
  if (state?.status !== 'signed-in') return;
  let picked = state.account.avatar ?? '';
  const tiles = AVATARS.map((a, i) => `<button type="button" class="avatar-tile ${a === picked ? 'on' : ''}" data-avatar="${esc(a)}" aria-pressed="${a === picked}" title="#${i + 1} ${esc(avatarLabel(a))}">
      <img src="${avatarUrl(a)}" alt="" loading="lazy" width="48" height="48"><span>${esc(avatarLabel(a))}</span></button>`).join('');

  const chosen = modal<string>({
    title: 'Change profile picture',
    desc: 'Pick any Pokémon. Portraits by the PMD Collab artists (CC BY-NC 4.0).',
    body: `<input class="field" id="avatar-search" type="search" placeholder="Search by name or number" aria-label="Search Pokémon">
      <div class="avatar-grid" id="avatar-grid" role="group" aria-label="Profile pictures">${tiles}</div>
      <p class="hint" id="avatar-none" hidden>No Pokémon matches that search.</p>`,
    actions: [
      { label: 'Cancel', value: null },
      { label: 'Save', cls: 'primary', run: () => picked || null },
    ],
  });

  // The dialog is in the page as soon as modal() returns; wire the search and the tiles.
  const grid = must('#avatar-grid');
  const search = must<HTMLInputElement>('#avatar-search');
  grid.querySelector('.avatar-tile.on')?.scrollIntoView({ block: 'center' });
  grid.addEventListener('click', (e) => {
    const tile = e.target instanceof Element ? e.target.closest<HTMLElement>('.avatar-tile') : null;
    if (!tile?.dataset.avatar) return;
    picked = tile.dataset.avatar;
    grid.querySelectorAll('.avatar-tile.on').forEach((t) => { t.classList.remove('on'); t.setAttribute('aria-pressed', 'false'); });
    tile.classList.add('on');
    tile.setAttribute('aria-pressed', 'true');
  });
  search.addEventListener('input', () => {
    const raw = search.value.trim();
    const q = searchKey(raw);
    const number = raw.replace(/^#/, '');
    let shown = 0;
    grid.querySelectorAll<HTMLElement>('.avatar-tile').forEach((tile, i) => {
      const avatar = tile.dataset.avatar ?? '';
      const match = !q || searchKey(avatar).includes(q) || searchKey(avatarLabel(avatar)).includes(q) || String(i + 1) === number;
      tile.hidden = !match;
      if (match) shown++;
    });
    must('#avatar-none').hidden = shown > 0;
  });

  const avatar = await chosen;
  if (!avatar || avatar === state.account.avatar) return;
  try {
    state.account = await setAvatar(avatar);
    onChange();
    toast(`Profile picture changed to ${avatarLabel(avatar)}`);
  } catch (e) {
    toast(e instanceof Error ? e.message : 'Couldn’t change the profile picture.', true);
  }
}
