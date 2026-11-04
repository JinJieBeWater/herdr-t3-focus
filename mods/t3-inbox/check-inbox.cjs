const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

function element() {
  const node = { key: null, items: [], handlers: {}, style: {} };
  const proxy = new Proxy(node, { get(target, key) {
    if (key in target) return target[key];
    return (...args) => {
      if (key === "when") { if (args[0]) args[1](proxy); }
      else if (["child", "content", "trigger"].includes(key)) node.items.push(args[0]);
      else if (key === "children") node.items.push(...args[0]);
      else if (key === "id") node.key = args[0];
      else if (key === "on_mouse_down" || key === "on_mouse_up") node.handlers[`${key}:${args[0]}`] = args[1];
      else if (key.startsWith("on_")) node.handlers[key] = args[0];
      else node.style[key] = args;
      return proxy;
    };
  } });
  return proxy;
}

function find(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.key === id) return node;
  for (const child of node.items) { const hit = find(child, id); if (hit) return hit; }
  return null;
}

function cards(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (node.key?.startsWith("card-")) out.push(node.key.slice(5));
  else for (const child of node.items) cards(child, out);
  return out;
}

function texts(node) {
  if (typeof node === "string") return [node];
  return node && typeof node === "object" ? node.items.flatMap(texts) : [];
}

// The element whose own child is this text: a card's title, or its branch line.
function holding(node, text) {
  if (!node || typeof node !== "object") return null;
  if (node.items.includes(text)) return node;
  for (const child of node.items) { const hit = holding(child, text); if (hit) return hit; }
  return null;
}

// The row that element sits in.
function lineOf(node, text) {
  if (!node || typeof node !== "object") return null;
  if (node.items.some((child) => child?.items?.includes(text))) return node;
  for (const child of node.items) { const hit = lineOf(child, text); if (hit) return hit; }
  return null;
}

