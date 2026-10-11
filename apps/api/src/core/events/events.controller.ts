import { Controller, type MessageEvent, Sse } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { interval, map, merge, type Observable, takeUntil } from "rxjs";
import { EventsService } from "./events.service";

/** Heartbeat keeps proxies from closing an idle stream. */
const HEARTBEAT_MS = 25_000;

@ApiTags("events")
@Controller("events")
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Sse()
  stream(): Observable<MessageEvent> {
    return merge(
      this.events.stream.pipe(map((event) => ({ data: event }))),
      interval(HEARTBEAT_MS).pipe(
        map(() => ({ type: "heartbeat", data: "" })),
        // Stop with the event stream (shutdown), or the response never ends.
        takeUntil(this.events.closed),
      ),
    );
  }
}
