// Full snapshots can replace one another; output chunks and user commands cannot.
export function snapshotEvents<T>(
  current: () => T,
  subscribe: (send: () => void) => () => void,
): Response {
  let pending: Uint8Array | undefined;
  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = () => {
        const data = encoder.encode(JSON.stringify(current()) + "\n");
        if ((controller.desiredSize ?? 0) > 0) controller.enqueue(data);
        else pending = data;
      };
      unsubscribe = subscribe(send);
      send();
      // Bun's ordinary request idle timeout also applies to streaming Unix responses.
      heartbeat = setInterval(send, 5000);
      heartbeat.unref();
    },
    pull(controller) {
      if (pending) {
        controller.enqueue(pending);
        pending = undefined;
      }
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe?.();
      pending = undefined;
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" },
  });
}