function fixture() {
  const f = { now: 1000, rows: [], terms: [], order: [], calls: [], jobs: [], timers: [], data: new Map(), pins: [], mode: "inbox", notifications: [], state: {} };
  const cx = {
    notify() { f.notified = true; }, stop_propagation() {},
    focus_handle: () => ({ focus() { f.keys = true; } }),
    spawn: (fn) => f.jobs.push(fn),
    timer: {
      every: () => ({}),
      after(ms, fn) {
        const timer = { at: f.now + ms, fn, cancelled: false, cancel() { this.cancelled = true; } };
        f.timers.push(timer);
        return timer;
      },
    },
  };
  const env = {
    View: class {}, div: element, image: (src) => { const e = element(); e.style.image = [src]; return e; }, svg: element, v_flex: element, h_flex: element,
    Popover: { new: element }, HoverCard: { new: element }, Popup: { new: element }, Input: { new: element }, Button: { new: element },
    InputState: { new: () => ({ on() {}, value: () => "", set_value() {}, focus() {} }) },
    namer: () => (a) => a.address, Date: { now: () => f.now },
    localStorage: { getItem: (k) => f.data.get(k) ?? null, setItem: (k, v) => f.data.set(k, v) },
    keys: () => [], agents: () => f.rows, terminals: () => f.terms, panes: () => [],
    spaces: () => [{ id: "s1", name: "One", tabs: [] }, { id: "s2", name: "Two", tabs: [] }],
    focused: () => ({ agent: f.rows.find((a) => a.focused)?.address }),
    theme: () => ({}), settings: () => ({}), props: () => ({}),
    layout: () => ({ id: "sidebar-lists", active: f.mode }),
    shared: (k) => k === "agents.pins" ? f.pins : f.state[k] ?? null,
    setShared: (k, v) => { if (k === "agents.pins") f.pins = Array.from(v); else f.state[k] = v; },
    setAgentOrder: (xs) => { f.order = Array.from(xs); },
    run: (...args) => f.calls.push(args), notify: (n) => f.notifications.push(n), openOverlay() {}, closeOverlay() {},
    hc: async () => ({ code: 0 }), nextCommand: () => new Promise(() => {}),
  };
  // tree.js, project.js, tip.js and details.js, the shared status, space-mark, hover-label and details rules, are inlined as each mod's own copies are.
  const tree = ["tree.js", "project.js", "tip.js", "details.js"].map((file) => fs.readFileSync(path.join(__dirname, file), "utf8")).join("\n")
    .replace(/^import .*;\r?\n/gm, "").replace(/export (function|const) /g, "$1 ");
  const src = tree + fs.readFileSync(path.join(__dirname, "main.js"), "utf8")
    .replace(/^import .*;\r?\n/gm, "").replace("export default class", "globalThis.Mod = class");
  const context = vm.createContext(env);
  vm.runInContext(src, context, { filename: "t3-inbox/main.js" });
  f.context = context;
  f.mod = new context.Mod(); f.mod.init({}, cx);
  f.loadAgents = () => {
    const src = tree + fs.readFileSync(path.join(__dirname, "../t3-agents/main.js"), "utf8")
      .replace(/^import .*;\r?\n/gm, "").replace("export default class", "globalThis.Mod = class");
    const context = vm.createContext({ ...env });
    vm.runInContext(src, context);
    const mod = new context.Mod(); mod.init({});
    return () => mod.render(cx);
  };
  f.add = (address, status = "idle", ms = 100) => {
    const row = { address, status, seq: f.rows.length + 1, space: "s1", space_name: "One", pane: address, program: {}, focused: false };
    f.rows.push(row);
    f.terms.push({ address, status, status_ms: ms, state: "live", turn: 0, labels: {} });
    return row;
  };
  f.render = (now = f.now) => {
    f.now = now;
    for (const timer of f.timers) if (!timer.cancelled && timer.at <= now) { timer.cancel(); timer.fn(cx); }
    f.tree = f.mod.render(cx);
    return f.tree;
  };
  f.working = () => cards(find(f.tree, "shelves"));
  f.active = () => cards(find(f.tree, "inbox-list")).filter((a) => !f.working().includes(a) && !f.pins.includes(a));
  f.event = (id, name, e = {}) => {
    const node = find(f.tree, id);
    assert.ok(node, `missing ${id}`);
    assert.ok(node.handlers[name], `missing ${name} on ${id}`);
    node.handlers[name]({ position: { x: 20, y: 100 }, local_position: { x: 20, y: 100 }, bounds: { height: 82 }, modifiers: {}, ...e }, cx);
  };
  f.settle = () => f.mod.settleKey(cx);
  f.cx = cx;
  f.env = env;
  return f;
}

test("a quick continuation keeps its Working place, showing its real state meanwhile", () => {
  const f = fixture(), a = f.add("A", "working", 100); f.add("B", "working", 200); f.mod.workOpen = true;
  f.render(); assert.deepEqual(f.working(), ["B", "A"]);
  a.status = "done"; f.render(1100);
  assert.deepEqual(f.working(), ["B", "A"]);
  assert.ok(texts(find(f.tree, "state-A")).includes("Done"));
  a.status = "working"; f.render(1300);
  assert.deepEqual(f.working(), ["B", "A"]);
});

test("a finished run moves to Active once the grace is out; blocked moves at once", () => {
  const f = fixture(), a = f.add("A", "working"), b = f.add("B", "working"); f.mod.workOpen = true;
  f.render(); a.status = "idle"; f.render(1100);
  f.terms[0].turn++; f.render(2000); // the turn's end arriving late doesn't restart the grace
  f.render(3099); assert.deepEqual(f.working(), ["A", "B"]);
  assert.ok(f.timers.some((t) => !t.cancelled && t.at === 3100)); // on time, not on the next second's tick
  f.render(3100); assert.deepEqual(f.active(), ["A"]);
  b.status = "blocked"; f.render(3200); assert.deepEqual(f.active(), ["B", "A"]);
  f.terms.push({ address: "kid", parent: "A", state: "live", status: "error" });
  a.status = "working"; f.render(3300); assert.deepEqual(f.active(), ["A", "B"]);
});

