import { Module } from "@nestjs/common";
import { ReposController } from "./repos.controller";
import { ReposService } from "./repos.service";

@Module({ controllers: [ReposController], providers: [ReposService], exports: [ReposService] })
export class ReposModule {}
