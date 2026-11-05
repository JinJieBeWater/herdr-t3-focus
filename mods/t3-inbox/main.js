// The inbox: no spaces, only the agents still asking for attention, as cards, latest news first.
// Below, as in T3: Working (busy agents, folded) and Settled (put away by hand until new work brings them back).
// Settled lives on the agent's own terminal as `settled=<ms>:<turn>`: it ends with the terminal, every mod
// sees it, and a turn ended since says there was new work even while no window watched. Looking doesn't count.
// Above the shelves, a short card each: mod panes (a review) in a tab with no agent, which no card's click leads to.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, Popover, Popup, InputState, Input } from "gpui-base";
import { agents, terminals, panes, spaces, focused, run, hc, notify, theme, shared, setShared, setAgentOrder, props, nextCommand, settings, layout, openOverlay } from "herdr";
import { modStatus, namer, programOf } from "./name.js";
import { kidStatus, descendants, ownStatus, treeStatus } from "./tree.js";
import { projectMark } from "./project.js";
import { tip, tipMark } from "./tip.js";
import { programIcon, detailsLive, detailsFor, detailsLine, detailsCard } from "./details.js";

const icon = programIcon;

const BUSY = new Set(["working", "blocked"]);
// The settled tail opens on this many, then grows by MORE.
const FIRST = 10, MORE = 25;
// A run that stops stays on the Working shelf this long (ms), as in T3: a quick continuation doesn't move it twice.
const GRACE = 2000;
// The last word when times tie, so the order doesn't follow the order the data came in.
const byAddress = (x, y) => x.address.localeCompare(y.address);

