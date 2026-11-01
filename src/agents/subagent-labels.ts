import { singleLine, truncateCells } from "../ui/text.ts";

type NamedRun = {
  readonly id: string;
  readonly name: string;
  readonly ownerId?: string;
};

/** Name paths remain useful when active rows are shown ahead of settled ancestors. */
export function subagentLabels(runs: readonly NamedRun[]): ReadonlyMap<string, string> {
  const nodes = new Map(runs.map((run) => [run.id, run]));
  const siblings = new Map<string, NamedRun[]>();
  for (const run of runs) {
    const key = JSON.stringify([run.ownerId ?? null, run.name]);
    const group = siblings.get(key) ?? [];
    group.push(run);
    siblings.set(key, group);
  }
  const names = new Map<string, string>();
  for (const group of siblings.values()) {
    for (const [index, run] of group.entries()) {
      names.set(run.id, group.length > 1 ? `${run.name} [${index + 1}]` : run.name);
    }
  }

  const labels = new Map<string, string>();
  for (const run of runs) {
    const path = [names.get(run.id)!];
    const visited = new Set([run.id]);
    let owner = run.ownerId ? nodes.get(run.ownerId) : undefined;
    while (owner && !visited.has(owner.id)) {
      visited.add(owner.id);
      path.unshift(names.get(owner.id)!);
      owner = owner.ownerId ? nodes.get(owner.ownerId) : undefined;
    }
    labels.set(run.id, path.join(" › "));
  }
  return labels;
}

/** Preserve the active role's name before spending a compact row on its ancestors. */
export function compactSubagentLabel(label: string, width: number): string {
  const text = singleLine(label);
  if (Bun.stringWidth(text) <= width) return text;
  const separator = " › ";
  const boundary = text.lastIndexOf(separator);
  if (boundary < 0) return truncateCells(text, width);
  const leaf = text.slice(boundary + separator.length);
  const prefixWidth = width - Bun.stringWidth(leaf) - Bun.stringWidth(separator);
  if (prefixWidth < 1) return truncateCells(leaf, width);
  const ancestors = text.slice(0, boundary);
  const ordinals = ancestors.match(/\[\d+\]/gu) ?? [];
  const suffix = ordinals.length ? `… ${ordinals.join("/")}` : "…";
  const prefix =
    Bun.stringWidth(suffix) <= prefixWidth
      ? truncateCells(ancestors, prefixWidth, suffix)
      : truncateCells(ordinals.join("/"), prefixWidth);
  return `${prefix}${separator}${leaf}`;
}
