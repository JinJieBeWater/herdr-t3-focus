// Loads focus.js in a fake kit: nothing's a stop or listens outside keyboard mode, the ring, the mode's end.
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
      else if (key === "child") node.items.push(args[0]);
      else if (key === "on_mouse_down") node.handlers[`${key}:${args[0]}`] = args[1];
      else if (key.startsWith("on_")) node.handlers[key] = args[0];
      else node.style[key] = args.length === 1 ? args[0] : args;
      return proxy;
    };
  } });
  return proxy;
}

const state = {};
let holding = null, now = 0;
const FakeDate = { now: () => now };
const src = fs.readFileSync(path.join(__dirname, "focus.js"), "utf8")
  .replace(/^import .*;\r?\n/gm, "").replace(/^export (function|const) /gm, "$1 ")
  + "\nglobalThis.focus = { stopsInit, stopsEnd, stop, focusRoot, onStop, within, enter };";
const context = vm.createContext({ div: element, shared: (k) => state[k], setShared: (k, v) => { state[k] = v; }, Date: FakeDate });
vm.runInContext(src, context);
const { stopsInit, stopsEnd, stop, focusRoot, onStop, within, enter } = context.focus;

function fakeCx() {
  const cx = { notified: 0, ticks: [], notify() { cx.notified++; }, stop_propagation() {} };
  cx.focus_handle = () => { const h = { focus() { holding = h; }, is_focused: () => holding === h }; return h; };
  cx.timer = { every(_ms, fn) { const task = { fn, gone: false, cancel() { task.gone = true; } }; cx.ticks.push(task); return task; } };
  cx.tick = () => cx.ticks.filter((task) => !task.gone).forEach((task) => task.fn(cx));
  return cx;
}
const t = { accent: "#accent" };
const ringOf = (el) => el.items.find((child) => child.style.border === 2);
const view = (kind) => { const v = {}, cx = fakeCx(); stopsInit(v, cx, kind); return { v, cx }; };

// Mode off: a press can't take the keyboard and no key is heard, the pointer's window as it was.
{
  const { v } = view();
  const el = stop(v, t, "a", element());
  assert.equal(el.style.track_focus, undefined);
  assert.equal(el.style.tab_index, undefined);
  const root = focusRoot(v, element());
  assert.deepEqual(Object.keys(root.handlers), []);
  assert.equal(within(v, ["a"]), false);
}

// A crash's mode doesn't outlive the restart: the run's first copy clears it, of any kind. One starting later (Lists, first shown by
// a key in the mode) must not: that mode is someone's.
{
  context.t3FocusRun = false;
  state["t3-focus"] = "old";
  view();
  assert.equal(state["t3-focus"], null);
  state["t3-focus"] = "live";
  view();
  view("modal");
  assert.equal(state["t3-focus"], "live");
  state["t3-focus"] = null;
}

// A mode nothing's walking (its owner went without a close): a stop's press ends it, so next frame it isn't a stop and Herdr gives the
// keyboard back. An owner's own press, or an overlay's, is the walk's business.
{
  const { v } = view();
  state["t3-focus"] = "old";
  const el = stop(v, t, "a", element());
  assert.equal(el.style.tab_index, 0);
  el.handlers["on_mouse_down:left"]({}, fakeCx());
  assert.equal(state["t3-focus"], null);
  assert.equal(stop(v, t, "a", element()).style.tab_index, undefined);
  const owner = view();
  enter(owner.v, owner.cx, "first");
  stop(owner.v, t, "first", element()).handlers["on_mouse_down:left"]({}, owner.cx);
  assert.equal(state["t3-focus"], owner.v.fs.me);
  assert.equal(stop(view("modal").v, t, "save", element()).handlers["on_mouse_down:left"], undefined);
  state["t3-focus"] = null;
  holding = null;
}

// pane.go lands: the mode's on, the first stop has the keyboard, 2px and inset, in accent; only the stop it's on.
const a = view(), b = view();
{
  enter(a.v, a.cx, "first");
  assert.ok(state["t3-focus"]);
  const first = stop(a.v, t, "first", element(), 8), second = stop(a.v, t, "second", element());
  assert.equal(first.style.tab_index, 0, "as T3's rows, every stop is in the order: no roving");
  assert.equal(holding, first.style.track_focus);
  const ring = ringOf(first);
  assert.deepEqual([ring.style.absolute, ring.style.border, ring.style.border_color, ring.style.rounded], [[], 2, "#accent", 8]);
  assert.deepEqual(ring.handlers, {}, "the ring hears no pointer");
  assert.equal(ringOf(second), undefined);
  assert.equal(onStop(a.v), "first");
  assert.ok(within(a.v, ["x", "first"]));
}

// Tab lands in this mod: only its release is heard, and it moves the ring. Other keys don't.
{
  const root = focusRoot(a.v, element());
  a.v.fs.handles.get("second").focus();
  const seen = a.cx.notified;
  root.handlers.on_key_up({ key: "a" }, a.cx);
  assert.equal(a.cx.notified, seen);
  root.handlers.on_key_up({ key: "tab" }, a.cx);
  assert.equal(a.cx.notified, seen + 1);
  assert.ok(ringOf(stop(a.v, t, "second", element())));
  assert.equal(ringOf(stop(a.v, t, "first", element())), undefined);
  // A press ends the ring, as focus-visible does; the keyboard stays where it is until something takes it.
  root.handlers["on_mouse_down:left"]({}, a.cx);
  assert.equal(ringOf(stop(a.v, t, "second", element())), undefined);
  assert.equal(within(a.v, ["second"]), false);
  root.handlers.on_key_up({ key: "tab" }, a.cx);
  assert.ok(ringOf(stop(a.v, t, "second", element())), "Tab brings it back");
}