test("a failed turn needs the person: the terminal's error, which agents() can't say", () => {
  const f = fixture(); f.add("A", "done"); f.add("B", "done");
  f.terms[0].status = "error";
  f.render();
  assert.ok(texts(find(f.tree, "state-A")).includes("Needs you"));
  assert.ok(texts(find(f.tree, "state-B")).includes("Done"));
  // A sub-agent with its own pane is in agents() too, where its error reads as something else.
  f.add("kid", "done"); f.terms.at(-1).parent = "B"; f.terms.at(-1).status = "error";
  f.render();
  assert.ok(texts(find(f.tree, "state-B")).includes("Needs you"));
});

test("looking, seq and data order don't reshuffle; equal times go by address", () => {
  const f = fixture(), a = f.add("B", "done"); f.add("A", "done");
  f.render(); assert.deepEqual(f.order, ["A", "B"]);
  a.status = "idle"; a.focused = true; a.seq = 99; f.rows.reverse(); f.render(1500);
  assert.deepEqual(f.order, ["A", "B"]);
  for (const k of f.terms) k.labels.settled = "500:0";
  f.render(1600); f.rows.reverse(); f.render(1700); assert.deepEqual(f.order, ["A", "B"]);
});

test("a short absence and a restart keep each agent's place", () => {
  const f = fixture(), a = f.add("A", "working"), b = f.add("B"), c = f.add("C", "idle", 1500);
  f.render(1600); a.status = "done"; f.render(2000); f.render(4100);
  assert.deepEqual(f.order, ["A", "C", "B"]);
  f.rows = [b, c]; b.status = "working"; f.render(4200);
  f.rows = [a, b, c]; f.render(4300); assert.deepEqual(f.order, ["A", "C", "B"]);
  const g = fixture(); g.data = f.data; g.rows = f.rows; g.terms = f.terms; g.mod.init({}, g.cx);
  g.render(4400); assert.deepEqual(g.order, f.order);
  f.terms[0].state = "exited"; f.rows = [b, c]; c.status = "working"; f.render(4500);
  assert.equal(f.mod.changed.A, undefined);
});

test("a turn that ended unseen is news; unsettling doesn't land on Working", () => {
  const f = fixture(), a = f.add("A", "idle", 200); f.add("B", "idle", 100);
  f.render(); assert.deepEqual(f.order, ["A", "B"]);
  f.terms[1].turn++; f.render(1500); assert.deepEqual(f.order, ["B", "A"]);
  f.terms[0].labels.settled = "1000:0"; f.render(1600);
  a.focused = true; f.settle(); f.render(1700);
  assert.deepEqual(f.working(), []); assert.deepEqual(f.order, ["A", "B"]);
});

// Synced alone to herdr-t3-inbox, there's no agents list to load.
const lists = fs.existsSync(path.join(__dirname, "../t3-agents/main.js"));
test("only the sidebar list in view sets agent.next order", { skip: !lists && "t3-agents isn't here" }, () => {
  const f = fixture(); f.add("A", "working"); f.add("B", "idle", 200); f.render();
  const order = [...f.order], renderAgents = f.loadAgents(); renderAgents();
  assert.deepEqual(f.order, order);
  f.mode = "lists"; renderAgents(); const lists = [...f.order];
  f.render(1500); assert.deepEqual(f.order, lists);
});

test("a pause for the person keeps the run's Working place", () => {
  const f = fixture(), a = f.add("A", "working", 100); f.add("B", "working", 200); f.mod.workOpen = true;
  f.render(); a.status = "blocked"; f.render(1100); assert.deepEqual(f.active(), ["A"]);
  a.status = "working"; f.render(9000); assert.deepEqual(f.working(), ["B", "A"]);
});

test("a reply while sub-agents work comes to Active; read, the run goes on from its start", () => {
  const f = fixture(), a = f.add("A", "idle"); f.mod.workOpen = true;
  f.render(1000); f.terms.push({ address: "kid", parent: "A", state: "live", status: "working" });
  f.render(2000); assert.deepEqual(f.working(), ["A"]);
  a.status = "done"; f.render(3000); assert.deepEqual([f.active(), f.working()], [["A"], []]);
  a.status = "idle"; f.render(4000); assert.deepEqual(f.working(), ["A"]);
  assert.equal(f.mod.changed.A.at, 2000);
});

