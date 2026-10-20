# Screenshot harness

Renders the real WFM App pages with synthetic data, without Google access.

```bash
npm install                      # @fontsource/plus-jakarta-sans (the app's font, served locally)
node make-data.js ../../src/backend           # runs the app's own aggregation functions on synthetic rows
node build-page.js ../../src/backend dash-voyce   # page: todo | tickets | assistant | reporting | dash-voyce | dash-adherence | dash-mvcc
node capture.js "$PWD/out/page-dash-voyce.html" "$PWD/voyce.png" '[{"wait":2500}]' 1440 900 light
# full-length (whole scrolling panel), dark mode:
node capture.js "$PWD/out/page-dash-voyce.html" "$PWD/voyce-full-dark.png" '[{"wait":2500}]' 1440 900 dark 1
```

Requires Playwright with Chromium. `capture.js` loads Playwright from `/opt/npm-tools/node_modules/playwright`; change that path or `npm i playwright` for your machine.

- `gas-sandbox.js` – loads the backend `.js` files into a Node VM with a minimal stand-in for `Utilities`, `PropertiesService`, `CacheService`, `LockService`, `Session`. Only pure functions are called.
- `make-data.js` – synthetic raw rows (fictional names, `@example.com` emails) → real `*_aggregate_` functions → `mock-data.json`.
- `build-page.js` – assembles `Index.html` like `HtmlService` (only Index is a template; included files are raw) and stubs `google.script.run`. Optional `CLIENT_NAME=<name>` replaces a client name in the rendered text.
- `capture.js` – headless Chromium screenshot; supports `wait`, `js` and `clickText` steps.
