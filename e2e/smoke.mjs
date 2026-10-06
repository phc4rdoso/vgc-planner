/**
 * End-to-end smoke test: drives the real app in Chromium.
 *
 *   npm run build && npm run preview &        # serves http://localhost:4173
 *   npx playwright install chromium           # once
 *   npm run test:e2e                          # BASE_URL=... to test another host
 *
 * It covers: creating a team and a gameplan, picking leads, editing a turn, turn results from the real
 * damage calculator (needs the app to be able to load it), export, reload persistence and import.
 * It also fails on any console error, which includes Content-Security-Policy violations.
 */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:4173';

const mine = `Rillaboom
Ability: Grassy Surge
EVs: 32 HP / 32 Atk / 2 Spe
Adamant Nature
- Fake Out

Garchomp
Ability: Rough Skin
EVs: 2 HP / 32 Atk / 32 Spe
Adamant Nature
- Earthquake`;
const theirs = `Incineroar
Ability: Intimidate
EVs: 32 HP / 32 Atk / 2 Spe
Adamant Nature
- Flare Blitz

Kingambit
Ability: Defiant
EVs: 32 HP / 32 Atk / 2 Spe
Adamant Nature
- Protect`;

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1700, height: 1000 } })).newPage();
const problems = [];
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push(`console: ${m.text()}`); });
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

try {
  await page.goto(BASE_URL);
  await page.waitForSelector('.empty h2');

  // team
  await page.click('.empty button[data-act="new-team"]');
  await page.fill('#nt-name', 'Rain offense');
  await page.fill('#nt-paste', mine);
  await page.click('.modal-foot .btn.primary');
  await page.waitForSelector('#team-name');
  assert.match(await page.textContent('.mon-grid'), /SP 32 HP \/ 32 Atk \/ 2 Spe/);

  // gameplan
  await page.click('.section-head button[data-act="new-plan"]');
  await page.fill('#np-name', 'Intimidate balance');
  await page.fill('#np-paste', theirs);
  await page.click('.modal-foot .btn.primary');
  await page.waitForSelector('#canvas');

  const pick = async (side, kind, i, name) => {
    await page.click(`[data-act="pick-slot"][data-side="${side}"][data-kind="${kind}"][data-i="${i}"]`);
    await page.click(`#ctx-menu button:has-text("${name}")`);
  };
  await pick('me', 'lead', 0, 'Rillaboom'); await pick('me', 'lead', 1, 'Garchomp');
  await pick('opp', 'lead', 0, 'Incineroar'); await pick('opp', 'lead', 1, 'Kingambit');

  // turn 1
  await page.click('.addbox.first');
  await page.waitForSelector('#drawer:not(.hidden)');
  assert.equal(await page.locator('.act-edit').count(), 4, 'a new turn is seeded with the four leads');
  await page.fill('#a-move-0', 'Fake Out'); await page.selectOption('#a-target-0', 'Incineroar');
  await page.fill('#a-move-1', 'Earthquake'); await page.selectOption('#a-target-1', 'Both foes');
  await page.fill('#a-move-2', 'Flare Blitz'); await page.selectOption('#a-target-2', 'Rillaboom');
  await page.fill('#a-move-3', 'Protect');
  await page.waitForSelector('.turn-result .hp-row', { timeout: 30_000 }); // first run downloads the calculator
  assert.match(await page.textContent('.turn-result'), /End of turn/);
  await page.click('.rerun');
  await page.waitForSelector('.turn-result .hp-row');

  // branch
  await page.click('[data-act="add-branch-child"]');
  await page.fill('[data-f="condition"]', 'If Incineroar Protects');
  assert.equal(await page.locator('.turn').count(), 2);

  // export, reload, import
  await page.click('.topbar [data-act="export-plan"]');
  const exported = await page.inputValue('#exp');
  assert.equal(JSON.parse(exported).format, 'vgc-gameplan-planner');
  await page.click('.modal-foot .btn:has-text("Close")');

  await page.waitForTimeout(500); // saving is debounced
  await page.reload();
  await page.waitForSelector('#canvas');
  assert.equal(await page.locator('.turn').count(), 2, 'turns survive a reload');

  await page.click('.side-foot [data-act="import"]');
  await page.fill('#imp-text', exported);
  await page.click('.modal-foot .btn.primary');
  await page.waitForSelector('.toast');
  assert.match(await page.textContent('.toast'), /Imported 0 new teams and 1 gameplan/);

  assert.deepEqual(problems, [], 'no console errors or CSP violations');
  console.log('E2E OK');
} catch (error) {
  await page.screenshot({ path: 'e2e-failure.png' });
  console.error('E2E failed; screenshot saved to e2e-failure.png');
  throw error;
} finally {
  await browser.close();
}
