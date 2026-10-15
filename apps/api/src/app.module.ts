import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { validateEnv } from "./core/config/env.schema";
import { DatabaseModule } from "./core/database/database.module";
import { EventsModule } from "./core/events/events.module";
import { TemporalModule } from "./core/temporal/temporal.module";
import { ClaudeAccountsModule } from "./modules/claude-accounts/claude-accounts.module";
import { CommunityModule } from "./modules/community/community.module";
import { DispatcherModule } from "./modules/dispatcher/dispatcher.module";
import { HealthModule } from "./modules/health/health.module";
import { KnowledgeModule } from "./modules/knowledge/knowledge.module";
import { NotificationsModule } from "./modules/notifications/notifications.module";
import { PullRequestsModule } from "./modules/pull-requests/pull-requests.module";
import { ProductiveModule } from "./modules/productive/productive.module";
import { ProjectsModule } from "./modules/projects/projects.module";
import { ReposModule } from "./modules/repos/repos.module";
import { RunsModule } from "./modules/runs/runs.module";
import { SettingsModule } from "./modules/settings/settings.module";
import { SystemModule } from "./modules/system/system.module";
import { WorkOrdersModule } from "./modules/work-orders/work-orders.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    DatabaseModule,
    TemporalModule,
    EventsModule,
    HealthModule,
    ProjectsModule,
    WorkOrdersModule,
    RunsModule,
    ReposModule,
    SystemModule,
    SettingsModule,
    ClaudeAccountsModule,
    DispatcherModule,
    KnowledgeModule,
    PullRequestsModule,
    NotificationsModule,
    ProductiveModule,
    CommunityModule,
  ],
})
export class AppModule {}
