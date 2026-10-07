import { esc, must } from './dom.ts';
import { modal, toast } from './overlays.ts';

/** The colour palettes in src/styles/themes.css. Each follows the system's light/dark mode, except Night. */
export const PALETTES = [
  { id: 'default', name: 'Classic', hint: 'Indigo and pink' },
  { id: 'scarlet-violet', name: 'Scarlet / Violet', hint: 'Violet against scarlet' },
  { id: 'sword-shield', name: 'Sword / Shield', hint: 'Cyan against magenta' },
  { id: 'gold-silver', name: 'Gold / Silver', hint: 'Silver against gold, on parchment' },
  { id: 'ruby-sapphire', name: 'Ruby / Sapphire', hint: 'Jewel tones' },
  { id: 'pocket', name: 'Pocket', hint: 'The original Game Boy screen' },
  { id: 'colorblind', name: 'Colour-blind safe', hint: 'Blue against orange' },
  { id: 'contrast', name: 'High contrast', hint: 'Black and white, strong borders' },
  { id: 'night', name: 'Night', hint: 'True black, always dark' },
] as const;

export type PaletteId = (typeof PALETTES)[number]['id'];

/** Same key as public/palette.js, which applies the palette before the first paint. */
const KEY = 'vgc-planner:palette';

const isPalette = (id: unknown): id is PaletteId => PALETTES.some((p) => p.id === id);

export function currentPalette(): PaletteId {
  try {
    const saved = localStorage.getItem(KEY);
    return isPalette(saved) ? saved : 'default';
  } catch { return 'default'; }
}

export function applyPalette(id: PaletteId): void {
  if (id === 'default') delete document.documentElement.dataset.palette;
  else document.documentElement.dataset.palette = id;
}

function savePalette(id: PaletteId): void {
  try {
    if (id === 'default') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, id);
  } catch { /* the palette then lasts until the page is reloaded */ }
}

/** Account menu → Theme: a swatch per palette. Picking one previews it on the whole app; Cancel puts the old one back. */
export async function openPalettePicker(): Promise<void> {
  const before = currentPalette();
  let picked: PaletteId = before;
  const tiles = PALETTES.map((p) => `<button type="button" class="palette-tile ${p.id === picked ? 'on' : ''}" data-pick="${p.id}" aria-pressed="${p.id === picked}">
      <span class="pal-swatch" data-palette="${p.id}" aria-hidden="true"><span class="me"></span><span class="opp"></span></span>
      <span class="pal-text"><span class="pal-name">${esc(p.name)}</span><span class="pal-hint">${esc(p.hint)}</span></span></button>`).join('');

  const chosen = modal<PaletteId>({
    title: 'Theme',
    desc: 'Colours for your side and the opponent’s. Saved on this device; light or dark follows your system setting.',
    body: `<div class="palette-grid" id="palette-grid" role="group" aria-label="Colour palettes">${tiles}</div>`,
    actions: [
      { label: 'Cancel', value: null },
      { label: 'Save', cls: 'primary', run: () => picked },
    ],
  });

  const grid = must('#palette-grid');
  grid.addEventListener('click', (e) => {
    const tile = e.target instanceof Element ? e.target.closest<HTMLElement>('.palette-tile') : null;
    const id = tile?.dataset.pick;
    if (!tile || !isPalette(id)) return;
    picked = id;
    applyPalette(id);
    grid.querySelectorAll('.palette-tile.on').forEach((t) => { t.classList.remove('on'); t.setAttribute('aria-pressed', 'false'); });
    tile.classList.add('on');
    tile.setAttribute('aria-pressed', 'true');
  });

  const result = await chosen;
  if (!result) { applyPalette(before); return; }
  savePalette(result);
  applyPalette(result);
  if (result !== before) toast(`Theme changed to ${PALETTES.find((p) => p.id === result)!.name}`);
}