test("a run out of its grace lands on top of Active, over one that came back meanwhile", () => {
  const f = fixture(), a = f.add("A", "working"), b = f.add("B", "working"); f.mod.workOpen = true;
  f.render(); a.status = "idle"; f.render(1100);
  b.status = "blocked"; f.render(2000); assert.deepEqual(f.active(), ["B"]);
  f.render(3100); assert.deepEqual(f.active(), ["A", "B"]);
});

test("pinned agents skip the grace: unpinned right after stopping, it's in Active", () => {
  const f = fixture(), a = f.add("A", "working"); f.pins = ["A"]; f.mod.workOpen = true;
  f.render(); a.status = "idle"; f.render(1100);
  f.pins = []; f.render(1200);
  assert.deepEqual(f.active(), ["A"]); assert.deepEqual(f.working(), []);
});

test("Settle in view moves down the cards, then from the top", () => {
  const go = (focus) => {
    const f = fixture(); f.add("A", "idle", 300); f.add("B", "idle", 200); f.add("P", "idle", 100); f.pins = ["P"];
    f.rows.find((a) => a.address === focus).focused = true; f.render(); assert.deepEqual(f.order, ["P", "A", "B"]);
    f.settle(); return f.calls.at(-1)[1].terminal;
  };
  assert.equal(go("A"), "B");
  assert.equal(go("B"), "P");
});

test("times read as T3's", () => {
  const f = fixture(), a = f.add("A", "working"), b = f.add("B", "working"); f.mod.workOpen = true;
  f.render(); f.render(1000 + 3720000);
  assert.deepEqual(texts(find(f.tree, "state-A")).slice(-2), ["1h", "2m"]);
  b.status = "idle"; f.render(4000000); f.render(4002000);
  assert.ok(texts(find(f.tree, "state-B")).includes("just now"));
  f.render(4002000 + 9 * 86400000); assert.ok(texts(find(f.tree, "state-B")).includes("9d"));
});

test("a new scope starts the settled tail over", () => {
  const f = fixture(); f.mod.limit = 35; f.mod.pick({ id: "s1" }, false, f.cx);
  assert.equal(f.mod.limit, 10);
});

test("a plain click on Settle leaves no sweep behind to swallow the next click", () => {
  const f = fixture(), a = f.add("A", "idle", 100); f.add("B", "idle", 50); f.add("C", "idle", 30); a.focused = true;
  f.render(); f.mod.hovered = "A"; f.render();
  f.event("settle-A", "on_mouse_down:left");
  // The button's click stops its release there: the sidebar's own mouse-up never comes.
  f.event("settle-A", "on_click"); f.render(1100);
  f.event("t3-inbox-root", "on_mouse_move", { position: { x: 20, y: 300 } });
  assert.equal(f.keys, undefined, "the sidebar doesn't take the keyboard");
  f.event("card-C", "on_click");
  assert.deepEqual([f.calls.at(-1)[0], f.calls.at(-1)[1].terminal], ["agent.focus", "C"], "the next click opens the card at once");
});

test("a plain click on a settled row's undo leaves no sweep behind either", () => {
  const f = fixture(); f.add("A"); f.terms[0].labels.settled = "500:0"; f.mod.open = true;
  f.render(); f.mod.hovered = "A"; f.render();
  f.event("unsettle-A", "on_mouse_down:left"); f.event("unsettle-A", "on_click"); f.render(1100);
  f.event("t3-inbox-root", "on_mouse_move", { position: { x: 20, y: 300 } });
  assert.equal(f.keys, undefined); assert.equal(f.mod.sweep, null);
});

