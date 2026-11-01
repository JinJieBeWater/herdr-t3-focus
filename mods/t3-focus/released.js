// Copied by scripts/sync.sh: mods can only import from their own folder.
import { agents, terminals, panes, spaces, shared, setShared, run, layout } from "herdr";

export const releaseRecords = () => shared("t3.released") ?? {};
export const saveReleaseRecords = (records) => setShared("t3.released", records);
export const releaseBusy = (root) => shared("t3.releasing")?.root === root && Date.now() - shared("t3.releasing").at < 5 * 60000;
export function localizeRecord(r) {
  const raw = (id) => id?.split("/").at(-1);
  const s = spaces().find((s) => raw(s.id) === raw(r.space));
  if (!s) return null;
  const id = (value) => value ? `${s.machine ? s.machine + "/" : ""}${raw(value)}` : value;
  const tab = s.tabs.find((c) => raw(c.id) === raw(r.tab))?.id ?? id(r.tab);
  const pane = panes().find((p) => p.tab === tab && raw(p.pane) === raw(r.pane))?.pane ?? id(r.pane);
  return { ...r, machine: s.machine ?? null, address: id(r.address), root: id(r.root), pane,
    replacement: id(r.replacement), space: s.id, space_name: s.name, tab };
}
export function pinKey(k) {
  const file = k?.labels?.["pi.session_file"] || k?.labels?.["t3.resume"] || k?.resume;
  return file ? `${k.address?.includes("/") ? k.address.split("/")[0] + ":" : ""}${file}` : k?.address;
}

export function withReleased() {
  const live = agents();
  const running = new Set(terminals().filter((k) => k.state === "live").map((k) => k.address));
  const ps = panes(), sp = spaces();
  return [...live, ...Object.values(releaseRecords()).map(localizeRecord).filter((r) => r?.pane && !running.has(r.address)).flatMap((r) => {
    const tab = ps.find((p) => p.pane === r.pane)?.tab ?? r.tab;
    const space = sp.find((s) => s.tabs.some((c) => c.id === tab));
    return space ? [{ ...r, tab, space: space.id, space_name: space.name, status: "idle", focused: false, released: true }] : [];
  })];
}

export function focusAgent(a) {
  if (!a.released) return run("agent.focus", { terminal: a.address });
  const hasView = (n) => n?.id === "view" || (n?.children ?? []).some(hasView);
  if (hasView(layout())) run("layout.select", { stack: "view", child: "main" });
  run("space.select", { id: a.space });
  run("tab.select", { id: a.tab });
  run("pane.focus", { pane: a.pane });
}
