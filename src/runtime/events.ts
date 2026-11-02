// Full snapshots can replace one another; output chunks and user commands cannot.
// Frames are built only when the stream accepts them, so a backlogged client receives the latest
// state once and `current` can track exactly what each stream has delivered.
export function snapshotEvents<T>(
  current: () => T,
  subscribe: (send: () => void) => () => void,
): Response {
  let pending = false;
  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const encoder = new TextEncoder();
  const frame = () => encoder.encode(JSON.stringify(current()) + "\n");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = () => {
        if ((controller.desiredSize ?? 0) > 0) {
          controller.enqueue(frame());
        } else {
          pending = true;
        }
      };
      unsubscribe = subscribe(send);
      send();
      // Bun's ordinary request idle timeout also applies to streaming Unix responses.
      heartbeat = setInterval(send, 5000);
      heartbeat.unref();
    },
    pull(controller) {
      if (pending) {
        pending = false;
        controller.enqueue(frame());
      }
    },
    cancel() {
      if (heartbeat) {
        clearInterval(heartbeat);
      }

      unsubscribe?.();
      pending = false;
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" },
  });
}
