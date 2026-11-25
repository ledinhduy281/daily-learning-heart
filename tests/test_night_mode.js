const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const html = fs.readFileSync(require.resolve("../index.html"), "utf8");
const source = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .find(([, script]) => script.includes('const key = "ebm_color_theme";'))[1];

function start({ stored = null, prefersDark = false } = {}) {
  const handlers = {};
  const system = { matches: prefersDark, addEventListener: (event, fn) => { handlers[event] = fn; } };
  const root = { dataset: {} };
  const meta = {};
  const toggle = {
    addEventListener: (event, fn) => { handlers[event] = fn; },
    setAttribute: (key, value) => { toggle[key] = value; },
  };
  vm.runInNewContext(source, {
    window: {
      matchMedia: query => { assert.equal(query, "(prefers-color-scheme: dark)"); return system; },
      addEventListener: (event, fn) => { handlers[event] = fn; },
    },
    document: {
      documentElement: root,
      querySelector: () => meta,
      getElementById: id => { assert.equal(id, "btnNightMode"); return toggle; },
      addEventListener: (event, fn) => { handlers[event] = fn; },
    },
    localStorage: {
      getItem: key => { assert.equal(key, "ebm_color_theme"); return stored; },
      setItem: (key, value) => { assert.equal(key, "ebm_color_theme"); stored = value; },
    },
  });
  handlers.DOMContentLoaded();
  return { root, meta, toggle, system, handlers, stored: () => stored };
}

const automatic = start({ prefersDark: true });
assert.equal(automatic.root.dataset.theme, "dark");
assert.equal(automatic.toggle["aria-pressed"], "true");
automatic.system.matches = false;
automatic.handlers.change();
assert.equal(automatic.root.dataset.theme, "light");
assert.equal(automatic.meta.content, "#ffffff");
automatic.handlers.click();
assert.equal(automatic.root.dataset.theme, "dark");
assert.equal(automatic.stored(), "dark");
assert.equal(start({ stored: automatic.stored() }).root.dataset.theme, "dark");

const manual = start({ stored: "light", prefersDark: true });
assert.equal(manual.root.dataset.theme, "light");
assert.equal(manual.toggle["aria-pressed"], "false");
manual.system.matches = false;
manual.handlers.change();
manual.system.matches = true;
manual.handlers.change();
assert.equal(manual.root.dataset.theme, "light");
assert.match(html, /:root\[data-theme="dark"\] ::placeholder \{\s*color: var\(--color-ink-mute\);\s*opacity: 1;/);
console.log("Night mode system default, toggle, and persisted override: OK");