test("a title is bright when it's in view, needs you or is done; hover brightens without changing its weight", () => {
  const f = fixture(); f.env.theme = () => ({ foreground: "bright", muted: "quiet" });
  f.add("Seen", "idle"); f.add("Finished", "done"); f.add("Stuck", "blocked"); f.add("Open", "idle").focused = true;
  f.render();
  const look = (name) => { const { style } = holding(f.tree, name); return [style.text_color[0], Boolean(style.font_medium)]; };
  assert.deepEqual(look("Seen"), ["quiet", false]);
  for (const name of ["Finished", "Stuck", "Open"]) assert.deepEqual(look(name), ["bright", true], name);
  f.mod.hovered = "Seen"; f.render();
  assert.deepEqual(look("Seen"), ["bright", false]);
});

test("a card's marks sit on its third line when it has one, else on the title's", () => {
  const f = fixture(); f.add("m1/A"); f.add("m1/B");
  f.env.panes = () => [{ pane: "m1/A", branch: "dev" }];
  f.render();
  assert.equal(find(lineOf(f.tree, "m1/A"), "machine-m1/A"), null, "the title keeps its whole line");
  assert.ok(find(lineOf(f.tree, "dev"), "machine-m1/A"), "the branch line carries the mark");
  assert.ok(find(lineOf(f.tree, "m1/B"), "machine-m1/B"), "no third line: the title's line carries it");
});

test("a space's monogram is its first glyph, in T3's color for the same name", () => {
  const f = fixture(), run = (code) => vm.runInContext(code, f.context);
  // T3's own cases (apps/mobile/src/lib/projectIcon.test.ts), its colors as Tailwind's 400.
  for (const [name, text, color] of [["t3code", "T", "#2dd4bf"], ["Auto Monogram", "A", "#a3e635"], ["blitzdiff", "B", "#f472b6"],
    ["uoalbumdotclub", "U", "#9ca3af"], ["  Tagium  ", "T", "#a3e635"], ["Café Ünïcode", "C", "#e879f9"], ["web2 app", "W", "#34d399"]]) {
    assert.deepEqual([run(`monogram(${JSON.stringify(name)})`), run(`tint(${JSON.stringify(name)}, true)`)], [text, color], name);
  }
  assert.deepEqual([run(`monogram("智能算量")`), run(`monogram("~/dev")`)], ["智", "D"]);
  assert.equal(run(`monogram("~")`), "", "nothing to spell: the folder instead");
  f.add("A"); f.render();
  const tile = holding(f.tree, "O"), color = run('tint("One", true)');
  assert.deepEqual([tile.style.size[0], tile.style.bg[0], tile.style.text_color[0], tile.style.text_size[0]], [16, color + "24", color, 10.24], "T3's 14% wash of the color, the card's 16px, type as before");
});

test("a space's own icon, found as T3 finds it, replaces its monogram on every card", async () => {
  const f = fixture(), runs = [], written = [];
  // Its terminal is down in the repo: the icon is the repo's, as T3's is its project root's.
  f.env.spaces = () => [{ id: "s1", name: "One", folder: "", machine: "vps", tabs: [{ id: "b1" }] }];
  f.env.panes = () => [{ pane: "A", tab: "b1", cwd: "/w/one/src" }];
  Object.assign(f.context, {
    Buffer, createHash: require("node:crypto").createHash, appHome: () => "/app",
    fs: { exists: async () => false, mkdir: async () => {}, writeFile: async (p, b) => written.push([p, Buffer.from(b).toString()]) },
    readTextFile: async (p) => p === "/w/one/index.html" ? `<link href="/brand/logo.svg" rel="icon">` : null,
    exec: async (cmd, args, opts) => {
      if (cmd === "git") return opts.cwd === "/w/one/src" ? { code: 0, stdout: "/w/one\n" } : { code: 128, stdout: "" };
      runs.push([args.slice(3), opts]);
      if (args[1].startsWith("base64")) return { code: 0, stdout: Buffer.from("<svg/>").toString("base64").replace(/(.{4})/g, "$1\n") };
      return { code: 0, stdout: args.includes("brand/logo.svg") ? "brand/logo.svg" : "" };
    },
  });
  f.add("A"); f.render();
  await new Promise((done) => setTimeout(done, 0));
  assert.equal(runs[0][0][0], "favicon.svg", "the well-known places first, in T3's order");
  assert.deepEqual([...runs[1][0]], ["public/brand/logo.svg", "brand/logo.svg"], "then the page's link, public/ first");
  assert.deepEqual({ ...runs[1][1] }, { cwd: "/w/one", on: "vps" }, "looked for on the space's own machine");
  const [[at, bytes]] = written, icon = at.slice("/app/".length);
  assert.match(icon, /^cache\/t3-icons\/[0-9a-f]{16}\.svg$/); assert.equal(bytes, "<svg/>");
  f.render();
  const pic = find(f.tree, "card-A") && (function first(n) { return n?.style?.image ? n : n?.items?.map(first).find(Boolean); })(f.tree);
  assert.deepEqual([pic.style.image[0], pic.style.size[0]], [icon, 16]);
  assert.equal(holding(f.tree, "O"), null, "no monogram beside it");
  f.render(f.now + 59000); await new Promise((done) => setTimeout(done, 0));
  assert.equal(runs.length, 3, "found, it isn't looked for again within ten minutes");
});

