import { BoxRenderable, TextRenderable, createCliRenderer } from "@opentui/core";

const renderer = await createCliRenderer({ exitOnCtrlC: true });

try {
  const screen = new BoxRenderable(renderer, {
    width: "100%",
    height: "100%",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 1,
  });

  screen.add(
    new TextRenderable(renderer, {
      content: "Hello, Radian!",
      fg: "#7DD3FC",
    }),
  );
  screen.add(
    new TextRenderable(renderer, {
      content: "Press q, Esc, or Ctrl+C to quit.",
      fg: "#94A3B8",
    }),
  );
  renderer.root.add(screen);

  renderer.keyInput.on("keypress", (key) => {
    if (key.name === "q" || key.name === "escape") {
      renderer.destroy();
    }
  });

  await renderer.closed;
} finally {
  renderer.destroy();
  await renderer.closed;
}
