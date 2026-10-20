/*
 * content.js — the bridge between the WFM App page and the connector (runs in the App's Apps Script frame).
 * The page posts { __wfmNice: 1, dir: 'page', type, id, job } to its own window; replies go back the same way
 * with dir: 'ext'. Only messages from the same window are accepted. NICE data never passes through any server.
 */
(function () {
  'use strict';
  if (window.__wfmNiceBridge) return;
  window.__wfmNiceBridge = true;
  var VERSION = chrome.runtime.getManifest().version, ports = {};
  var CAPS = ['nice-report', 'nice-fetch', 'nice-extract', 'templates', 'steps', 'binary', 'batch', 'codes'];
  function reply(m) { m.__wfmNice = 1; m.dir = 'ext'; window.postMessage(m, '*'); }
  // Apps Script writes the app into its frame with document.open()/write(), which erases every listener on the
  // window (including this one). Re-attaching the same function is a no-op while it is still there, so a short
  // interval makes the bridge survive that rewrite.
  function attach() { window.addEventListener('message', onMessage); }
  attach();
  setInterval(attach, 250);
  function onMessage(e) {
    var d = e.data;
    if (e.source !== window || !d || d.__wfmNice !== 1 || d.dir !== 'page' || typeof d.id !== 'string') return;
    if (d.type === 'hello') { reply({ type: 'ready', id: d.id, version: VERSION, caps: CAPS }); return; }
    if (d.type === 'cancel') { if (ports[d.id]) ports[d.id].postMessage({ type: 'cancel' }); return; }
    if (d.type !== 'run' || ports[d.id]) return;
    var done = false, port;
    try { port = chrome.runtime.connect({ name: 'wfm-nice' }); }
    catch (err) { reply({ type: 'error', id: d.id, stage: 'connector', message: 'The WFM NICE Connector was updated or reloaded. Reload this page and try again.' }); return; }
    ports[d.id] = port;
    port.onMessage.addListener(function (m) {
      var out = {}; Object.keys(m).forEach(function (k) { out[k] = m[k]; }); out.id = d.id;      // pass everything through (csv, base64, rows, code, …)
      if (m.type === 'progress') { reply(out); return; }
      done = true; delete ports[d.id];
      if (m.type !== 'result') { out.type = 'error'; out.stage = m.stage || 'nice'; out.message = m.message || 'The connector stopped.'; }
      reply(out);
      try { port.disconnect(); } catch (ignore) {}
    });
    port.onDisconnect.addListener(function () {
      if (!done) reply({ type: 'error', id: d.id, stage: 'connector', code: 'INTERNAL', message: 'The connector stopped unexpectedly (was it updated or the browser closed?). Nothing was changed.' });
      delete ports[d.id];
    });
    port.postMessage(d.jobs ? { type: 'run', jobs: d.jobs } : { type: 'run', job: d.job });
  }
})();
