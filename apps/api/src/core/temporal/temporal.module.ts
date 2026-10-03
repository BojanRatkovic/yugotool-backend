import { Global, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Client, Connection } from "@temporalio/client";
import type { Env } from "../config/env.schema";

export const TEMPORAL_CLIENT = Symbol("TEMPORAL_CLIENT");

/**
 * Provides the single shared Temporal `Client`. The API only starts, signals
 * and queries workflows — executing them is the worker's job.
 */
@Global()
@Module({
  providers: [
    {
      provide: TEMPORAL_CLIENT,
      useFactory: (config: ConfigService<Env, true>): Client => {
        const connection = Connection.lazy({
          address: config.get("TEMPORAL_ADDRESS", { infer: true }),
        });
        return new Client({
          connection,
          namespace: config.get("TEMPORAL_NAMESPACE", { infer: true }),
        });
      },
      inject: [ConfigService],
    },
  ],
  exports: [TEMPORAL_CLIENT],
})
export class TemporalModule {}
