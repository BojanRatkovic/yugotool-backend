import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EVENTS_CHANNEL, type ServerEvent, serverEventSchema } from "@zastava/contracts";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { Subject, type Observable } from "rxjs";
import type { Env } from "../config/env.schema";
import { DatabaseService } from "../database/database.service";

/**
 * Bridges Postgres LISTEN/NOTIFY to in-process subscribers (the SSE endpoint).
 * Publishing goes through NOTIFY too, so the worker and the API share one path
 * and every API instance sees every event.
 */
@Injectable()
export class EventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventsService.name);
  private readonly subject = new Subject<ServerEvent>();
  private listener: Client | null = null;

  constructor(
    private readonly config: ConfigService<Env, true>,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  async onModuleInit(): Promise<void> {
    const listener = new Client({
      connectionString: this.config.get("DATABASE_URL", { infer: true }),
    });
    await listener.connect();
    listener.on("notification", (message) => {
      if (!message.payload) return;
      const parsed = serverEventSchema.safeParse(JSON.parse(message.payload));
      if (parsed.success) this.subject.next(parsed.data);
      else this.logger.warn(`dropping malformed event: ${message.payload}`);
    });
    listener.on("error", (error) => this.logger.error("event listener failed", error.stack));
    await listener.query(`LISTEN ${EVENTS_CHANNEL}`);
    this.listener = listener;
  }

  async onModuleDestroy(): Promise<void> {
    this.subject.complete();
    await this.listener?.end();
  }

  get stream(): Observable<ServerEvent> {
    return this.subject.asObservable();
  }

  async publish(event: ServerEvent): Promise<void> {
    await this.database.db.execute(
      sql`SELECT pg_notify(${EVENTS_CHANNEL}, ${JSON.stringify(event)})`,
    );
  }
}