// Enter on a stop with `enter`: its own key, not a key on a control inside it.
{
  let acted = 0;
  const row = stop(a.v, t, "second", element(), 6, { enter: () => acted++ });
  row.handlers.on_key_down({ keystroke: "cmd-enter" }, a.cx);
  assert.equal(acted, 0);
  row.handlers.on_key_down({ keystroke: "space" }, a.cx);
  assert.equal(acted, 1);
  holding = null;
  row.handlers.on_key_down({ keystroke: "enter" }, a.cx);
  assert.equal(acted, 1);
  a.v.fs.handles.get("second").focus();
}

// Tab lands in another mod: it takes the mode over, and the one left stops ringing and drops out without ending it.
{
  stop(b.v, t, "other", element());
  b.v.fs.handles.get("other").focus();
  focusRoot(b.v, element()).handlers.on_key_up({ key: "tab" }, b.cx);
  assert.equal(state["t3-focus"], b.v.fs.me);
  const seen = a.cx.notified;
  a.cx.tick();
  assert.equal(a.cx.notified, seen + 1, "the ring it left comes off by the next tick");
  for (let i = 0; i < 3; i++) a.cx.tick();
  assert.equal(a.v.fs.watch, null);
  assert.equal(state["t3-focus"], b.v.fs.me);
}

// The keyboard leaves every stop (a terminal took it): the mode ends, not on the first look, and the handles go back to the pool.
{
  const before = b.v.fs.free.length;
  holding = null;
  b.cx.tick();
  b.cx.tick();
  assert.ok(state["t3-focus"], "a tick isn't enough: the mod Tab landed in may not have spoken yet");
  b.cx.tick();
  assert.equal(state["t3-focus"], null);
  assert.equal(b.v.fs.keyboard, false);
  focusRoot(b.v, element());
  assert.equal(b.v.fs.handles.size, 0);
  assert.equal(b.v.fs.free.length, before + 1);
}

// The mode's owner closes (Enter on a pane's ×): its timers go with it, so its close ends the mode; another's stays.
{
  const owner = view(), other = view();
  enter(owner.v, owner.cx, "first");
  stopsEnd(other.v);
  assert.equal(state["t3-focus"], owner.v.fs.me);
  stopsEnd(owner.v);
  assert.equal(state["t3-focus"], null);
  holding = null;
}

// A menu of the mod's own holds the mode while the keyboard's in it, and back on its stop afterwards the ring's there.
{
  const { v, cx } = view();
  let open = true;
  v.fs.hold = () => open;
  enter(v, cx, "first");
  stop(v, t, "first", element());
  holding = null;
  for (let i = 0; i < 5; i++) cx.tick();
  assert.ok(state["t3-focus"]);
  open = false;
  for (let i = 0; i < 3; i++) cx.tick();
  assert.equal(state["t3-focus"], null);
  // Back by pane.go: the stop it left, once. One gone from the list loses the keyboard, and the next try starts at `first`.
  v.fs.last = "gone";
  enter(v, cx, "first");
  assert.equal(v.fs.handles.get("gone"), holding);
  assert.equal(v.fs.last, null);
  enter(v, cx, "first");
  assert.equal(v.fs.handles.get("first"), holding);
  holding = null;
  for (let i = 0; i < 3; i++) cx.tick();
}

// An overlay's copy: stops always up, with no mode of its own to start or end.
{
  const { v, cx } = view("modal");
  const el = stop(v, t, "save", element());
  assert.equal(el.style.tab_index, 0);
  el.style.track_focus.focus();
  focusRoot(v, element()).handlers.on_key_up({ key: "tab" }, cx);
  assert.ok(ringOf(stop(v, t, "save", element())));
  assert.equal(state["t3-focus"], null);
  // Tab onto one of the overlay's inputs: no stop's lit.
  holding = {};
  focusRoot(v, element()).handlers.on_key_up({ key: "tab" }, cx);
  assert.equal(v.fs.keyboard, false);
  // A stop with a handle of its own (the kit's Select) is that handle.
  const own = cx.focus_handle();
  assert.equal(stop(v, t, "unit", element(), 6, { handle: own }).style.track_focus, own);
}

// A handle can't be made in render: past the pool a row just isn't a stop, and Tab landing tops the pool up.
{
  const { v, cx } = view("modal");
  for (let i = 0; i < 64; i++) stop(v, t, `row-${i}`, element());
  assert.equal(stop(v, t, "one-more", element()).style.tab_index, undefined);
  v.fs.handles.get("row-0").focus();
  focusRoot(v, element()).handlers.on_key_up({ key: "tab" }, cx);
  assert.equal(stop(v, t, "one-more", element()).style.tab_index, 0);
  holding = null;
}

console.log("ok: focus: stops only in keyboard mode, the ring, Tab across mods, the mode's end.");