// The list moves as T3's (Sidebar.motion.ts): a frame where the rows were, then let go to ease into place.
const flyOf = (f, address) => {
  const walk = (n) => !n || typeof n !== "object" ? null : n.key?.startsWith(`fly-${address}-`) ? n : n.items.map(walk).find(Boolean) ?? null;
  return walk(f.tree);
};
const at = (n) => ({ id: n.key, top: n.style.top?.[0], opacity: n.style.opacity?.[0] });

test("settling slides the card down into Settled and the rows under it up, then lets them go", () => {
  const f = fixture(); f.add("A", "idle", 300); f.add("B", "idle", 200); f.add("C", "idle", 100);
  f.mod.open = true; f.mod.listH = 600; f.render();
  assert.deepEqual(at(flyOf(f, "B")), { id: "fly-B-0", top: 0, opacity: 1 }, "nothing moves on the first draw");
  f.terms[0].labels.settled = "1100:0"; f.render(1100);
  const a = at(flyOf(f, "A")), b = at(flyOf(f, "B"));
  assert.equal(a.id, "fly-A-1", "a row that moves is a new element, first drawn where it was");
  assert.ok(a.top < 0, "A starts up where its card was, over Settled");
  assert.deepEqual(b, { id: "fly-B-1", top: 84, opacity: 1 }, "B starts a card lower, where it was");
  assert.equal(at(flyOf(f, "C")).top, 84);
  f.render(1116);
  assert.deepEqual([at(flyOf(f, "A")), at(flyOf(f, "B"))], [{ id: "fly-A-1", top: 0, opacity: 1 }, { id: "fly-B-1", top: 0, opacity: 1 }], "then they're let go, the same elements, so Herdr eases them");
  f.render(1200);
  assert.equal(flyOf(f, "B").key, "fly-B-1", "a draw with nothing new moves nothing");
});

test("a new row fades in from 40px up at the top, or in place under a row that stays", () => {
  const f = fixture(); f.add("A", "idle", 200); f.mod.listH = 600; f.render();
  f.add("B", "idle", 300); f.add("Z", "idle", 50); f.render(1100);
  assert.deepEqual(at(flyOf(f, "B")), { id: "fly-B-1", top: -40, opacity: 0 }, "at the top: from 40px up, clear");
  assert.deepEqual(at(flyOf(f, "Z")), { id: "fly-Z-1", top: -84, opacity: 0 }, "under A, which moved a card down: riding with it");
  f.render(1116);
  assert.deepEqual([at(flyOf(f, "B")).opacity, at(flyOf(f, "Z")).top], [1, 0]);
});

