// Assembles the real Index.html the way HtmlService does (resolving <?!= include_('X') ?> and <?!= bootJson ?>),
// then puts a mock google.script.run in front of it that answers from mock-data.json (synthetic data).
// Client branding is neutralised in the rendered text only (source files are never modified).
const fs = require('fs');
const path = require('path');
const SRC = process.argv[2] || '../../src/backend';
const page = process.argv[3] || 'todo';
const OUT = process.argv[4] || path.join(__dirname, 'out', 'page-' + page + '.html');

const read = n => fs.readFileSync(path.join(SRC, n + '.html'), 'utf8');
// Like HtmlService: only Index.html is a template. include_() returns each file's RAW content
// (createHtmlOutputFromFile does not evaluate scriptlets), so included files are not processed.
const boot = JSON.stringify({ page, ticketKey: '', todoDate: '', todoShift: '', todoTask: '' });
let html = read('Index').replace(/<\?!=\s*(include_\('([^']+)'\)|bootJson)\s*\?>/g, (m, expr, name) => {
  if (expr === 'bootJson') return boot;
  if (name === 'ApiShim') return '';                   // the shim is for the two-project deployment; not needed here
  return read(name);
});

// neutral branding for screenshots
// CLIENT_NAME=<name> neutralises a client name in the rendered text (e.g. the app title).
const CLIENT = process.env.CLIENT_NAME || '';
if (CLIENT) {
  const esc = CLIENT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  html = html.replace(new RegExp(esc + ' WFM App', 'gi'), 'WFM Operations App').replace(new RegExp('\\b' + esc + '\\b', 'g'), 'Client');
}

const data = fs.readFileSync(path.join(__dirname, 'mock-data.json'), 'utf8');
const mock = `<script>
(function(){
  var DATA = ${data};
  window.__unknownCalls = [];
  function runner(ok, fail){
    return new Proxy({}, { get: function(t, p){
      if (p === 'withSuccessHandler') return function(f){ return runner(f, fail); };
      if (p === 'withFailureHandler') return function(f){ return runner(ok, f); };
      if (p === 'withUserObject') return function(){ return runner(ok, fail); };
      if (typeof p !== 'string') return undefined;
      return function(){
        var has = Object.prototype.hasOwnProperty.call(DATA, p);
        if (!has) window.__unknownCalls.push(p);
        var val = has ? JSON.parse(JSON.stringify(DATA[p])) : null;
        setTimeout(function(){ if (ok) ok(val); }, 60);
      };
    }});
  }
  window.google = { script: { run: runner(null, null), history: { push: function(){}, replace: function(){}, setChangeHandler: function(){} },
                              host: { close: function(){}, setHeight: function(){}, origin: '' }, url: { getLocation: function(cb){ cb({ parameter: {}, hash: '' }); } } } };
})();
</script>`;
html = html.replace(/<head([^>]*)>/i, m => m + mock);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html);
console.log('wrote', OUT, (html.length / 1024).toFixed(0) + ' KB');
