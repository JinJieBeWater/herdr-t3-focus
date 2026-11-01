// The focus sidebar: no spaces, only the agents still asking for attention, as cards, latest news first.
// Below, as in T3: Working (busy agents, folded) and Settled (put away by hand until new work brings them back).
// Settled lives on the agent's own terminal as `settled=<ms>:<turn>`: it ends with the terminal, every mod
// sees it, and a turn ended since says there was new work even while no window watched. Looking doesn't count.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, Popover, InputState, Input } from "gpui-base";
import { agents, terminals, panes, spaces, run, hc, notify, theme, shared, setAgentOrder, props } from "herdr";
import { namer } from "./name.js";
import { withReleased, releaseRecords, saveReleaseRecords, focusAgent } from "./released.js";

const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
const BUSY = new Set(["working", "blocked"]);
// Space avatar colors, as the Herdr T3 layout's t3-spaces draws them (shared "space.colors").
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
// The settled tail opens on this many, then grows by MORE.
const FIRST = 10, MORE = 25;

// A sub-agent's own word: error counts as blocked; its done is its parent's news, not its own.
const kidStatus = (k, listed) => {
  const s = listed.get(k.address) ?? k.status;
  return s === "error" ? "blocked" : s === "done" ? "idle" : s;
};

function ago(ms, now) {
  const m = Math.floor((now - ms) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h`;
  if (m < 10080) return `${Math.floor(m / 1440)}d`;
  return `${Math.floor(m / 10080)}w`;
}

// How long it's been working: seconds, then as ago() counts.
function took(ms, now) {
  const s = Math.floor((now - ms) / 1000);
  return s < 60 ? `${s}s` : ago(ms, now);
}

// The program's icon from the app's table: a one-color glyph or a picture.
function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

export default class Focus extends View {
  init(_props, cx) {
    // Each agent's last state and when we saw it change or brought it back (ms; 0: before we were watching).
    this.changed = JSON.parse(localStorage.getItem("changes") ?? "{}");
    this.open = localStorage.getItem("open") === "true";
    this.workOpen = localStorage.getItem("working-open") === "true";
    this.limit = FIRST;
    // Settled labels written but not back from the core yet: address → value ("" = removed).
    this.pending = {};
    this.hovered = null;
    // The spaces shown, as T3 scopes threads to projects; none: all of them.
    this.scope = JSON.parse(localStorage.getItem("scope") ?? "[]");
    this.scopeOpen = false;
    this.search = InputState.new({ placeholder: "Search spaces…" });
    this.search.on("change", (_e, cx) => cx.notify());
    this.search.on("submit", (_e, cx) => this.pick(this.matches()[0], false, cx));
    // "Working 9s" counts up only while such a card shows.
    cx.timer.every(1000, (cx) => { if (this.ticking) cx.notify(); });
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
    if (!shift) this.scopeOpen = false;
    cx.notify();
  }

  // Done and idle count as one: looking at a finished agent turns done into idle, and looking isn't news.
  track(list, now) {
    let dirty = false;
    for (const a of list) {
      const s = a.status === "done" ? "idle" : a.status;
      const was = this.changed[a.address];
      if (was?.s === s) continue;
      // First sight says nothing about when it changed.
      this.changed[a.address] = { s, at: was ? now : 0 };
      dirty = true;
    }
    if (!dirty) return;
    const listed = new Set(list.map((a) => a.address));
    for (const k of Object.keys(this.changed)) if (!listed.has(k)) delete this.changed[k];
    localStorage.setItem("changes", JSON.stringify(this.changed));
  }

  descendants(all, addr) {
    return all.filter((k) => k.parent === addr && k.state === "live").flatMap((k) => [k, ...this.descendants(all, k.address)]);
  }

  // Shown at once; the label comes back from the core a moment later.
  setSettled(addr, value, cx) {
    this.pending[addr] = value;
    const record = releaseRecords()[addr];
    if (record) saveReleaseRecords({ ...releaseRecords(), [addr]: { ...record, settled: value } });
    cx.spawn(async (cx) => {
      const r = await hc(["label", addr, `settled=${value}`]).catch((e) => ({ code: 1, stderr: String(e) }));
      if (r.code === 0) return;
      delete this.pending[addr];
      notify({ title: "Couldn't update the agent", body: r.stderr.trim(), level: "error" });
      cx.notify();
    });
  }

  render(cx) {
    const t = theme(), now = Date.now();
    const every = withReleased(), all = terminals(), ps = panes(), sp = spaces();
    // A space that's gone reads as all; its id stays stored, so the scope returns with it.
    const scope = this.scope.filter((id) => sp.some((s) => s.id === id));
    const list = scope.length ? every.filter((a) => scope.includes(a.space)) : every;
    const listed = new Map(every.map((a) => [a.address, a.status]));
    const term = new Map(all.map((k) => [k.address, k]));
    for (const [k, v] of Object.entries(this.pending)) if (!term.has(k) || (term.get(k).labels?.settled ?? "") === v) delete this.pending[k];
    const settledAt = (a) => {
      const v = this.pending[a.address] ?? (a.released ? a.settled : term.get(a.address)?.labels?.settled);
      return v ? v.split(":").map(Number) : null;
    };
    const tree = new Map(every.map((a) => [a.address, this.descendants(all, a.address)]));
    const kids = new Map(every.map((a) => [a.address, tree.get(a.address).map((k) => kidStatus(k, listed))]));
    // It, or anything under it, is working or needs the person.
    const busy = (a) => BUSY.has(a.status) || kids.get(a.address).some((s) => BUSY.has(s));
    // New work brings a settled agent back: busy now, or a turn ended since it was settled. Hidden ones too.
    for (const a of every) {
      const s = settledAt(a);
      if (s && (busy(a) || (term.get(a.address)?.turn ?? 0) > s[1])) this.setSettled(a.address, "", cx);
    }
    // Sub-agents without a pane are tracked too, so a parent waiting on them can say how long they've worked.
    const subs = all.filter((k) => k.parent && k.state === "live" && !listed.has(k.address)).map((k) => ({ address: k.address, status: kidStatus(k, listed) }));
    this.track([...every, ...subs], now);
    // Seen changing, then; before that, the core's time of its last change. terminals() only has that as of
    // the app's start (status_ms isn't updated live), so it serves only until we see a change ourselves.
    const since = (a) => this.changed[a.address]?.at || term.get(a.address)?.status_ms || 0;
    // Working since: its own turn, else its longest-working sub-agent's.
    const started = (a) => a.status === "working" ? since(a)
      : Math.min(Infinity, ...tree.get(a.address).filter((k) => kidStatus(k, listed) === "working").map(since).filter((ms) => ms > 0));
    // The most urgent of it and what's under it.
    const state = (a) => [a.status, ...kids.get(a.address)].reduce((m, s) => ((RANK[s] ?? 0) > (RANK[m] ?? 0) ? s : m));
    // T3's Working: busy, or waiting on sub-agents it will hear back from; needing the person keeps it up top.
    const working = (a) => state(a) !== "blocked" && (a.status === "working" || kids.get(a.address).includes("working"));
    // Up top by when each came back to the person; Working by when it was last set going.
    const newest = (x, y) => since(y) - since(x) || y.seq - x.seq;
    const out = list.filter((a) => !settledAt(a) && !working(a)).sort(newest);
    const work = list.filter((a) => !settledAt(a) && working(a)).sort(newest);
    const put = list.filter(settledAt).sort((x, y) => settledAt(y)[0] - settledAt(x)[0]);
    // Settled agents aren't passed: Herdr appends them, so agent.next reaches them last.
    setAgentOrder([...out, ...work].map((a) => a.address));

    const title = namer();
    const hover = (a) => (on, cx) => {
      if (on) this.hovered = a.address;
      else if (this.hovered === a.address) this.hovered = null;
      cx.notify();
    };
    // A button's icon and text brighten together: a hover style reaches the text but not the svg, so it's state.
    const glow = (id) => (on, cx) => {
      if (on) this.hot = id;
      else if (this.hot === id) this.hot = null;
      cx.notify();
    };
    const lit = (id, color) => (this.hot === id ? t.foreground : color);
    // A space's avatar, as t3-spaces draws it.
    const avatar = (id, name, size) => {
      const color = (shared("space.colors") ?? {})[id] ?? "ansi6";
      return h_flex().size(size).flex_none().rounded(4).bg(color.startsWith("#") ? color : MARK[color] ?? t[color])
        .items_center().justify_center().text_size(size * 0.64).font_bold().text_color("#ffffff")
        .child([...(name ?? "")][0]?.toUpperCase() ?? "?");
    };

    const card = (a) => {
      const st = state(a), on = a.focused;
      const machine = a.address.includes("/") ? a.address.split("/")[0] : null;
      const branch = ps.find((p) => p.pane === a.pane)?.branch;
      const going = kids.get(a.address).filter((s) => s === "working").length;
      const meta = [branch, going ? `${going} sub-agent${going > 1 ? "s" : ""} working` : null].filter(Boolean).join(" · ");
      const pic = icon(a.program, 16, t.muted);
      // Hovered, the corner offers Settle, but only for what's finished: a working or stuck tree stays in sight.
      const offer = this.hovered === a.address && !busy(a);
      const id = `settle-${a.address}`;
      // As in T3, the corner says the state when there's one worth saying (Working, Needs you, Done: finished
      // and not yet seen), else how long ago it last changed.
      const pill = (color, mark, label) => h_flex().id(`state-${a.address}`).h(20).gap(4).flex_none().items_center().font_medium().text_color(color)
        .child(mark).child(div().child(label));
      const corner = offer
        ? h_flex().id(id).h(20).px(6).gap(4).flex_none().items_center().rounded(6)
          .text_size(12).text_color(lit(id, t.muted)).on_hover(glow(id))
          .role("button").accessibility_label("Settle")
          .on_click((_e, cx) => {
            cx.stop_propagation();
            // The card moves away without a pointer-leave event.
            this.hovered = null;
            this.setSettled(a.address, `${Date.now()}:${term.get(a.address)?.turn ?? 0}`, cx);
            // Settling the agent in view moves on to the next card; one in the background moves nothing.
            const i = out.indexOf(a), next = out[i + 1] ?? out[i - 1];
            if (a.focused && next) run("agent.focus", { terminal: next.address });
            cx.notify();
          })
          .child(svg("mods/workspace-chrome/check.svg").size(12).flex_none().text_color(lit(id, t.muted)))
          .child("Settle")
        : working(a)
          ? pill(t.working, svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900),
            started(a) > 0 && started(a) < Infinity ? `Working ${took(started(a), now)}` : "Working")
          : st === "blocked"
            ? pill(t.blocked, div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(11).font_bold().flex().items_center().justify_center().child("!"), "Needs you")
            : st === "done"
              ? pill(t.ansi2, svg("mods/workspace-chrome/circle-check.svg").size(14).flex_none().text_color(t.ansi2), "Done")
              : div().id(`state-${a.address}`).flex_none().child(since(a) > 0 ? ago(since(a), now) : "");
      return v_flex().id(`card-${a.address}`).px(10).py(8).gap(2).flex_none().rounded(10)
        .when(on, (el) => el.bg(t.selected))
        .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
        .role("button").accessibility_label(title(a))
        .on_hover(hover(a))
        // agent.focus, not pane.focus: in tabs it focuses the pane, and it picks what the agent view shows.
        .on_click(() => focusAgent(a))
        .child(h_flex().h(20).gap(6).items_center().text_size(12).text_color(t.dim)
          .child(avatar(a.space, a.space_name, 14))
          .child(div().flex_1().min_w(0).truncate().child(machine ? `${a.space_name} · ${machine}` : a.space_name ?? ""))
          .child(corner))
        .child(h_flex().gap(8).items_center()
          // Only the one in view is bright, as in T3.
          .child(div().flex_1().min_w(0).truncate().text_size(14).text_color(on ? t.foreground : t.muted).child(title(a)))
          .when(a.released, (el) => el.child(div().text_size(11).text_color(t.dim).child("Released")))
          .when(Boolean(pic), (el) => el.child(pic)))
        .when(Boolean(meta), (el) => el.child(div().min_w(0).truncate().text_size(12).text_color(t.dim).child(meta)));
    };

    // A settled row: one dim line; viewing it leaves it settled. Hovered it brightens and its time
    // becomes a bare undo arrow, as in T3.
    const slim = (a) => {
      const on = a.focused, over = this.hovered === a.address, bright = on || over;
      const pic = icon(a.program, 14, t.dim);
      const undo = h_flex().id(`unsettle-${a.address}`).size(20).flex_none().items_center().justify_center().rounded(4)
        .on_hover(glow(`unsettle-${a.address}`))
        .role("button").accessibility_label("Unsettle")
        .on_click((_e, cx) => {
          cx.stop_propagation();
          this.hovered = null;
          this.setSettled(a.address, "", cx);
          // Brought back, it's news again: the top of the list.
          this.changed[a.address] = { ...this.changed[a.address], at: Date.now() };
          localStorage.setItem("changes", JSON.stringify(this.changed));
          cx.notify();
        })
        .child(svg("mods/t3-focus/undo.svg").size(14).flex_none().text_color(lit(`unsettle-${a.address}`, t.muted)));
      return h_flex().id(`slim-${a.address}`).h(30).px(10).gap(8).flex_none().items_center().rounded(8)
        .when(on, (el) => el.bg(t.selected))
        .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
        .role("button").accessibility_label(title(a))
        .on_hover(hover(a))
        .on_click(() => focusAgent(a))
        .child(h_flex().size(16).flex_none().items_center().justify_center().opacity(bright ? 1 : 0.5).when(Boolean(pic), (el) => el.child(pic)))
        .child(div().flex_1().min_w(0).truncate().text_color(bright ? t.foreground : t.muted).child(title(a)))
        .when(a.released, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child("Released")))
        .child(over ? undo : div().flex_none().text_size(12).text_color(t.dim).child(ago(settledAt(a)[0], now)));
    };

    // A shelf's header, folding it: label, then count and chevron at the far edge.
    const shelf = (id, label, count, open, toggle) => h_flex().id(id).h(30).px(10).gap(6).flex_none().items_center()
      .text_size(12).font_medium().text_color(t.dim)
      .role("button").accessibility_label(`${open ? "Hide" : "Show"} ${label.toLowerCase()} agents`)
      .on_click((_e, cx) => {
        toggle();
        cx.notify();
      })
      .child(div().flex_1().child(label))
      .child(div().child(String(count)))
      .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none());

    // Shelves fold by default on this screen; the one in view stays out even folded or past the page, so it's never lost.
    const busyRows = this.workOpen ? work : work.filter((a) => a.focused);
    this.ticking = busyRows.length > 0;
    // The first shelf takes the free space above it, so both sit at the bottom.
    const shelves = v_flex().id("shelves").mt_auto().pt(12).flex_none()
      .when(work.length > 0, (el) => el
        .child(shelf("working-header", "Working", work.length, this.workOpen, () => {
          this.workOpen = !this.workOpen;
          localStorage.setItem("working-open", String(this.workOpen));
        }))
        .child(v_flex().gap(2).children(busyRows.map(card))));
    const page = this.open ? put.slice(0, this.limit) : [];
    const rows = [...page, ...put.filter((a) => a.focused && !page.includes(a))];
    const tail = v_flex().id("settled").flex_none()
      .child(shelf("settled-header", "Settled", put.length, this.open, () => {
        this.open = !this.open;
        this.limit = FIRST;
        localStorage.setItem("open", String(this.open));
      }))
      .children(rows.map(slim))
      .when(this.open && put.length > this.limit, (el) => el.child(h_flex().id("settled-more").h(30).px(10).gap(8).flex_none().items_center().rounded(8)
        .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .role("button").accessibility_label("Show more settled agents")
        .on_click((_e, cx) => {
          this.limit += MORE;
          cx.notify();
        })
        .child(svg("mods/workspace-chrome/chevron-down.svg").size(12).flex_none())
        .child(`Show ${Math.min(MORE, put.length - this.limit)} more`)));

    // T3's top row: search on the left, then the space filter, new space and new agent.
    const tool = (id, label, icon, fn) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6)
      .hover((s) => s.bg(t.hover)).on_hover(glow(id))
      .role("button").accessibility_label(label).on_click(fn)
      .child(svg(`mods/workspace-chrome/${icon}.svg`).size(14).text_color(lit(id, t.dim)));
    // The filter shows what it filters to: one avatar, two overlapping, or the plain filter icon.
    const scoped = sp.filter((s) => scope.includes(s.id));
    const choice = (s) => {
      const on = s.id ? scope.includes(s.id) : scope.length === 0;
      // Selection is a check badge on the icon, as in T3.
      return h_flex().id(`scope-${s.id ?? "all"}`).h(32).px(8).gap(10).flex_none().items_center().rounded(6)
        .hover((st) => st.bg(t.hover))
        .role("button").accessibility_label(s.name)
        .on_click((e, cx) => this.pick(s, e.modifiers.shift, cx))
        .child(div().relative().flex_none()
          .child(s.id ? avatar(s.id, s.name, 16) : svg("mods/workspace-chrome/folder.svg").size(16).text_color(t.muted))
          .when(on, (el) => el.child(h_flex().absolute().right(-4).bottom(-4).size(12).rounded_full().bg(t.accent)
            .border(2).border_color(t.popover).items_center().justify_center()
            .child(svg("mods/workspace-chrome/check.svg").size(7).text_color("#ffffff")))))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(s.name));
    };
    const filter = Popover.new("focus-scope-menu").anchor("top_right").open(this.scopeOpen)
      .on_open_change((open, cx) => {
        this.scopeOpen = open;
        if (open) {
          this.search.set_value("");
          this.search.focus();
        }
        cx.notify();
      })
      .trigger(h_flex().id("focus-scope").size(26).flex_none().items_center().justify_center().rounded(6)
        .hover((s) => s.bg(t.hover)).on_hover(glow("focus-scope"))
        .role("button").accessibility_label(scoped.length ? `Filter by space: ${scoped.map((s) => s.name).join(", ")}` : "Filter by space")
        .child(scoped.length > 1
          ? h_flex().children(scoped.slice(0, 2).map((s, i) => avatar(s.id, s.name, 14).when(i > 0, (el) => el.ml(-6))))
          : scoped.length
            ? avatar(scoped[0].id, scoped[0].name, 16)
            : svg("mods/t3-focus/list-filter.svg").size(14).text_color(lit("focus-scope", t.dim))))
      .content(v_flex().id("focus-scope-panel").w(260).max_h(360).mt(4).p(6).gap(2).rounded(10)
        .bg(t.popover).border_1().border_color(t.border).text_size(13)
        .child(h_flex().h(32).px(8).gap(8).flex_none().items_center().border_b_1().border_color(t.border)
          .child(svg("mods/workspace-chrome/search.svg").size(14).flex_none().text_color(t.dim))
          .child(Input.new(this.search).flex_1().h_full().text_size(13).text_color(t.foreground)))
        .child(v_flex().id("focus-scope-list").min_h(0).pt(4).gap(2).overflow_y_scroll()
          .children(this.matches().map(choice))
          .when(this.matches().length === 0, (el) => el.child(div().px(8).py(6).text_color(t.dim).child("No matching spaces.")))));
    // Right edge as the brand bar's above (pr 10), so the two rows of icons line up.
    const top = h_flex().id("focus-top").h(32).pl(8).pr(10).gap(2).flex_none().items_center()
      .child(h_flex().id("focus-search").flex_1().h(26).px(10).gap(8).items_center().rounded(6)
        .text_color(lit("focus-search", t.dim)).hover((s) => s.bg(t.hover)).on_hover(glow("focus-search"))
        .role("button").accessibility_label("Search").on_click(() => run("mod.open", { name: "picker" }))
        .child(svg("mods/workspace-chrome/search.svg").size(14).flex_none().text_color(lit("focus-search", t.dim)))
        .child(div().child("Search")))
      .child(filter)
      .child(tool("focus-new-space", "New space", "folder-plus", () => run("space.new")))
      // The layout passes its own menu; docked alone, the shipped one.
      .child(tool("focus-new-agent", "New agent", "square-pen", () => run("mod.open", { name: props()?.newMenu ?? "new-menu" })));

    return v_flex().id("t3-focus-root").size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(top)
      .child(v_flex().id("focus-list").flex_1().min_h(0).px(8).py(8).gap(2).overflow_y_scroll()
        .children(out.map(card))
        .when(out.length === 0, (el) => el.child(div().px(10).py(8).text_size(12).text_color(t.dim)
          .child(every.length ? "Nothing needs you." : "No agent status yet. Agents show up here when they report their status.")))
        .child(shelves.when(put.length > 0, (el) => el.child(tail))));
  }
}
