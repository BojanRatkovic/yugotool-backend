import { Global, Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createDbClient, type DbClient } from "@zastava/db";
import type { Env } from "../config/env.schema";
import { DatabaseService } from "./database.service";
import { DB_CLIENT } from "./database.tokens";

@Global()
@Module({
  providers: [
    {
      provide: DB_CLIENT,
      useFactory: (config: ConfigService<Env, true>): DbClient =>
        createDbClient(config.get("DATABASE_URL", { infer: true })),
      inject: [ConfigService],
    },
    DatabaseService,
  ],
  exports: [DatabaseService],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(DB_CLIENT) private readonly client: DbClient) {}

  async onApplicationShutdown(): Promise<void> {
    await this.client.pool.end();
  }
}
