// Renders assembled pages in headless Chromium and saves screenshots.
// usage: node capture.js <page.html> <out.png> [actionsJson] [width] [height] [theme]
const { chromium } = require(process.env.PLAYWRIGHT_PATH || '/opt/npm-tools/node_modules/playwright');
(async () => {
  const [file, outPng, actions = '[]', w = '1440', h = '900', theme = 'light', full = '0'] = process.argv.slice(2);
  const browser = await chromium.launch({ executablePath: undefined });
  const ctx = await browser.newContext({ viewport: { width: +w, height: +h }, deviceScaleFactor: 2, colorScheme: theme });
  const pg = await ctx.newPage();
  const logs = [];
  pg.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') logs.push(m.type() + ': ' + m.text()); });
  pg.on('pageerror', e => logs.push('pageerror: ' + e.message));
  // The app keeps its theme in localStorage ('wfm-ops-theme'); 'lite' turns off background animation for stable captures.
  await pg.addInitScript(t => { try { localStorage.setItem('wfm-ops-theme', t); localStorage.setItem('wfm-ops-fx', 'lite'); } catch (e) {} }, theme);
  // Serve the same Google Font (Plus Jakarta Sans) from the local @fontsource copy (the sandbox has no access to Google Fonts).
  const fdir = __dirname + '/node_modules/@fontsource/plus-jakarta-sans/files/';
  const css = [400, 500, 600, 700, 800].map(w => `@font-face{font-family:'Plus Jakarta Sans';font-style:normal;font-weight:${w};font-display:block;src:url(file://${fdir}plus-jakarta-sans-latin-${w}-normal.woff2) format('woff2');}`).join('\n');
  await pg.route(/fonts\.googleapis\.com\/css2/, r => r.fulfill({ status: 200, contentType: 'text/css', body: css }));
  await pg.route(/fonts\.gstatic\.com|fonts\.googleapis\.com\/?$/, r => r.abort());
  await pg.goto('file://' + file);
  await pg.waitForTimeout(1500);
  for (const a of JSON.parse(actions)) {
    if (a.js) await pg.evaluate(a.js);
    if (a.clickText) {
      const ok = await pg.evaluate(t => {
        const el = [...document.querySelectorAll('button,[role=tab],a,div,span,td,tr')].reverse()
          .find(e => e.offsetParent && e.textContent.trim() === t);
        if (el) el.click();
        return !!el;
      }, a.clickText);
      if (!ok) logs.push('clickText not found: ' + a.clickText);
    }
    if (a.click) await pg.click(a.click, { timeout: 5000 }).catch(e => logs.push('click failed ' + a.click + ': ' + e.message.split('\n')[0]));
    await pg.waitForTimeout(a.wait || 900);
  }
  if (full === '1') {
    // The app scrolls inside its main panel, not the document: grow the viewport to that panel's full height.
    const h = await pg.evaluate(() => {
      let best = null;
      document.querySelectorAll('*').forEach(el => {
        const cs = getComputedStyle(el);
        if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 20 && (!best || el.scrollHeight > best.scrollHeight)) best = el;
      });
      return best ? Math.ceil(best.getBoundingClientRect().top + best.scrollHeight + 8) : document.documentElement.scrollHeight;
    });
    await pg.setViewportSize({ width: +w, height: Math.min(h, 12000) });
    await pg.waitForTimeout(1500);
  }
  await pg.screenshot({ path: outPng, fullPage: full === '1' });
  const unknown = await pg.evaluate(() => window.__unknownCalls);
  console.log(JSON.stringify({ out: outPng, unknownCalls: [...new Set(unknown)], logs: logs.slice(0, 15) }, null, 1));
  await browser.close();
})();
