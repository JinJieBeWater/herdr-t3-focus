// Loads list.js in a fake kit: the keys, and a list that keeps the highlight in view, by key and by wheel.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function element() {
  const node = { items: [], handlers: {}, style: {} };
  const proxy = new Proxy(node, { get(target, key) {
    if (key in target) return target[key];
    return (...args) => {
      if (key === "when") { if (args[0]) args[1](proxy); }
      else if (key === "children") node.items.push(...args[0]);
      else if (key.startsWith("on_")) node.handlers[key] = args[0];
      else if (key === "id") node.key = args[0];
      else node.style[key] = args[0];
      return proxy;
    };
  } });
  return proxy;
}

let now = 0, zoom = 2;
const src = fs.readFileSync(path.join(__dirname, "list.js"), "utf8")
  .replace(/^import .*;\r?\n/gm, "").replace(/^export (function|const) /gm, "$1 ")
  + "\nglobalThis.list = { step, menuJump, scrollList };";
const context = vm.createContext({ div: element, settings: () => ({ zoom }), Date: { now: () => now } });
vm.runInContext(src, context);
const { step, menuJump, scrollList } = context.list;

// ↑/↓ go round the ends, and with nothing lit start from one.
assert.equal(step({ key: "down" }, 2, 3), 0);
assert.equal(step({ key: "up" }, 0, 3), 2);
assert.equal(step({ key: "down" }, -1, 3), 0);
assert.equal(step({ key: "up" }, -1, 3), 2);
assert.equal(step({ key: "down" }, 0, 0), -1, "no rows");
assert.equal(step({ key: "a" }, 0, 3), -1);

// T3's Base UI menus: ↑/↓, Home, End, and typing.
{
  const v = {}, rows = ["In 1 hour", "In 3 hours", "This evening", "Tomorrow", "Custom…"];
  const type = (ch, at, more = {}) => menuJump(v, { key: ch, key_char: ch, modifiers: {}, ...more }, rows, at);
  assert.equal(menuJump(v, { key: "home" }, rows, 3), 0);
  assert.equal(menuJump(v, { key: "end" }, rows, 0), 4);
  assert.equal(menuJump(v, { key: "down" }, rows, 0), 1);
  assert.equal(menuJump(v, { key: "up" }, rows, -1), 4);
  assert.equal(menuJump(v, { key: "space", key_char: " " }, rows, 0), -1, "Space is the row's");
  assert.equal(type("a", 0, { modifiers: { platform: true } }), -1, "a chord is the app's");
  assert.equal(type("T", -1), 2, "any case, and with nothing lit from the top");
  now += 100;
  assert.equal(type("o", 2), 3, "letters in a row spell a word");
  now += 1000;
  assert.equal(type("i", 3), 0, "past 750ms it's a new word");
  now += 100;
  assert.equal(type("i", 0), 1, "the same letter steps through the rows it starts");
  now += 100;
  assert.equal(type("i", 1), 0, "and wraps");
  now += 1000;
  assert.equal(type("z", 1), -1);
}

const cx = { notify() {}, stop_propagation() { cx.stopped = true; } };
const draw = (i) => { const row = element(); row.id(i); return row; };
const shown = (list) => list.items.map((n) => [n.key, n.style.top]);

// The row keys reach stays in view with the least move, down, up and round the ends; six rows in a list of twenty.
{
  const v = {}, list = (at) => scrollList(v, "l", { count: 20, row: 10, at, height: 60, draw, wheeled() {} });
  assert.equal(list(0).style.h, 60, "a height known is the list's");
  assert.deepEqual(shown(list(0)).at(-1), [5, 50]);
  assert.deepEqual(shown(list(5))[0], [0, 0], "in view: no move");
  assert.deepEqual(shown(list(6))[0], [1, 0], "past the bottom: just far enough");
  assert.deepEqual(shown(list(6)).at(-1), [6, 50]);
  assert.deepEqual(shown(list(3))[0], [1, 0]);
  assert.deepEqual(shown(list(0))[0], [0, 0], "past the top: to the top");
  assert.deepEqual(shown(list(19)).at(-1), [19, 50], "up from the first, round to the last");
  assert.deepEqual(shown(list(19)).length, 6);
  assert.deepEqual(shown(list(0))[0], [0, 0], "down from the last, round to the first");
  assert.deepEqual(shown(list(25)).length, 6, "a row since gone doesn't scroll it past the end");
}

// Not known, it's measured, in zoomed pixels: every row until then, none scrolled.
{
  const v = {}, list = () => scrollList(v, "l", { count: 20, row: 10, at: 9, draw, wheeled() {} });
  assert.equal(list().items.length, 20);
  list().handlers.on_size_change({ height: 40 * zoom }, cx);
  assert.deepEqual(shown(list()).map((r) => r[0]), [6, 7, 8, 9]);
}

// The wheel, two events before the next render as a trackpad sends them, takes the highlight along; none lit stays none.
{
  const v = {}, keeps = [], list = (at) => scrollList(v, "l", { count: 20, row: 10, at, height: 40, draw, wheeled: (keep) => keeps.push(keep) });
  const wheel = list(0);
  for (let i = 0; i < 2; i++) wheel.handlers.on_scroll_wheel({ delta: { y: -15 * zoom } }, cx);
  assert.deepEqual(keeps.splice(0), [2, 3], "the nearest row wholly in view");
  assert.deepEqual(shown(list(3))[0], [3, 0]);
  const up = list(3);
  up.handlers.on_scroll_wheel({ delta: { y: 10 * zoom } }, cx);
  assert.deepEqual(keeps.splice(0), [3], "a row still in view stays lit");
  list(-1).handlers.on_scroll_wheel({ delta: { y: 10 * zoom } }, cx);
  assert.deepEqual(keeps.splice(0), [-1]);
  cx.stopped = false;
  const end = scrollList({}, "l", { count: 2, row: 10, at: 0, height: 40, draw, wheeled: () => keeps.push("moved") });
  end.handlers.on_scroll_wheel({ delta: { y: 10 } }, cx);
  assert.deepEqual([cx.stopped, keeps], [true, []], "nothing to scroll: still not what's under the popup's");
}

console.log("ok: list: ↑/↓ round the ends, Home, End and typing, the highlight kept in view by key and wheel.");
