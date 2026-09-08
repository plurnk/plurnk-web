// Worker directory as a topology (plurnk-web#2): a forest from parentWorkerId,
// the bound conversation's tree first and marked ●, tree connectors in the
// labels, siblings newest first. Topology is navigation (plurnk-service#523):
// the map carries no lifecycle; a worker's state is seen by being in it.
export interface WorkerRowLike {
  id?: number | null;
  name: string;
  origin?: string | null;
  parentWorkerId?: number | null;
  createdAt?: string | null;
}

export interface WorkerOption {
  value: string;
  label: string;
}

// Newest first: the child just spawned is the one `Alt-l` enters.
const byCreated = (a: WorkerRowLike, b: WorkerRowLike): number => {
  const left = a.createdAt ?? "";
  const right = b.createdAt ?? "";
  if (left !== right) return left > right ? -1 : 1;
  return (b.id ?? 0) - (a.id ?? 0);
};

// Places are conversations and their descendants; the daemon's and a connection's scratch
// workers are never hop targets.
const isPlace = (row: WorkerRowLike): boolean => row.origin === "model";

const parentIn = (rows: readonly WorkerRowLike[]) => {
  const byId = new Map<number, WorkerRowLike>();
  for (const row of rows) if (typeof row.id === "number") byId.set(row.id, row);
  return (row: WorkerRowLike): WorkerRowLike | null =>
    typeof row.parentWorkerId === "number" ? byId.get(row.parentWorkerId) ?? null : null;
};

const siblingsOf = (rows: readonly WorkerRowLike[], current: WorkerRowLike): WorkerRowLike[] => {
  const parentOf = parentIn(rows);
  const parent = parentOf(current);
  return rows
    .filter((row) => (isPlace(row) || row === current) && (parentOf(row)?.id ?? null) === (parent?.id ?? null))
    .toSorted(byCreated);
};

export type Hop = "parent" | "enter" | "older" | "newer";

// One hop over the tree: `parent` climbs, `enter` descends to the newest child, `older`/`newer`
// walk siblings and wrap. A hop with nowhere to go names why.
export const hop = (rows: readonly WorkerRowLike[], bound: string, direction: Hop): { target: WorkerRowLike | null; notice: string | null } => {
  const parentOf = parentIn(rows);
  const current = rows.find((row) => row.name === bound) ?? null;
  if (current === null) return { target: null, notice: "no bound worker yet" };
  if (direction === "parent") {
    const parent = parentOf(current);
    return parent === null ? { target: null, notice: "at the root: no parent" } : { target: parent, notice: null };
  }
  if (direction === "enter") {
    const child = rows.filter((row) => isPlace(row) && parentOf(row) === current).toSorted(byCreated)[0] ?? null;
    return child === null ? { target: null, notice: "no children" } : { target: child, notice: null };
  }
  const siblings = siblingsOf(rows, current);
  if (siblings.length < 2) return { target: null, notice: "no siblings" };
  const index = siblings.indexOf(current);
  const step = direction === "older" ? 1 : -1;
  return { target: siblings[(index + step + siblings.length) % siblings.length]!, notice: null };
};

// `~` at a root, `~/fork-1/recheck` two hops down: the path from the tree root to the bound worker.
export const workerPath = (rows: readonly WorkerRowLike[], bound: string): string => {
  const parentOf = parentIn(rows);
  let current = rows.find((row) => row.name === bound) ?? null;
  if (current === null) return "~";
  const segments: string[] = [];
  for (let parent = parentOf(current); parent !== null; parent = parentOf(current)) {
    segments.unshift(current.name);
    current = parent;
  }
  return segments.length === 0 ? "~" : `~/${segments.join("/")}`;
};

export const siblingPosition = (rows: readonly WorkerRowLike[], bound: string): { index: number; count: number } | null => {
  const current = rows.find((row) => row.name === bound) ?? null;
  if (current === null) return null;
  const siblings = siblingsOf(rows, current);
  return siblings.length < 2 ? null : { index: siblings.indexOf(current) + 1, count: siblings.length };
};

// Alt-h/j/k/l, vim's tree orientation: depth horizontal, siblings vertical.
export const hopForKey = (event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; key: string }): Hop | null => {
  if (!event.altKey || event.ctrlKey || event.metaKey) return null;
  return event.key === "h" ? "parent" : event.key === "l" ? "enter" : event.key === "j" ? "older" : event.key === "k" ? "newer" : null;
};

export const workerTopology = (rows: readonly WorkerRowLike[], bound: string): WorkerOption[] => {
  const byId = new Map<number, WorkerRowLike>();
  for (const row of rows) if (typeof row.id === "number") byId.set(row.id, row);
  const parentOf = (row: WorkerRowLike): number | null =>
    typeof row.parentWorkerId === "number" && byId.has(row.parentWorkerId) ? row.parentWorkerId : null;
  const children = new Map<number | null, WorkerRowLike[]>();
  for (const row of rows) {
    const parent = parentOf(row);
    children.set(parent, [...(children.get(parent) ?? []), row]);
  }
  for (const siblings of children.values()) siblings.sort(byCreated);
  const rootOf = (row: WorkerRowLike): WorkerRowLike => {
    let current = row;
    for (let parent = parentOf(current); parent !== null; parent = parentOf(current)) current = byId.get(parent)!;
    return current;
  };
  const boundRow = rows.find((row) => row.name === bound);
  const boundRootName = boundRow === undefined ? null : rootOf(boundRow).name;
  // Roots newest first after the bound tree.
  const roots = (children.get(null) ?? []).toSorted((a, b) =>
    a.name === boundRootName ? -1 : b.name === boundRootName ? 1 : byCreated(a, b));
  const options: WorkerOption[] = [];
  const walk = (row: WorkerRowLike, prefix: string, connector: string): void => {
    options.push({ value: row.name, label: `${prefix}${connector}${row.name === bound ? "●" : "○"} ${row.name}` });
    const kids = typeof row.id === "number" ? children.get(row.id) ?? [] : [];
    const childPrefix = connector === "" ? "" : `${prefix}${connector.startsWith("└") ? "   " : "│  "}`;
    kids.forEach((kid, index) => walk(kid, childPrefix, index === kids.length - 1 ? "└─ " : "├─ "));
  };
  for (const root of roots) walk(root, "", "");
  return options;
};