test("a row that leaves fades out where it was, then goes", () => {
  const f = fixture(); f.add("A", "idle", 300); f.add("B", "idle", 200); f.mod.listH = 600; f.render();
  f.rows.splice(0, 1); f.terms.splice(0, 1); f.render(1100);
  const ghost = () => { const walk = (n) => !n || typeof n !== "object" ? null : n.key?.startsWith("leaving-A-") ? n : n.items.map(walk).find(Boolean) ?? null; return walk(f.tree); };
  assert.deepEqual([ghost().style.opacity[0], ghost().style.top[0]], [1, 8], "drawn as it was, where it was");
  assert.equal(at(flyOf(f, "B")).top, 84, "B slides up from under it");
  f.render(1116);
  assert.deepEqual([ghost().style.opacity[0], ghost().style.top[0]], [0, 48], "fading, 40px down: nothing above it stays");
  f.render(1300);
  assert.equal(ghost(), null);
});

test("a settled row's time fades out as its undo fades in, and back", () => {
  const f = fixture(); f.add("A"); f.terms[0].labels.settled = "500:0"; f.mod.open = true;
  f.render();
  const corner = () => find(f.tree, "slim-corner-A"), undo = () => find(f.tree, "unsettle-A");
  assert.deepEqual([corner().items[0].style.opacity[0], undo().style.opacity[0]], [1, 0]);
  assert.equal(undo().handlers.on_click, undefined, "faded out, it's no button");
  f.mod.hovered = "A"; f.render();
  assert.deepEqual([corner().items[0].style.opacity[0], undo().style.opacity[0]], [0, 1]);
  assert.deepEqual(JSON.parse(JSON.stringify(corner().items[0].style.transition)), ["opacity", { duration: 150, easing: "ease-out" }]);
});

test("a dropped row slides from where it was let go, and nothing moves while dragging", () => {
  const f = fixture(); f.add("A", "idle", 300); f.add("B", "idle", 200); f.mod.open = true; f.mod.listH = 600; f.render();
  f.mod.drag = { from: "B", moved: true, y: 400, grab: 10, height: 82, target: { section: "settled" } };
  f.render(1050);
  assert.equal(flyOf(f, "B").key, "fly-B-0", "dragging: the lanes' gaps move, the rows don't fly");
  // finish() leaves where the ghost was, in the list's terms, then the label lands.
  f.mod.drag = null; f.mod.landed = { key: "B", y: 300 }; f.terms[1].labels.settled = "1100:0"; f.render(1100);
  const b = flyOf(f, "B"), y = f.mod.motion.at.get("B").y;
  assert.deepEqual([b.key, b.style.top[0]], ["fly-B-1", 300 - y]);
});

test("settling shows T3's undo notice over the first shelf for 5s; Undo puts them back where they were", () => {
  const f = fixture(), a = f.add("A", "idle", 300); f.add("B", "idle", 200); a.focused = true; f.mod.listH = 600;
  f.render(); f.settle(); f.render(1000);
  const note = () => { const walk = (n) => !n || typeof n !== "object" ? null : n.key?.startsWith("undo-notice-") && n.key !== "undo-notice-undo" ? n : n.items.map(walk).find(Boolean) ?? null; return walk(f.tree); };
  assert.deepEqual([texts(note())[0], note().style.opacity[0]], ["Settled 1 agent,", 0], "a frame clear, then it fades in");
  f.render(1016);
  assert.equal(note().style.opacity[0], 1);
  assert.ok(find(find(f.tree, "shelves"), "undo-notice-undo"), "over the first shelf's header, as T3 hosts it");
  const undo = find(f.tree, "undo-notice-undo");
  assert.ok("font_medium" in undo.style && "hover" in undo.style, "as T3's InlineButton: medium, underlined on hover");
  // A second settle soon after joins the same notice.
  f.rows.find((x) => x.address === "B").focused = true; a.focused = false; f.settle(); f.render(2000);
  assert.equal(texts(note())[0], "Settled 2 agents,");
  f.event("undo-notice-undo", "on_click");
  assert.deepEqual([f.mod.pending.A, f.mod.pending.B], ["", ""], "both come back, as they were: no news");
  f.render(2016);
  assert.equal(note().style.opacity[0], 0, "fading out");
  f.render(2300);
  assert.equal(note(), null);
  // Left alone, it goes after 5s.
  f.rows.find((x) => x.address === "A").focused = true; f.settle(); f.render(3000); f.render(3016);
  assert.equal(note().style.opacity[0], 1);
  f.render(8000); assert.equal(note().style.opacity[0], 0); assert.equal(find(f.tree, "undo-notice-undo"), null, "no Undo once it's going");
  f.render(8300); assert.equal(note(), null);
});

