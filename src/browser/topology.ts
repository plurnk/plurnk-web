// Worker directory as a topology (plurnk-web#2): a forest from parentWorkerId,
// the bound conversation's tree first and marked ●, tree connectors in the
// labels. Lifecycle glyphs for other workers arrive with plurnk-service#523;
// nothing is inferred here.
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

const byCreated = (a: WorkerRowLike, b: WorkerRowLike): number => {
  const left = a.createdAt ?? "";
  const right = b.createdAt ?? "";
  if (left !== right) return left < right ? -1 : 1;
  return (a.id ?? 0) - (b.id ?? 0);
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