// As T3's sidebar times: no "ago", nothing past days.
function ago(ms, now) {
  const m = Math.floor((now - ms) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h`;
  return `${Math.floor(m / 1440)}d`;
}

// How long it's been working, as T3's Working pill: 9s, 4m, 1h 5m.
function took(ms, now) {
  const s = Math.max(0, Math.floor((now - ms) / 1000)), m = Math.floor(s / 60);
  return s < 60 ? `${s}s` : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

export default class Inbox extends View {
  init(_props, cx) {
    // Each agent's last state, when we saw it set going or come back (ms; 0: before we were watching), the turns
    // it had ended then, and for one that just stopped, when its run started.
    this.changed = JSON.parse(localStorage.getItem("changes") ?? "{}");
    this.open = localStorage.getItem("open") === "true";
    this.workOpen = localStorage.getItem("working-open") === "true";
    this.limit = FIRST;
    // Settled labels written but not back from the core yet: address → value ("" = removed).
    this.pending = {};
    this.hovered = null;
    // Each row's drawn height (logical px, by `kind:address`), for where rows sit when the list moves.
    this.rowH = {};
    // The spaces shown, as T3 scopes threads to projects; none: all of them.
    this.scope = JSON.parse(localStorage.getItem("scope") ?? "[]");
    this.scopeOpen = false;
    this.scopeAt = 0;
    this.search = InputState.new({ placeholder: "Search spaces…" });
    this.search.on("change", (_e, cx) => { this.scopeAt = 0; cx.notify(); });
    this.search.on("submit", (_e, cx) => this.pick(this.matches()[this.scopeAt], false, cx));
    // Takes the keyboard while a row is lifted, so Esc can put it back.
    this.keys = cx.focus_handle();
    // "Working 9s" counts up only while such a card shows.
    cx.timer.every(1000, (cx) => { if (this.ticking) cx.notify(); });
    // The cards' times (5m, 2h) move on by the minute, as T3's do.
    cx.timer.every(60000, (cx) => cx.notify());
    // `t3-inbox.settle` (cmd-shift-s in keys.json): see settleKey in render. `t3-inbox.clear`: Clear's confirm dialog.
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "settle") this.settleKey?.(cx);
        else if (command === "clear") this.clearSettled?.();
        cx.notify();
      }
    });
  }

  matches() {
    const q = this.search.value().toLowerCase();
    return [{ id: null, name: "All spaces" }, ...spaces()].filter((s) => s.name.toLowerCase().includes(q));
  }

  // A click shows that space alone; shift-click adds or removes it and keeps the menu open, as in T3.
  pick(s, shift, cx) {
    if (!s) return;
    this.scope = !s.id ? [] : !shift ? [s.id] : this.scope.includes(s.id) ? this.scope.filter((id) => id !== s.id) : [...this.scope, s.id];
    localStorage.setItem("scope", JSON.stringify(this.scope));
    // A new scope starts the settled tail over, as T3's does.
    this.limit = FIRST;
    if (!shift) this.scopeOpen = false;
    cx.notify();
  }

  // Takes each agent's state as working, blocked or idle (done counts as idle: looking at it isn't news).
  // A run's place in Working is when it started, as T3's is the person's message: a pause for them, or a stop
  // that goes on within the grace, is the same run. Pinned and settled ones skip the grace, as in T3: their
  // place doesn't hang on it. A turn ended while we weren't watching is news too.
  track(list, all, now, cx) {
    let dirty = false;
    for (const { address, s, turn, excluded } of list) {
      let was = this.changed[address];
      // The grace ran out: back with the person as of then, so it lands on top, and the run is over.
      if (was?.s === "idle" && was.start != null && (excluded || now - was.at >= GRACE)) {
        was = this.changed[address] = { s: "idle", at: excluded ? now : was.at + GRACE, turn: was.turn };
        dirty = true;
      }
      if (was?.s === s && (s !== "idle" || turn <= (was.turn ?? turn))) continue;
      const grace = was?.s === "working" && s === "idle" && !excluded;
      if (grace) cx.timer.after(GRACE, (cx) => cx.notify());
      this.changed[address] = !was ? { s, at: 0, turn } // First sight says nothing about when it changed.
        : s === "working" ? { s, at: was.start ?? now, turn }
        // A pause for the person, stuck or replying while its sub-agents work: the run keeps its start.
        : s === "blocked" || s === "done" ? { s, at: now, turn, start: was.s === "working" ? was.at : was.start }
        : grace ? { s, at: now, turn, start: was.at } // Stopped: the grace begins.
        : was.start != null && was.s === "idle" ? { ...was, turn } // The turn's end arriving within it.
        : { s, at: now, turn };
      dirty = true;
    }
    if (!dirty) return;
    // Only ended agents lose their record: one missing from the list for a moment comes back to its place.
    const listed = new Set(list.map((a) => a.address));
    const ended = new Set(all.filter((k) => k.state !== "live").map((k) => k.address));
    for (const [k, c] of Object.entries(this.changed)) if (!listed.has(k) && (ended.has(k) || now - c.at > 30 * 86400000)) delete this.changed[k];
    localStorage.setItem("changes", JSON.stringify(this.changed));
  }

  // Shown at once; the label comes back from the core a moment later.
  setSettled(addr, value, cx) {
    this.pending[addr] = value;
    cx.spawn(async (cx) => {
      const r = await hc(["label", addr, `settled=${value}`]).catch((e) => ({ code: 1, stderr: String(e) }));
      if (r.code === 0) return;
      delete this.pending[addr];
      notify({ title: "Couldn't update the agent", body: r.stderr.trim(), level: "error" });
      cx.notify();
    });
  }

  // T3's undo notice (showThreadUndoNotice): the latest run of one action, "Settled 2 agents", undone together for
  // 5s, then gone. A new notice fades in (a frame clear first: Herdr eases only later changes); it fades out going.
  remember(action, count, undo, cx) {
    const live = this.notice?.live && this.notice.action === action ? this.notice : null;
    const n = live ?? { action, count: 0, undos: [], gen: (this.notice?.gen ?? 0) + 1, shown: false };
    n.count += count; n.undos.push(undo); n.live = true;
    this.notice = n;
    const ran = n.undos.length;
    if (!live) cx.timer.after(16, (cx) => { if (this.notice === n && n.live) { n.shown = true; cx.notify(); } });
    cx.timer.after(5000, (cx) => { if (this.notice === n && n.undos.length === ran) this.forget(cx); });
  }

  forget(cx) {
    const n = this.notice;
    if (!n?.live) return;
    n.live = false; n.shown = false;
    cx.timer.after(250, (cx) => { if (this.notice === n) { this.notice = null; cx.notify(); } });
    cx.notify();
  }

  // Ends a drag or sweep, and hands the keyboard back to the pane that had it, unless the drop moved on to
  // another agent. Not FocusHandle.release(): that frees the handle, and the next drag would throw.
  // `this.back` is set only once something lifted.
  endDrag(restore = true) {
    const back = restore ? this.back : null;
    this.drag = this.sweep = this.back = null;
    if (back?.pane) run("pane.focus", { pane: back.pane });
    else if (back?.terminal) run("pane.focus", { terminal: back.terminal });
    return null;
  }

  detailsLive() { return detailsLive(this); }
  detailsFor(address, cx) { detailsFor(this, address, cx); }

  render(cx) {
    const t = theme(), now = Date.now();
    const every = agents(), all = terminals(), ps = panes(), sp = spaces(), f = focused();
    // Mod panes that say what they are (shared("<mod>.program")) in a tab with no agent, one a tab, in the spaces' order.
    // `pane:<id>` is the row's address, in t3-inbox.rows too: t3-chrome walks it with pane.focus.
    const modRows = sp.flatMap((s) => s.tabs.flatMap((c) => {
      const p = ps.find((x) => x.tab === c.id && x.mod && programOf(x));
      return p && !every.some((a) => a.tab === c.id)
        // A mod pane's title is its folder's name.
        ? [{ ...p, address: `pane:${p.pane}`, space: s.id, space_name: s.name, program: { ...programOf(p), name: p.title.charAt(0).toUpperCase() + p.title.slice(1) } }] : [];
    }));
    const inRow = modRows.find((m) => m.pane === f?.pane);
    // The row in view: the focused agent's, or for a sub-agent with no row of its own (shown in a block, a peek), its
    // nearest listed ancestor's, as T3's resolveSidebarRowThreadId lights the parent of an open sub-agent.
    const inView = (() => {
      const own = every.find((a) => a.focused);
      if (own) return own.address;
      const byAddress = new Map(all.map((k) => [k.address, k])), seen = new Set();
      // A mod pane has no agent of its own: it stands for the one beside it in its tab, if any. Herdr's agent is the
      // chosen one, else the first of all, so it counts only there, or for an agent block, which has no pane.
      if (f?.pane && !f.terminal) {
        const here = every.filter((a) => a.tab === f.tab);
        return (here.find((a) => a.address === f.agent) ?? here[0])?.address ?? null;
      }
      let k = byAddress.get(f?.pane ? f.terminal : f?.agent ?? f?.terminal);
      while (k && !every.some((a) => a.address === k.address) && !seen.has(k.address)) { seen.add(k.address); k = byAddress.get(k.parent); }
      return k && every.some((a) => a.address === k.address) ? k.address : null;
    })();
    // Read live on the agent itself, so a key or click right after focus moves goes by where it is now.
    const stoodIn = inView !== null && !every.some((a) => a.focused);
    const viewing = (a) => a.focused || (stoodIn && a.address === inView);
    // As T3's route reveal: an agent brought into view from elsewhere (a key, the picker, its pane) that the space
    // filter hides widens the filter to every space, kept. Not on the first draw, and a filter you pick isn't undone.
    // A mod pane's row too, or the keys would have nowhere to go from it.
    const viewKey = inRow?.address ?? inView;
    if (this.inView !== undefined && viewKey && viewKey !== this.inView && this.scope.length) {
      const a = inRow ?? every.find((x) => x.address === inView);
      if (a && !this.scope.includes(a.space)) { this.scope = []; localStorage.setItem("scope", "[]"); this.limit = FIRST; }
    }
    this.inView = viewKey;
    // A space that's gone reads as all; its id stays stored, so the scope returns with it.
    const scope = this.scope.filter((id) => sp.some((s) => s.id === id));
    const list = scope.length ? every.filter((a) => scope.includes(a.space)) : every;
    const modShown = scope.length ? modRows.filter((m) => scope.includes(m.space)) : modRows;
    const listed = new Map(every.map((a) => [a.address, a.status]));
    const term = new Map(all.map((k) => [k.address, k]));
    for (const [k, v] of Object.entries(this.pending)) if (!term.has(k) || (term.get(k).labels?.settled ?? "") === v) delete this.pending[k];
    const settledAt = (a) => {
      const v = this.pending[a.address] ?? term.get(a.address)?.labels?.settled;
      return v ? v.split(":").map(Number) : null;
    };
    const kids = new Map(every.map((a) => [a.address, descendants(all, a.address).map((k) => kidStatus(k, listed))]));
    // It, or anything under it, is working or needs the person.
    const busy = (a) => BUSY.has(a.status) || kids.get(a.address).some((s) => BUSY.has(s));
    // New work brings a settled agent back: busy now, or a turn ended since it was settled. Hidden ones too.
    for (const a of every) {
      const s = settledAt(a);
      if (s && (busy(a) || (term.get(a.address)?.turn ?? 0) > s[1])) this.setSettled(a.address, "", cx);
    }
    // It with what's under it (tree.js).
    const state = (a) => treeStatus(ownStatus(a.status, a.address, all), kids.get(a.address));
    const running = (a) => state(a) === "working";
    // Pins are the agents list's (t3-agents), one set for both: pinned agents stay up top in pin order, whatever their state.
    const pins = shared("agents.pins") ?? [];
    this.track(every.map((a) => ({
      address: a.address, s: state(a) === "blocked" ? "blocked" : running(a) ? "working"
        : state(a) === "done" && kids.get(a.address).includes("working") ? "done" : "idle",
      turn: term.get(a.address)?.turn ?? 0, excluded: pins.includes(a.address) || Boolean(settledAt(a)),
    })), all, now, cx);
    const mark = (a) => this.changed[a.address];
    // Seen changing, then; before that, the core's time of its last change. terminals() only has that as of
    // the app's start (status_ms isn't updated live), so it serves only until we see a change ourselves.
    const since = (a) => mark(a)?.at || term.get(a.address)?.status_ms || 0;
    // Just stopped: it shows its state now but keeps its Working place until the grace is out.
    const lingering = (a) => mark(a)?.s === "idle" && mark(a).start != null;
    // T3's Working shelf.
    const working = (a) => running(a) || lingering(a);
    // Active by when each came back to the person; Working by when its run started.
    const newest = (x, y) => since(y) - since(x) || byAddress(x, y);
    const begun = (a) => (lingering(a) ? mark(a).start || term.get(a.address)?.status_ms || 0 : since(a));
    // Working since: seen set going; before that, its own report, or for a parent waiting on sub-agents the
    // longest-working one's.
    const started = (a) => mark(a)?.at || (a.status === "working" ? term.get(a.address)?.status_ms
      : Math.min(Infinity, ...descendants(all, a.address).filter((k) => kidStatus(k, listed) === "working").map((k) => k.status_ms).filter(Boolean)));
    const pinned = pins.map((p) => list.find((a) => a.address === p)).filter(Boolean);
    const rest = list.filter((a) => !pins.includes(a.address));
    const out = rest.filter((a) => !settledAt(a) && !working(a)).sort(newest);
    const work = rest.filter((a) => !settledAt(a) && working(a)).sort((x, y) => begun(y) - begun(x) || byAddress(x, y));
    const put = rest.filter(settledAt).sort((x, y) => settledAt(y)[0] - settledAt(x)[0] || byAddress(x, y));
    // Shelves fold by default on this screen; the one in view stays out even folded or past the page, so it's never lost.
    const busyRows = this.workOpen ? work : work.filter(viewing);
    // agent.next goes as the list reads. Only while this list shows: the agents list (t3-agents) sets its own.
    const find = (n) => n?.id === "sidebar-lists" ? n : (n?.children ?? []).map(find).find(Boolean);
    if (find(layout())?.active !== "lists") setAgentOrder([...pinned, ...out, ...work, ...put].map((a) => a.address));

    const title = namer();
    const hover = (a) => (on, cx) => {
      if (on) { this.hovered = a.address; this.detailsFor(a.address, cx); }
      else if (this.hovered === a.address) { this.hovered = null; this.detailsFor(null, cx); }
      cx.notify();
    };
    // A button's icon and text brighten together: a hover style reaches the text but not the svg, so it's state.
    const glow = (id) => (on, cx) => {
      if (on) this.hot = id;
      else if (this.hot === id) this.hot = null;
      cx.notify();
    };
    const lit = (id, color) => (this.hot === id ? t.foreground : color);
    // A space's mark, as t3-spaces draws it.
    const avatar = (id, name, size) => projectMark(sp.find((s) => s.id === id) ?? { name: name ?? "" }, size, t, ps);
    // Brought back, it's news again: the top of the list.
    const unsettle = (a, cx) => {
      this.setSettled(a.address, "", cx);
      this.changed[a.address] = { ...this.changed[a.address], at: Date.now(), start: null };
      localStorage.setItem("changes", JSON.stringify(this.changed));
    };
    // Settling the agent in view moves on to the next card down the list, from the top past the end, as T3 does;
    // one in the background moves nothing.
    const settle = (xs, cx) => {
      for (const a of xs) this.setSettled(a.address, `${Date.now()}:${term.get(a.address)?.turn ?? 0}`, cx);
      // Undone, they're back where they were: no news, as T3 restores a thread.
      if (xs.length) this.remember("Settled", xs.length, (cx) => { for (const a of xs) this.setSettled(a.address, "", cx); }, cx);
      const cards = [...pinned, ...out, ...busyRows], i = cards.findIndex(viewing);
      if (i < 0 || !xs.includes(cards[i])) return false;
      const next = [...cards.slice(i + 1), ...cards.slice(0, i)].find((a) => !xs.includes(a));
      if (next) run("agent.focus", { terminal: next.address });
      return Boolean(next);
    };
    // The settle key: the agent in view, as its card's Settle (finished, unpinned) or its settled row's undo.
    this.settleKey = (cx) => {
      const a = every.find(viewing);
      if (!a) return;
      if (settledAt(a)) unsettle(a, cx);
      else if (!busy(a) && !pins.includes(a.address)) settle([a], cx);
    };

    // Dragging, as T3's sidebar does it (Sidebar.drag.ts, Sidebar.pointer.ts). Press a row and move 6px to lift it;
    // it follows the pointer up and down inside the list and says what letting go will do. While it's lifted, the
    // Pinned and Active labels open, and the list opens a gap the size of the destination's row where it will
    // land. Pinned keeps a hand-made order; Active and Settled keep their own, so the gap opens where that puts it.
    let d = this.drag;
    // A row that leaves the list (its agent ended, a filter) can't be dropped. Render can't run commands, so
    // `this.back` stays and the release (or Esc, or leaving) hands the keyboard back.
    if (d && !list.some((a) => a.address === d.from)) d = this.drag = null;
    const dragging = Boolean(d?.moved);
    const lifted = dragging ? list.find((a) => a.address === d.from) : null;
    const sectionOf = (a) => pins.includes(a.address) ? "pinned" : settledAt(a) ? "settled" : working(a) ? "working" : "active";
    const from = lifted ? sectionOf(lifted) : null;
    const others = (xs) => xs.filter((x) => x.address !== d?.from);
    const pinTo = (before) => ({ section: "pinned", before: before ?? null });
    const pinOrder = (before) => {
      const kept = pins.filter((p) => p !== d.from), at = before ? kept.indexOf(before) : -1;
      kept.splice(at < 0 ? kept.length : at, 0, d.from);
      return kept;
    };
    // What letting go would do, and the gap that shows it: above a row (its address), after a section's last row
    // (`end-…`), right under an empty section's label (`head-…`), or none (a folded or busy destination).
    const plan = (() => {
      const to = lifted && d.target;
      if (!to || (to.section === from && from !== "pinned")) return null;
      if (to.section === "pinned") {
        const order = pinOrder(to.before);
        if (from === "pinned" && order.join("\n") === pins.join("\n")) return null;
        return { section: "pinned", order, gap: to.before ?? (others(pinned).length ? "end-pinned" : "head-pinned") };
      }
      // Busy work can't be settled (new work brings it straight back); out of Pinned it joins the Working shelf.
      if (busy(lifted)) return to.section === "settled" ? null : { section: "active", gap: null };
      if (to.section === "settled") return { section: "settled", gap: !this.open ? null : others(put)[0]?.address ?? "head-settled" };
      const rest = others(out), at = from === "settled" ? 0 : rest.filter((x) => newest(x, lifted) < 0).length;
      return { section: "active", gap: !rest.length ? "head-active" : rest[at]?.address ?? "end-active" };
    })();
    const target = dragging ? d.target?.section ?? null : null;
    // A section lights up as the target, as T3's labels and shelf header do.
    const hot = (s) => target === s && (Boolean(plan) || s === from);
    const verb = !plan ? null : plan.section === "pinned" ? (from === "pinned" ? null : "pin")
      : plan.section === "settled" ? "settle" : from === "pinned" ? "unpin" : from === "settled" ? "unsettle" : null;
    const BADGE = { pin: ["mods/workspace-chrome/pin.svg", "Pin"], unpin: ["mods/workspace-chrome/pin-off.svg", "Unpin"],
      settle: ["mods/workspace-chrome/circle-check.svg", "Settle"], unsettle: ["mods/t3-inbox/undo.svg", "Un-settle"] };
    const badge = (v) => h_flex().id(`badge-${v}`).h(20).px(6).gap(4).flex_none().items_center().rounded(4)
      .border(1).border_color(t.accent + "66").bg(t.accent + "1a").text_size(11).font_medium().text_color(t.accent)
      .child(svg(BADGE[v][0]).size(12).flex_none().text_color(t.accent)).child(BADGE[v][1]);

    // Settled shows one page; while a drag moves a row out of it the next row fills in, and one settled into
    // it pushes the page's last row out of sight.
    const fromPage = from === "settled" && put.indexOf(lifted) < this.limit;
    const size = this.limit + (fromPage && plan ? 1 : 0) - (plan?.section === "settled" && from !== "settled" ? 1 : 0);
    const page = this.open ? put.slice(0, size) : [];
    const rows = [...page, ...put.filter((a) => viewing(a) && !page.includes(a))];
    // What the next and previous keys walk (t3-chrome): the rows drawn, in order, and the one in view. Written only when
    // it changes: every write redraws every mod.
    const drawn = { order: [...pinned, ...out, ...modShown, ...busyRows, ...rows].map((a) => a.address), view: viewKey };
    if (JSON.stringify(drawn) !== JSON.stringify(shared("t3-inbox.rows") ?? null)) setShared("t3-inbox.rows", drawn);

    const aim = (to, cx) => {
      if (!this.drag?.moved || JSON.stringify(this.drag.target ?? null) === JSON.stringify(to)) return;
      this.drag.target = to;
      cx.notify();
    };
    // Over a pin, the upper half drops above it and the lower half below.
    const pinNear = (a, upper) => {
      const xs = pinned.map((x) => x.address), i = xs.indexOf(a.address);
      return pinTo(xs.slice(upper && a.address !== d?.from ? i : i + 1).find((x) => x !== d?.from));
    };
    // The gap: a card and the list's 2px in Pinned and Active, a 30px slim row in Settled (stacked without gaps).
    const MOTION = { duration: 150, easing: "ease-out" };
    const cardH = lifted && from !== "settled" ? d.height : this.cardH ?? 82;
    const gap = (key) => div().id(`gap-${key}`).flex_none().h(plan?.gap !== key ? 0 : plan.section === "settled" ? 30 : cardH + 2)
      .when(dragging, (el) => el.transition("height", MOTION));
    // Each droppable row sits in a lane: the gap that opens above it, the row (folding away once the lifted one is
    // headed elsewhere, holding its place until then) with the list's spacing, and after the last, the end gap.
    const lane = (section, xs, draw, spacing) => xs.map((a, i) => v_flex().id(`lane-${a.address}`).flex_none()
      .child(gap(a.address))
      .child(v_flex().id(`hold-${a.address}`).flex_none()
        .when(dragging && d.from === a.address, (el) => el.overflow_hidden().opacity(0).h(plan ? 0 : d.height + spacing).transition("height", MOTION))
        .child(fly(a.address, section === "settled" ? "slim" : "card", draw(a))).when(spacing > 0, (el) => el.child(div().h(spacing).flex_none())))
      .when(i === xs.length - 1, (el) => el.child(gap(`end-${section}`))));
    // T3's boundaries: Pinned and Active labels, shown only while dragging; the list opens room for them.
    const boundary = (id, text, section, to) => h_flex().id(id).flex_none().overflow_hidden().h(dragging ? 24 : 0)
      .transition("height", MOTION).px(10).gap(8).items_center().text_size(12).font_medium()
      .on_mouse_move((_e, cx) => aim(to, cx))
      .when(dragging, (el) => el.child(div().text_color(hot(section) ? t.accent : t.muted).child(text))
        .child(div().flex_1().h(1).bg(hot(section) ? t.accent + "80" : t.border)));
    // An empty section still takes a drop: T3's dashed placeholder, accent while it's the target.
    const placeholder = (section, text) => div().id(`${section}-placeholder`).h(36).mb(2).flex_none().flex().items_center().justify_center()
      .rounded(6).border(1).border_dashed().text_size(12)
      .border_color(hot(section) ? t.accent + "66" : t.border).text_color(hot(section) ? t.accent : t.muted)
      .when(hot(section), (el) => el.bg(t.accent + "0d"))
      .on_mouse_move((_e, cx) => aim({ section }, cx))
      .child(text);
    // Picked up anywhere on a row that can move (not Working, not one whose Settle is still on its way).
    const row = (el, a) => el.relative()
      // Up from the hover on: a Popup must have measured its anchor before the frame a card starts to fade in.
      .when([this.hovered, this.details, this.detailsOut].includes(a.address), (r) => r.child(details(a)))
      .on_mouse_down("left", (e) => {
        if (sectionOf(a) === "working" || this.pending[a.address] !== undefined) return;
        this.drag = { from: a.address, at: e.position, grab: e.local_position?.y ?? 0, height: e.bounds?.height ?? 0, moved: false, target: null };
      })
      .on_mouse_move((e, cx) => {
        if (this.sweep?.moved) return sweepTo(a, cx);
        const s = sectionOf(a);
        aim(s === "pinned" ? pinNear(a, (e.local_position?.y ?? 0) < (e.bounds?.height ?? 0) / 2) : s === "working" ? null : { section: s }, cx);
      });
    // A drag's or sweep's release doesn't also click the row or button it ends on.
    const justDropped = () => this.drag?.moved || this.sweep?.moved || Date.now() - (this.dropped ?? 0) < 250;
    const open = (a) => (_e, cx) => {
      if (justDropped()) return;
      run("agent.focus", { terminal: a.address });
      // As a T3 tooltip, a click takes its card down until the pointer comes back.
      this.detailsFor(null, cx);
      cx.notify();
    };
    // Says whether it moved on to another agent.
    const drop = (cx) => {
      if (!plan) return false;
      const a = lifted;
      if (plan.section === "pinned") setShared("agents.pins", plan.order);
      else if (pins.includes(a.address)) {
        const before = [...pins];
        setShared("agents.pins", pins.filter((p) => p !== a.address));
        this.remember("Unpinned", 1, () => setShared("agents.pins", before), cx);
      }
      if (plan.section === "settled") return settle([a], cx);
      if (settledAt(a)) unsettle(a, cx);
      return false;
    };

    // Sweep, T3's other drag: press a card's Settle (or a settled row's undo) and move across rows to take the
    // whole run along; letting go settles (or brings back) every row it marked.
    const sweepFrom = (action, a) => (e, cx) => {
      cx.stop_propagation();
      this.sweep = { action, origin: a.address, at: e.position, moved: false, keys: [a.address] };
    };
    const sweepList = () => this.sweep.action === "settle" ? out.filter((x) => !busy(x)) : rows;
    const sweepTo = (a, cx) => {
      const xs = sweepList().map((x) => x.address), i = xs.indexOf(this.sweep.origin), j = xs.indexOf(a.address);
      if (i < 0 || j < 0) return;
      const keys = xs.slice(Math.min(i, j), Math.max(i, j) + 1);
      if (keys.join("\n") === this.sweep.keys.join("\n")) return;
      this.sweep.keys = keys;
      cx.notify();
    };
    const swept = (a) => Boolean(this.sweep?.moved && this.sweep.keys.includes(a.address));
    const finish = (cx) => {
      if (!this.drag && !this.sweep && !this.back) return;
      const moved = (dragging && drop(cx)) || (Boolean(this.sweep?.moved) && applySweep(cx));
      if (dragging && moved) this.landed = { key: d.from, y: ghostTop() - TOP };
      if (dragging || this.sweep?.moved) this.dropped = Date.now();
      this.endDrag(!moved);
    };
    const applySweep = (cx) => {
      const xs = sweepList().filter((x) => this.sweep.keys.includes(x.address));
      if (this.sweep.action === "settle") return settle(xs, cx);
      for (const a of xs) unsettle(a, cx);
      return false;
    };

    // A control's label in a row belongs to the same group as the row's card, so it too opens at once.
    const delay = this.detailsLive() ? 0 : 150;
    const machineOf = (a) => a.address.includes("/") ? a.address.split("/")[0] : null;
    const branchOf = (a) => ps.find((p) => p.pane === a.pane)?.branch;
    // A row's details, as T3's thread card: on the row's right from its top. A 1px anchor just outside its top right corner, as
    // a Popup hangs from its trigger's bottom left; clamped at the window's bottom the card slides up and still clears the row.
    // A control lit in the row speaks for itself instead, as T3's group lets one tooltip up at a time.
    const details = (a) => {
      const machine = machineOf(a), branch = branchOf(a), pic = icon(a.program, 12, t.muted);
      const up = this.details === a.address || this.detailsOut === a.address;
      return Popup.new(`details-${a.address}`, div()).absolute().top(-1).right(-1).size(1)
        .when(up && !this.hot && !dragging && !this.sweep?.moved, (pop) => pop.content(detailsCard(this, t, a.address, title(a), [
          a.space_name && detailsLine(t, avatar(a.space, a.space_name, 12), a.space_name),
          machine && detailsLine(t, svg("mods/workspace-chrome/server.svg").size(12).flex_none().text_color(t.muted), machine),
          branch && detailsLine(t, svg("mods/workspace-chrome/git-branch.svg").size(12).flex_none().text_color(t.muted), branch),
          pic && detailsLine(t, div().flex_none().opacity(0.6).child(pic), a.program.name),
        ]).ml(4)));
    };

    // `ghost`: the copy that follows the pointer, drawn without handlers or ids the list already uses.
    const card = (a, ghost) => {
      const st = state(a), on = viewing(a);
      const machine = machineOf(a), branch = branchOf(a);
      const going = (kids.get(a.address) ?? []).filter((s) => s === "working").length;
      const meta = [branch, going ? `${going} sub-agent${going > 1 ? "s" : ""} working` : null].filter(Boolean).join(" · ");
      const pic = icon(a.program, 16, t.muted);
      const over = !dragging && !this.sweep?.moved && this.hovered === a.address;
      // As T3's rows: what you're on or what wants you leads; the rest recede until hovered, in color only so nothing reflows.
      const leads = on || ghost || st === "blocked" || st === "done";
      const marks = machine || pic ? h_flex().gap(4).flex_none().items_center()
        // Another machine's agent, as in T3: a server mark before its program, the machine named on hover.
        .when(Boolean(machine), (el) => {
          const server = div().when(!ghost, (m) => m.id(`machine-${a.address}`).on_hover(glow(`machine-${a.address}`)).accessibility_label(`On ${machine}`))
            .flex_none().child(svg("mods/workspace-chrome/server.svg").size(14).text_color(t.dim));
          return el.child(ghost ? server : tip(this.hot, t, `machine-${a.address}`, machine, server, { delay }));
        })
        .when(Boolean(pic), (el) => el.child(div().flex_none().opacity(0.6).child(pic))) : null;
      // Hovered, the corner offers Settle, but only for what's finished: a working or stuck tree stays in sight.
      const offer = over && !busy(a) && !pins.includes(a.address);
      const id = `settle-${a.address}`;
      // As in T3, the corner says the state when there's one worth saying (Working, Needs you, Done: finished
      // and not yet seen), else how long ago it last changed. Sized as T3's: 16px mark, 4px gaps, and the
      // time in monospace children, one per part, so spacing and width don't hang on the interface font and
      // a monospace space (a full cell) doesn't open "1h 5m" wider than the 4px gaps.
      const pill = (color, mark, label, time) => h_flex().id(`state-${a.address}`).h(20).gap(4).flex_none().items_center().font_medium().text_color(color)
        .child(mark).child(div().child(label))
        .when(Boolean(time), (el) => el.children(time.split(" ").map((part) => div().font_family(settings().font_family ?? "JetBrains Mono").child(part))));
      // Lifted, or marked by a sweep, the corner says what letting go will do instead.
      // The state or the time, faded out on hover where Settle fades in over it, as T3's corner.
      const status = running(a)
          ? pill(t.working, svg("mods/workspace-chrome/spinner.svg").size(16).flex_none().text_color(t.working).spin(900),
            "Working", started(a) > 0 && started(a) < Infinity ? took(started(a), now) : null)
          : st === "blocked"
            ? pill(t.blocked, div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(11).font_bold().flex().items_center().justify_center().child("!"), "Needs you")
            : st === "done"
              ? pill(t.ansi2, svg("mods/workspace-chrome/circle-check.svg").size(16).flex_none().text_color(t.ansi2), "Done")
              : div().id(`state-${a.address}`).flex_none().child(since(a) > 0 ? ago(since(a), now) : "");
      const corner = ghost ? (verb ? badge(verb) : div())
        : swept(a) ? badge("settle")
        : h_flex().id(`corner-${a.address}`).relative().h(20).min_w(20).flex_none().items_center().justify_end()
          .child(div().flex_none().opacity(offer ? 0 : 1).transition("opacity", MOTION).child(status))
          .child(div().absolute().top(0).right(0).child(tip(this.hot, t, id, "Settle agent", h_flex().id(id).h(20).px(6).gap(4).flex_none().items_center().rounded(4)
          .text_size(12).text_color(lit(id, t.muted)).opacity(offer ? 1 : 0).transition("opacity", MOTION)
          // Faded out it's no button: a click there is the card's.
          .when(offer, (el) => el.on_hover(glow(id)).role("button").accessibility_label("Settle").on_mouse_down("left", sweepFrom("settle", a)).on_click((_e, cx) => {
            cx.stop_propagation();
            if (justDropped()) return;
            // A click is no sweep. Its release stops here, so the sidebar's mouse-up won't end the one the press began.
            this.sweep = null;
            // The card moves away without a pointer-leave event.
            this.hovered = null;
            this.detailsFor(null, cx);
            settle([a], cx);
            cx.notify();
          }))
          .child(svg("mods/workspace-chrome/check.svg").size(12).flex_none().text_color(lit(id, t.muted)))
          .child("Settle"), { action: "t3-inbox.settle", delay })));
      const base = v_flex().id(`${ghost ? "ghost-" : ""}card-${a.address}`).px(10).py(8).gap(2).flex_none().rounded(10)
        // A working row recedes until it's hovered or in view, as T3's.
        .when(!ghost, (el) => el.opacity(running(a) && !on && !over ? 0.7 : 1).transition("opacity", MOTION));
      return (ghost ? base : row(base, a).role("button").accessibility_label(title(a)).on_hover(hover(a))
        .on_click(open(a)).on_size_change((size) => { this.cardH = size.height; }))
        .when(on, (el) => el.bg(t.selected))
        .when(!on && !ghost && !dragging && !this.sweep?.moved, (el) => el.hover((s) => s.bg(t.hover)))
        .child(h_flex().h(20).gap(6).items_center().text_size(12).text_color(t.dim)
          .child(avatar(a.space, a.space_name, 16))
          // Lifted, a pin keeps its glyph only while it stays among the pins.
          .when(pins.includes(a.address) && (!ghost || plan?.section === "pinned" || !plan), (el) => el.child(svg("mods/workspace-chrome/pin.svg").size(12).flex_none().text_color(t.dim)))
          .child(div().flex_1().min_w(0).truncate().child(a.space_name ?? ""))
          .child(corner))
        .child(h_flex().gap(8).items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(14).when(leads, (el) => el.font_medium())
            .text_color(leads || over || swept(a) ? t.foreground : t.muted).child(title(a)))
          // Marks go on the third line when there is one, as in T3, so the title keeps its whole line.
          .when(Boolean(marks) && !meta, (el) => el.child(marks)))
        .when(Boolean(meta), (el) => el.child(h_flex().gap(6).items_center().text_size(12).text_color(t.dim)
          .child(div().flex_1().min_w(0).truncate().child(meta))
          .when(Boolean(marks), (m) => m.child(marks))));
    };

    // A settled row: one dim line; viewing it leaves it settled. Hovered it brightens and its time
    // becomes a bare undo arrow, as in T3.
    const slim = (a, ghost) => {
      const on = viewing(a), over = !dragging && !this.sweep?.moved && this.hovered === a.address, bright = on || over || ghost || swept(a);
      // As T3's settled rows: its project's mark, not its program's.
      const mark = avatar(a.space, a.space_name, 16);
      const undo = h_flex().id(`unsettle-${a.address}`).size(20).flex_none().items_center().justify_center().rounded(4)
        .opacity(over ? 1 : 0).transition("opacity", MOTION)
        // Faded out it's no button: a click there is the row's.
        .when(over, (el) => el.on_hover(glow(`unsettle-${a.address}`)).role("button").accessibility_label("Unsettle")
          .on_mouse_down("left", sweepFrom("unsettle", a)).on_click((_e, cx) => {
          cx.stop_propagation();
          if (justDropped()) return;
          this.sweep = null;
          this.hovered = null;
          this.detailsFor(null, cx);
          unsettle(a, cx);
          cx.notify();
        }))
        .child(svg("mods/t3-inbox/undo.svg").size(14).flex_none().text_color(lit(`unsettle-${a.address}`, t.muted)));
      const base = h_flex().id(`${ghost ? "ghost-" : ""}slim-${a.address}`).h(30).px(10).gap(8).flex_none().items_center().rounded(8);
      return (ghost ? base : row(base, a).role("button").accessibility_label(title(a)).on_hover(hover(a)).on_click(open(a)))
        .when(on, (el) => el.bg(t.selected))
        .when(!on && !ghost && !dragging && !this.sweep?.moved, (el) => el.hover((s) => s.bg(t.hover)))
        .child(h_flex().id(`slim-mark-${a.address}`).size(16).flex_none().items_center().justify_center().opacity(bright ? 1 : 0.4).transition("opacity", MOTION).child(ghost ? mark : tipMark(this, t, `slim-space-${a.address}`, a.space_name, mark, { above: true, delay })))
        .child(div().flex_1().min_w(0).truncate().text_color(bright ? t.foreground : t.muted).child(title(a)))
        .child(ghost ? (verb ? badge(verb) : div()) : swept(a) ? badge("unsettle")
          // T3's corner: the time fades out on hover as the undo arrow fades in over it.
          : h_flex().id(`slim-corner-${a.address}`).relative().h(20).min_w(20).flex_none().items_center().justify_end()
            .child(div().flex_none().text_size(12).text_color(t.dim).opacity(over ? 0 : 1).transition("opacity", MOTION).child(ago(settledAt(a)[0], now)))
            .child(div().absolute().top(0).right(0).child(tip(this.hot, t, `unsettle-${a.address}`, "Unsettle", undo, { action: "t3-inbox.settle", above: true, delay }))));
    };

    // A mod pane's row: a card's first two lines, which project with how its run goes, then its name. No Settle and no drag: × closes it,
    // which its mod's own state outlives. `ghost`: drawn inert, fading out once it's closed.
    const modRow = (m, ghost) => {
      const on = m.pane === f?.pane, over = !ghost && !dragging && !this.sweep?.moved && this.hovered === m.address;
      const word = modStatus(m), bright = on || over || word === "blocked" || word === "done";
      // Its project's mark and name, as a card's: a mark alone may be the mod's own logo. Its program's is in its details.
      const mark = avatar(m.space, m.space_name, 16), id = `close-${m.address}`;
      const going = word === "working" ? svg("mods/workspace-chrome/spinner.svg").size(16).flex_none().text_color(t.working).spin(900)
        : word === "blocked" ? div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(11).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!")
        : word === "done" ? svg("mods/workspace-chrome/circle-check.svg").size(16).flex_none().text_color(t.ansi2) : null;
      const close = h_flex().id(id).size(20).flex_none().items_center().justify_center().rounded(4)
        .opacity(over ? 1 : 0).transition("opacity", MOTION)
        // Faded out it's no button: a click there is the row's.
        .when(over, (el) => el.on_hover(glow(id)).role("button").accessibility_label("Close pane").on_click((_e, cx) => {
          cx.stop_propagation();
          // The row goes without a pointer-leave event.
          this.hovered = null; this.hot = null;
          this.detailsFor(null, cx);
          run("pane.close", { pane: m.pane });
          cx.notify();
        }))
        .child(svg("mods/t3-inbox/close.svg").size(14).flex_none().text_color(lit(id, t.muted)));
      const base = v_flex().id(`${ghost ? "ghost-" : ""}mod-${m.address}`).relative().h(52).px(10).flex_none().justify_center().rounded(10);
      return (ghost ? base : base.role("button").accessibility_label([title(m), { working: "Working", blocked: "Needs you", done: "Done" }[word]].filter(Boolean).join(", "))
        .when([this.hovered, this.details, this.detailsOut].includes(m.address), (r) => r.child(details(m)))
        .on_hover(hover(m)).on_mouse_move((_e, cx) => aim(null, cx))
        .on_click((_e, cx) => {
          if (justDropped()) return;
          run("pane.focus", { pane: m.pane });
          this.detailsFor(null, cx);
          cx.notify();
        }))
        .when(on && !ghost, (el) => el.bg(t.selected))
        .when(!on && !ghost && !dragging && !this.sweep?.moved, (el) => el.hover((s) => s.bg(t.hover)))
        .child(h_flex().h(20).gap(6).items_center().text_size(12).text_color(t.dim)
          .child(mark)
          .child(div().flex_1().min_w(0).truncate().child(m.space_name))
          .when(!ghost, (el) => el.child(h_flex().id(`mod-corner-${m.address}`).relative().h(20).min_w(20).flex_none().items_center().justify_end()
            .child(div().flex_none().opacity(over ? 0 : 1).transition("opacity", MOTION).when(Boolean(going), (g) => g.child(going)))
            .child(div().absolute().top(0).right(0).child(tip(this.hot, t, id, "Close pane", close, { above: true, delay }))))))
        .child(div().min_w(0).truncate().text_size(14).when(bright, (el) => el.font_medium()).text_color(bright ? t.foreground : t.muted).child(title(m)));
    };

    // A shelf's header, folding it: label, then count and chevron at the far edge.
    const shelf = (id, label, count, open, toggle, extra) => h_flex().id(id).h(30).px(10).gap(6).flex_none().items_center()
      .text_size(12).font_medium().text_color(t.dim)
      .role("button").accessibility_label(`${open ? "Hide" : "Show"} ${label.toLowerCase()} agents`)
      .on_click((_e, cx) => {
        toggle();
        cx.notify();
      })
      .child(div().flex_1().child(label))
      .when(Boolean(extra), (el) => el.child(extra))
      .child(div().child(String(count)))
      .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none());

    // The list's motion, as T3's (Sidebar.motion.ts): when the rows' order or sections change, a row that moved slides from
    // where it was, one that's new fades in from 40px above, one that left fades out where it was; 150ms ease-out. Not
    // while dragging (the lanes' gaps move then), and a change of more than 40 rows just shows. Herdr eases only later
    // changes to an element: a row that moves gets a new id, first drawn where it was, then let go to its place.
    const zoom = Number(settings()?.zoom) || 1;
    const TOP = 32; // The top row above the list.
    const ghostTop = () => Math.max(TOP + 8 + 24, Math.min(d.y - d.grab, (this.height ?? Infinity) - d.height - 8));
    const heightOf = (kind, key) => this.rowH[`${kind}:${key}`] ?? (kind === "mod" ? 52 : kind === "slim" || kind === "marker" ? 30 : (this.cardH ?? 82) / zoom + 2);
    // Where each row sits in the list (logical px from its top, padding included): Pinned and Active from the top, the
    // shelves from the bottom once there's room, below the rest when there isn't. While dragging, with the labels,
    // the gap and the lifted row as the lanes draw them, so a drop goes on from there. The shelves' headers, Show more
    // and Active's empty line move with them (`m:` keys), as T3's list markers do, so nothing slides over them.
    const place = () => {
      const at = new Map(), gapH = plan?.section === "settled" ? 30 : cardH + 2;
      const put1 = (a, kind, y) => { const h = dragging && plan && a.address === d.from ? 0 : heightOf(kind, a.address); at.set(a.address, { y, h, kind, a }); return h; };
      const mark = (key, y, h = heightOf("marker", key)) => { at.set(key, { y, h, kind: "marker" }); return h; };
      let y = 8 + (dragging ? 24 : 0);
      for (const a of pinned) { if (dragging && plan?.gap === a.address) y += gapH; y += put1(a, "card", y); }
      if (dragging) y += (plan?.gap === "end-pinned" || plan?.gap === "head-pinned" ? gapH : 0) + 24;
      for (const a of out) { if (dragging && plan?.gap === a.address) y += gapH; y += put1(a, "card", y); }
      if (!out.length) y += dragging ? 38 : mark("m:empty", y, this.rowH["marker:m:empty"] ?? 32);
      const shelf = [];
      let b = 12;
      if (modShown.length) { shelf.push(["m:mods", "marker", b]); b += 30; for (const m of modShown) { shelf.push([m, "mod", b]); b += heightOf("mod", m.address); } }
      if (work.length) { shelf.push(["m:working", "marker", b]); b += 30; for (const a of busyRows) { shelf.push([a, "work", b]); b += heightOf("work", a.address); } }
      if (put.length || dragging) {
        shelf.push(["m:settled", "marker", b]); b += 30;
        for (const a of rows) { if (dragging && plan?.gap === a.address) b += gapH; shelf.push([a, "slim", b]); b += a.address === d?.from && dragging && plan ? 0 : 30; }
        if (this.open && put.length > this.limit) { shelf.push(["m:more", "marker", b]); b += 30; }
      }
      const base = Math.max(y, (this.listH ?? 0) - 8 - b);
      for (const [a, kind, off] of shelf) kind === "marker" ? mark(a, base + off) : put1(a, kind, base + off);
      return at;
    };
    {
      const at = place(), sig = [...at].map(([k, v]) => `${k}:${v.kind}`).join("\n"), m = this.motion;
      if (!m || dragging || this.sweep?.moved || sig === m.sig) this.motion = { exits: [], fly: {}, gen: {}, ...m, sig, at };
      else {
        const fly = {}, gen = m.gen, exits = [...m.at].filter(([k]) => !at.has(k)).map(([key, v]) => ({ key, ...v }));
        const fresh = [...at.keys()].filter((k) => !m.at.has(k));
        if (fresh.length + exits.length <= 40) {
          // A row that comes or goes rides with the nearest kept row above it (still, it just fades); with none, 40px.
          let riding;
          for (const [k, v] of at) {
            const was = m.at.get(k), from = this.landed?.key === k ? this.landed.y : was?.y;
            if (from === undefined) {
              gen[k] = (gen[k] ?? 0) + 1;
              fly[k] = { top: riding ?? -Math.min(v.h, 40), fade: true };
              continue;
            }
            riding = from - v.y;
            if (riding === 0) continue;
            gen[k] = (gen[k] ?? 0) + 1;
            fly[k] = { top: riding };
          }
          const old = [...m.at.keys()];
          for (const x of exits) {
            const above = old.slice(0, old.indexOf(x.key)).reverse().find((k) => at.has(k));
            x.travel = above === undefined ? Math.min(x.h, 40) : -(fly[above]?.top ?? 0);
          }
        }
        const step = (m.step ?? 0) + 1;
        this.motion = { sig, at, gen, fly, exits: fresh.length + exits.length <= 40 ? exits : [], step, leaving: false };
        // A frame drawn where they were, then let go.
        cx.timer.after(16, (cx) => { if (this.motion.step !== step) return; this.motion.fly = {}; this.motion.leaving = true; cx.notify(); });
        cx.timer.after(MOTION.duration + 50, (cx) => { if (this.motion.step !== step) return; this.motion.exits = []; cx.notify(); });
      }
      this.landed = null;
    }
    // A row in its wrapper, which flies: drawn first where it was (or 40px up and clear, coming in), then let go.
    const fly = (key, kind, child) => {
      const f = this.motion.fly[key];
      return div().id(`fly-${key}-${this.motion.gen[key] ?? 0}`).flex_none().relative()
        .top(f?.top ?? 0).opacity(f?.fade ? 0 : 1).transition("top", MOTION).transition("opacity", MOTION)
        .on_size_change((size) => { this.rowH[`${kind}:${key}`] = size.height / zoom + (kind === "card" || kind === "work" ? 2 : 0); })
        .child(child);
    };
    // A row that left, drawn inert where it was and fading out, riding as T3's clones do.
    const leaving = (x) => {
      if (x.kind === "marker") return null;
      let drawn;
      if (!kids.has(x.key)) kids.set(x.key, []); // Gone: drawn as it was, with no sub-agents.
      try { drawn = x.kind === "mod" ? modRow(x.a, true) : x.kind === "slim" ? slim(x.a, true) : card(x.a, true); } catch { return null; } // Gone with too much of its state.
      const away = this.motion.leaving;
      return div().id(`leaving-${x.key}-${this.motion.step}`).absolute().left(8).right(8).top(x.y + (away ? x.travel ?? 0 : 0))
        .opacity(away ? 0 : 1).transition("top", MOTION).transition("opacity", MOTION).child(drawn);
    };
    this.ticking = busyRows.length > 0 || pinned.some(working);
    // The first shelf takes the free space above it, so both sit at the bottom.
    const n = this.notice;
    const notice = n && h_flex().id(`undo-notice-${n.gen}`).absolute().left(0).right(0).top(-12).h(24).px(10).gap(4).items_center()
      .bg(t.chrome).text_size(11).text_color(t.dim).opacity(n.shown ? 1 : 0).transition("opacity", { duration: 200, easing: "ease-out" })
      .child(div().min_w(0).truncate().child(`${n.action} ${n.count} agent${n.count === 1 ? "" : "s"},`))
      // As T3's InlineButton: medium, foreground, underlined on hover.
      .when(n.live, (el) => el.child(div().id("undo-notice-undo").flex_none().font_medium().text_color(t.foreground).hover((s) => s.underline())
        .role("button").accessibility_label("Undo")
        .on_click((_e, cx) => {
          cx.stop_propagation();
          for (const undo of n.undos) undo(cx);
          this.forget(cx);
        })
        .child("Undo")));
    const shelves = v_flex().id("shelves").relative().pt(12).flex_none()
      .when(Boolean(notice), (el) => el.child(notice))
      // A shelf's header, saying what these are, but no fold: folded, they'd be lost again.
      // shortcut: named after the first row's mod, so a second mod publishing a program would share it; group by mod then.
      .when(modShown.length > 0, (el) => el
        .child(fly("m:mods", "marker", h_flex().id("mods-heading").h(30).px(10).gap(6).flex_none().items_center().text_size(12).font_medium().text_color(t.dim)
          .on_mouse_move((_e, cx) => aim(null, cx))
          .child(div().flex_1().child(modShown[0].program.name)).child(div().child(String(modShown.length)))))
        .children(modShown.map((m) => fly(m.address, "mod", modRow(m)))))
      .when(work.length > 0, (el) => el
        .child(fly("m:working", "marker", shelf("working-header", "Working", work.length, this.workOpen, () => {
          this.workOpen = !this.workOpen;
          localStorage.setItem("working-open", String(this.workOpen));
        }).on_mouse_move((_e, cx) => aim(null, cx))))
        .child(v_flex().gap(2).children(busyRows.map((a) => fly(a.address, "work", card(a))))));
    // Clear closes settled agents' panes; Herdr then closes emptied tabs. The one in view stays.
    const spaceNow = sp.find((s) => s.active), tabNow = spaceNow?.tabs.find((c) => c.active)?.id;
    const doomed = put.filter((a) => a.pane && !viewing(a) && a.tab !== tabNow);
    // With nothing to clear the button goes, and a gone element hears no pointer-leave: drop its hover.
    if (doomed.length === 0 && this.hot === "settled-clear") this.hot = null;
    this.clearSettled = () => {
      const gone = new Set(doomed.map((a) => a.pane));
      for (const id of new Set(doomed.map((a) => a.space))) {
        const s = sp.find((s) => s.id === id), tabs = s?.tabs.map((c) => c.id) ?? [];
        const mine = ps.filter((p) => tabs.includes(p.tab));
        // The space stays: pane.close refuses its last pane, so a space left empty gets a fresh shell tab first,
        // where its terminals are now: an unnamed space is named after that, and s.folder is only where it began.
        if (mine.every((p) => gone.has(p.pane))) run("tab.new", { space: id, folder: mine.find((p) => p.cwd)?.cwd || s.folder });
        for (const a of doomed.filter((a) => a.space === id)) run("pane.close", { pane: a.pane });
      }
      // tab.new shows the new tab; go back to where the person was.
      if (tabNow) { run("space.select", { id: spaceNow.id }); run("tab.select", { id: tabNow }); }
    };
    const clearButton = doomed.length > 0 && tip(this.hot, t, "settled-clear", "Clear settled agents", h_flex().id("settled-clear").h(20).px(6).flex_none().items_center().rounded(4)
      .text_color(lit("settled-clear", t.dim)).on_hover(glow("settled-clear"))
      .role("button").accessibility_label("Clear settled agents")
      .on_click((_e, cx) => {
        cx.stop_propagation();
        this.hot = null; // The dialog covers it, before the pointer can report leaving it.
        openOverlay({ mod: "confirm", kind: "dialog", width: 400, height: 170, props: {
          title: `Close ${doomed.length} pane${doomed.length === 1 ? "" : "s"}?`,
          detail: "This ends the terminals of your settled agents. The tab you're on stays.",
          command: { name: "t3-inbox.clear" },
        } });
        cx.notify();
      })
      .child("Clear"), { above: true });
    const tail = v_flex().id("settled").flex_none()
      .child(fly("m:settled", "marker", shelf("settled-header", "Settled", put.length, this.open, () => {
        this.open = !this.open;
        this.limit = FIRST;
        localStorage.setItem("open", String(this.open));
      }, clearButton).on_mouse_move((_e, cx) => aim({ section: "settled" }, cx))
        // As T3's shelf header: brighter while anything is lifted, accent as the target.
        .when(dragging, (el) => el.text_color(hot("settled") ? t.accent : t.foreground))))
      .when(dragging && others(rows).length === 0 && !(rows.length > 0 && !plan), (el) => el
        .child(plan?.gap === "head-settled" ? gap("head-settled") : placeholder("settled", "Settled")))
      .children(lane("settled", rows, (a) => slim(a), 0))
      .when(this.open && put.length > this.limit, (el) => el.child(fly("m:more", "marker", h_flex().id("settled-more").h(30).px(10).gap(8).flex_none().items_center().rounded(8)
        .text_color(lit("settled-more", t.dim)).hover((s) => s.bg(t.hover)).on_hover(glow("settled-more"))
        .role("button").accessibility_label("Show more settled agents")
        .on_click((_e, cx) => {
          this.hot = null; // It may go, before the pointer can report leaving it.
          this.limit += MORE;
          cx.notify();
        })
        .child(svg("mods/workspace-chrome/chevron-down.svg").size(12).flex_none())
        .child(`Show ${Math.min(MORE, put.length - this.limit)} more`))));

    // T3's top row: search on the left, then the space filter, new space and new tab.
    const tool = (id, label, icon, fn, more) => tip(this.hot, t, id, label, div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6)
      .hover((s) => s.bg(t.hover)).on_hover(glow(id))
      .role("button").accessibility_label(label).on_click(fn)
      .child(svg(`mods/workspace-chrome/${icon}.svg`).size(14).text_color(lit(id, t.dim))), more);
    // The filter shows what it filters to: one avatar, two overlapping, or the plain filter icon.
    const scoped = sp.filter((s) => scope.includes(s.id));
    const choice = (s, i) => {
      const on = s.id ? scope.includes(s.id) : scope.length === 0;
      // Selection is a check badge on the icon, as in T3.
      return h_flex().id(`scope-${s.id ?? "all"}`).h(32).px(8).gap(8).flex_none().items_center().rounded(6)
        .when(i === this.scopeAt, (el) => el.bg(t.selected))
        .on_hover((over, cx) => { if (over && this.scopeAt !== i) { this.scopeAt = i; cx.notify(); } })
        .role("button").accessibility_label(s.name)
        .on_click((e, cx) => this.pick(s, e.modifiers.shift, cx))
        .child(div().relative().flex_none()
          .child(s.id ? avatar(s.id, s.name, 16) : svg("mods/workspace-chrome/folder.svg").size(16).text_color(t.muted))
          .when(on, (el) => el.child(h_flex().absolute().right(-4).bottom(-4).size(12).rounded_full().bg(t.accent)
            .border(2).border_color(t.popover).items_center().justify_center()
            .child(svg("mods/workspace-chrome/check.svg").size(7).text_color("#ffffff")))))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(s.name));
    };
    const filter = Popover.new("inbox-scope-menu").anchor("top_right").open(this.scopeOpen)
      .on_open_change((open, cx) => {
        this.scopeOpen = open;
        if (open) {
          this.scopeAt = 0;
          this.search.set_value("");
          this.search.focus();
        }
        cx.notify();
      })
      .trigger(h_flex().id("inbox-scope").size(26).flex_none().items_center().justify_center().rounded(6)
        .hover((s) => s.bg(t.hover)).on_hover(glow("inbox-scope"))
        .role("button").accessibility_label(scoped.length ? `Filter by space: ${scoped.map((s) => s.name).join(", ")}` : "Filter by space")
        .child(scoped.length > 1
          ? h_flex().children(scoped.slice(0, 2).map((s, i) => avatar(s.id, s.name, 14).when(i > 0, (el) => el.ml(-6))))
          : scoped.length
            ? avatar(scoped[0].id, scoped[0].name, 16)
            : svg("mods/t3-inbox/list-filter.svg").size(14).text_color(lit("inbox-scope", t.dim))))
      .content(v_flex().id("inbox-scope-panel").w(260).max_h(360).mt(4).p(6).gap(2).rounded(10)
        .bg(t.popover).border_1().border_color(t.border).text_size(13)
        .on_key_down((e, cx) => {
          const n = this.matches().length;
          if (n === 0 || (e.key !== "down" && e.key !== "up")) return;
          this.scopeAt = (this.scopeAt + (e.key === "down" ? 1 : n - 1)) % n;
          cx.stop_propagation();
          cx.notify();
        })
        .child(h_flex().h(32).px(8).gap(8).flex_none().items_center().border_b_1().border_color(t.border)
          .child(svg("mods/workspace-chrome/search.svg").size(14).flex_none().text_color(t.dim))
          .child(Input.new(this.search).flex_1().h_full().text_size(13).text_color(t.foreground)))
        .child(v_flex().id("inbox-scope-list").min_h(0).pt(4).gap(2).overflow_y_scroll()
          .children(this.matches().map(choice))
          .when(this.matches().length === 0, (el) => el.child(div().px(8).py(6).text_color(t.dim).child("No matching spaces.")))));
    // Right edge as the brand bar's above (pr 10), so the two rows of icons line up.
    const top = h_flex().id("inbox-top").h(32).pl(8).pr(10).gap(2).flex_none().items_center()
      .child(h_flex().id("inbox-search").flex_1().h(26).px(10).gap(8).items_center().rounded(6)
        .text_color(lit("inbox-search", t.dim)).hover((s) => s.bg(t.hover)).on_hover(glow("inbox-search"))
        // Each opens over its button, before the pointer can report leaving it.
        .role("button").accessibility_label("Search").on_click((_e, cx) => { this.hot = null; run("mod.open", { name: "picker" }); cx.notify(); })
        .child(svg("mods/workspace-chrome/search.svg").size(14).flex_none().text_color(lit("inbox-search", t.dim)))
        .child(div().child("Search")))
      .child(tip(this.scopeOpen ? null : this.hot, t, "inbox-scope", "Filter by space", filter, { hint: "Shift+click to pick several" }))
      .child(tool("inbox-new-space", "New space", "folder-plus", () => run("space.new"), { action: "space.new" }))
      // The layout passes its own menu; docked alone, the shipped one.
      .child(tool("inbox-new-tab", "New tab", "square-pen", (_e, cx) => { this.hot = null; run("mod.open", { name: props()?.newMenu ?? "new-menu" }); cx.notify(); }));

    const tree = v_flex().id("t3-inbox-root").relative().size_full().min_h(0).bg(t.chrome).text_size(13)
      .on_size_change((size) => { this.height = size.height; this.width = size.width; })
      // Esc puts a lifted row back (the sidebar holds the keyboard only while something is lifted).
      .track_focus(this.keys).on_key_down((e, cx) => {
        if (e.keystroke !== "escape" || !(this.drag || this.sweep || this.back)) return;
        this.endDrag();
        cx.notify();
      })
      .on_mouse_move((e, cx) => {
        const g = this.drag ?? this.sweep;
        if (!g || (!g.moved && Math.hypot(e.position.x - g.at.x, e.position.y - g.at.y) <= 6)) return;
        if (!g.moved) { this.back = focused(); this.keys.focus(); }
        g.moved = true;
        g.last = e.local_position ?? g.last;
        if (this.drag) this.drag.y = e.local_position?.y ?? this.drag.y;
        cx.notify();
      })
      // Released anywhere in the sidebar, it lands where the gap shows.
      .on_mouse_up("left", (_e, cx) => { finish(cx); cx.notify(); })
      // Herdr reports no release outside the sidebar, so leaving decides. Off the top or bottom edge (the Pinned
      // label or the Settled shelf sit there) it lands where the badge says, as T3 keeps the last target past the
      // list's ends; off a side it goes back.
      .on_hover((on, cx) => {
        if (on || !(this.drag || this.sweep || this.back)) return;
        const p = (this.drag ?? this.sweep)?.last, w = this.width ?? Infinity, h = this.height ?? Infinity;
        const side = !p || Math.min(p.x, w - p.x) < Math.min(p.y, h - p.y);
        if (side) this.endDrag(); else finish(cx);
        cx.notify();
      })
      .child(top)
      .child(v_flex().id("inbox-list").relative().flex_1().min_h(0).px(8).py(8).overflow_y_scroll()
        .on_size_change((size) => { this.listH = size.height / zoom; })
        // Rows leaving fade out where they were, as T3's clones.
        .children(this.motion?.exits.map(leaving).filter(Boolean) ?? [])
        .child(boundary("pinned", "Pinned", "pinned", pinTo(others(pinned)[0]?.address)))
        .child(gap("head-pinned"))
        .children(lane("pinned", pinned, (a) => card(a), 2))
        .child(boundary("active", "Active", "active", { section: "active" }))
        .when(dragging && others(out).length === 0 && !(out.length > 0 && !plan), (el) => el
          .child(plan?.gap === "head-active" ? gap("head-active") : placeholder("active", "Active")))
        .children(lane("active", out, (a) => card(a), 2))
        .when(out.length === 0 && !dragging, (el) => el.child(fly("m:empty", "marker", div().px(10).py(8).text_size(12).text_color(t.dim)
          .child(every.length ? "Nothing needs you." : "No agent status yet. Agents show up here when they report their status."))))
        // While dragging, Settled shows even empty: it's where a drop settles.
        // The free space above the shelves pushes them to the bottom; a drag over it lands in Active, as T3's
        // nearest-row drop does.
        .child(div().id("active-rest").flex_1().min_h(0).on_mouse_move((_e, cx) => aim({ section: "active" }, cx)))
        .child(shelves.when(put.length > 0 || (dragging && !busy(lifted)), (el) => el.child(tail))))
      // The lifted row moves only up and down, inside the list and below the Pinned label (T3's clamps).
      .when(Boolean(lifted) && d.y != null, (el) => el.child(div().id("drag-ghost").absolute().left(8).right(8)
        .top(ghostTop())
        .rounded(10).bg(t.selected).border(1).border_color(t.accent).shadow_lg()
        .child(from === "settled" ? slim(lifted, true) : card(lifted, true))));
    // A row that left the list under the pointer (to the folded Working shelf, or filtered out) never reports the pointer
    // leaving it: forget it, or its card and Settle come back with it.
    const gone = this.hovered;
    if (gone && !drawn.order.includes(gone)) {
      this.hovered = null;
      this.detailsWait?.cancel();
      if (this.details === gone) this.details = null;
      if (this.detailsOut === gone) this.detailsOut = null;
    }
    return tree;
  }
}