test("folding Working slides its header down with the list, as T3's markers move, so nothing passes over it", () => {
  const f = fixture(), a = f.add("A", "working", 300); f.add("B", "working", 200); f.add("C", "idle", 100); a.focused = true;
  f.terms[2].labels.settled = "500:0"; f.mod.workOpen = true; f.mod.open = true; f.mod.listH = 600; f.render();
  f.mod.workOpen = false; f.render(1100);
  assert.deepEqual(at(flyOf(f, "m:working")), { id: "fly-m:working-1", top: -84, opacity: 1 }, "the header starts where it was, a card higher");
  assert.equal(flyOf(f, "m:settled").key, "fly-m:settled-0", "Settled sits at the bottom: it doesn't move");
  assert.ok(find(f.tree, "working-header"), "the header's own element is inside its wrapper");
  f.render(1116);
  assert.equal(at(flyOf(f, "m:working")).top, 0);
  f.mod.workOpen = true; f.render(1300);
  assert.equal(at(flyOf(f, "m:working")).top, 84, "unfolding, it goes back up from where it was");
});

test("an agent brought into view that the space filter hides widens it, as T3's route reveal; a filter you pick stays", () => {
  const f = fixture(), a = f.add("A", "idle", 300), b = f.add("B", "idle", 200); b.space = "s2"; b.space_name = "Two";
  a.focused = true; f.mod.scope = ["s1"]; f.render();
  assert.deepEqual(f.active(), ["A"]);
  a.focused = false; b.focused = true; f.render(1100);
  assert.deepEqual([[...f.mod.scope], f.data.get("scope")], [[], "[]"], "kept: the filter is all spaces now");
  assert.ok(f.active().includes("B"));
  f.mod.pick({ id: "s1" }, false, f.cx); f.render(1200);
  assert.deepEqual([...f.mod.scope], ["s1"], "picked while B is in view, the filter holds");
  // A fresh inbox (a reload) leaves the filter as it was, as T3's mount doesn't widen.
  const g = fixture(), c = g.add("C", "idle"); c.space = "s2"; c.focused = true; g.mod.scope = ["s1"]; g.render();
  assert.deepEqual([...g.mod.scope], ["s1"]);
});

test("a sub-agent in view with no row of its own lights its parent's card, as T3's", () => {
  const f = fixture(); f.add("A", "idle", 300); f.add("B", "idle", 200);
  f.terms.push({ address: "c1", parent: "A", state: "live", status: "idle", labels: {} });
  f.context.focused = () => ({ terminal: "c1" }); f.render();
  assert.ok("bg" in find(f.tree, "card-A").style, "A is the row in view");
  assert.ok(!("bg" in find(f.tree, "card-B").style));
  f.mod.settleKey(f.cx);
  assert.match(f.mod.pending.A ?? "", /^\d+:/, "the settle key acts on it too");
});

test("the rows the next and previous keys walk are the ones drawn, in order, with the one in view", () => {
  const f = fixture(), a = f.add("A", "idle", 300); f.add("B", "working", 200); f.add("C", "idle", 100); f.add("W", "working", 50);
  f.terms[2].labels.settled = "500:0"; a.focused = true; f.render();
  assert.deepEqual(JSON.parse(JSON.stringify(f.state["t3-inbox.rows"])), { order: ["A"], view: "A" }, "folded shelves keep their rows out of the walk");
  f.mod.workOpen = true; f.mod.open = true; f.render();
  const rows = f.state["t3-inbox.rows"];
  assert.deepEqual([...rows.order].sort(), ["A", "B", "C", "W"]);
  assert.equal(rows.order[0], "A");
  assert.equal(rows.order.at(-1), "C", "Settled last, as drawn");
  f.render(); assert.equal(f.state["t3-inbox.rows"], rows, "unchanged, it isn't written again: every write redraws every mod");
});
