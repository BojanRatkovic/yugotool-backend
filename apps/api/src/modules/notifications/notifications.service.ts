import { Injectable } from "@nestjs/common";
import type {
  MarkNotificationsRead,
  NotificationListQuery,
  NotificationPage,
  UnreadCount,
} from "@yugotool/contracts";
import { DatabaseService } from "../../core/database/database.service";
import { EventsService } from "../../core/events/events.service";
import { NotificationsRepository } from "./notifications.repository";

/** The bell's reads and writes. Creating notifications is the job processor's. */
@Injectable()
export class NotificationsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: NotificationsRepository,
    private readonly events: EventsService,
  ) {}

  async list(query: NotificationListQuery): Promise<NotificationPage> {
    const db = this.database.db;
    // One extra row tells whether there is a next page.
    const rows = await this.repository.list(db, query.limit + 1, query.before);
    const items = rows.slice(0, query.limit);
    return {
      items,
      unreadCount: await this.repository.unreadCount(db),
      nextCursor: rows.length > query.limit ? (items.at(-1)?.id ?? null) : null,
    };
  }

  async markRead(input: MarkNotificationsRead): Promise<UnreadCount> {
    const db = this.database.db;
    await this.repository.markRead(db, input.all ? null : (input.ids ?? []));
    await this.events.publish({ type: "invalidate", collection: "notifications" });
    return { unreadCount: await this.repository.unreadCount(db) };
  }
}
