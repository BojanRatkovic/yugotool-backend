import { type ServerEvent, serverEventSchema } from "@yugotool/contracts";

/** Splits an SSE byte stream into `data:` payloads; keeps the unfinished tail. Pure. */
export function parseSse(buffer: string): { events: string[]; rest: string } {
  const blocks = buffer.split("\n\n");
  const rest = blocks.pop() ?? "";
  const events = blocks.flatMap((block) => {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    return data ? [data] : [];
  });
  return { events, rest };
}

/**
 * Follows the API's SSE stream (`/api/events`) from the main process and
 * reconnects after drops. Returns a function that stops it.
 */
export function followEvents(url: string, onEvent: (event: ServerEvent) => void): () => void {
  const state = { stopped: false };
  let controller: AbortController | null = null;

  const loop = async (): Promise<void> => {
    while (!state.stopped) {
      controller = new AbortController();
      try {
        const res = await fetch(url, {
          headers: { accept: "text/event-stream" },
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`events: HTTP ${res.status}`);
        const decoder = new TextDecoder();
        let buffer = "";
        for await (const chunk of res.body) {
          buffer += decoder.decode(chunk, { stream: true });
          const { events, rest } = parseSse(buffer);
          buffer = rest;
          for (const data of events) {
            try {
              const parsed = serverEventSchema.safeParse(JSON.parse(data));
              if (parsed.success) onEvent(parsed.data);
            } catch {
              // not JSON (comments, keep-alives)
            }
          }
        }
      } catch {
        // dropped or not up yet; retry below
      }
      if (!state.stopped) await new Promise((r) => setTimeout(r, 2_000));
    }
  };
  void loop();
  return () => {
    state.stopped = true;
    controller?.abort();
  };
}
