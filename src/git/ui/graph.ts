import type { GitCommit } from "../model.ts";

// Port of the user's nvim/lua/git/graph.lua lane routing, independent of Neovim.
export const graphPalette = [
  "git.graph.1",
  "git.graph.2",
  "git.graph.3",
  "git.graph.4",
  "git.graph.5",
  "git.graph.6",
  "git.graph.7",
  "git.graph.8",
] as const;

type GraphColor = (typeof graphPalette)[number];

type Lane = { target: string | null; color: GraphColor; dotted?: boolean };

type Edge = {
  from: number;
  to: number;
  color: GraphColor;
  dotted: boolean;
  kind: "lane" | "parent";
};

export type GraphCommit = GitCommit & { workingTree?: boolean };

export type GraphCell = { text: string; color?: GraphColor };

export type GraphRow = {
  commit: GraphCommit;
  color: GraphColor;
  nodeColumn: number;
  node: GraphCell[];
  connector: GraphCell[];
};

const glyphs = [" ", "│", "│", "│", "─", "╯", "╮", "┤", "─", "╰", "╭", "├", "─", "┴", "┬", "┼"];
const column = (lane: number) => lane * 3 + 1;
const find = (lanes: Lane[], target: string) => lanes.findIndex((lane) => lane.target === target);

function vacancy(lanes: Lane[], start: number): number {
  for (let i = start; i < lanes.length; i++) {
    if (!lanes[i]!.target) {
      return i;
    }
  }
  for (let i = 0; i < start; i++) {
    if (!lanes[i]?.target) {
      return i;
    }
  }

  return lanes.length;
}

export function layoutGraph(commits: readonly GraphCommit[], width = 24): GraphRow[] {
  let lanes: Lane[] = [];
  let nextColor = 0;
  const color = () => graphPalette[nextColor++ % graphPalette.length]!;
  const rows: GraphRow[] = [];
  for (const commit of commits) {
    let lane = find(lanes, commit.oid);
    if (lane === -1) {
      lane = vacancy(lanes, 0);
      lanes[lane] = { target: commit.oid, color: color(), dotted: commit.workingTree ?? false };
    }

    const before = [...lanes];
    const current = before[lane]!;
    const after = [...before];

    after[lane] = { target: null, color: current.color };

    const edges: Edge[] = [];
    for (let i = 0; i < before.length; i++) {
      const other = before[i]!;
      if (i !== lane && other.target) {
        edges.push({
          from: i,
          to: i,
          color: other.color,
          dotted: other.dotted ?? false,
          kind: "lane",
        });
      }
    }
    for (const [i, parent] of commit.parents.entries()) {
      let destination = find(after, parent);
      if (destination === -1) {
        destination = !after[lane]!.target ? lane : vacancy(after, lane + 1);
        after[destination] = {
          target: parent,
          color: destination === lane ? current.color : color(),
          dotted: commit.workingTree ?? false,
        };
      }

      edges.push({
        from: lane,
        to: destination,
        color: i === 0 ? current.color : after[destination]!.color,
        dotted: commit.workingTree ?? false,
        kind: "parent",
      });
    }
    while (after.length && !after.at(-1)!.target) {
      after.pop();
    }

    const node: GraphCell[] = Array.from({ length: width }, () => ({ text: " " }));
    for (const [i, item] of before.entries()) {
      if (item.target && column(i) < width) {
        node[column(i)] = {
          text: i === lane ? (commit.workingTree ? "◌" : "●") : item.dotted ? "┊" : "│",
          color: item.color,
        };
      }
    }

    const cells = Array.from({ length: width }, () => ({
      mask: 0,
      color: undefined as GraphColor | undefined,
      dotted: false,
      lane: false,
    }));
    for (const edge of edges) {
      const from = column(edge.from);
      const to = column(edge.to);
      if (from >= width || to >= width) {
        continue;
      }

      const connect = (position: number, direction: number) => {
        const cell = cells[position]!;
        if (cell.lane && edge.kind === "parent") {
          return;
        }

        cell.mask |= direction;
        cell.color = edge.kind === "parent" && position === from ? current.color : edge.color;
        cell.dotted = edge.dotted;
        cell.lane = edge.kind === "lane";
      };
      if (from === to) {
        connect(from, 3);
      } else {
        connect(from, from < to ? 9 : 5);
        for (let i = Math.min(from, to) + 1; i < Math.max(from, to); i++) {
          connect(i, 12);
        }

        connect(to, to < from ? 10 : 6);
      }
    }

    rows.push({
      commit,
      color: current.color,
      nodeColumn: column(lane),
      node,
      connector: cells.map((cell) => ({
        text:
          cell.dotted && glyphs[cell.mask] === "│"
            ? "┊"
            : cell.dotted && glyphs[cell.mask] === "─"
              ? "┄"
              : glyphs[cell.mask]!,
        ...(cell.color ? { color: cell.color } : {}),
      })),
    });
    lanes = after;
  }

  return rows;
}
