import { Module } from "@nestjs/common";
import { KnowledgeSourcesController, ProjectKnowledgeController } from "./knowledge.controller";
import { KnowledgeRepository } from "./knowledge.repository";
import { KnowledgeService } from "./knowledge.service";

@Module({
  controllers: [KnowledgeSourcesController, ProjectKnowledgeController],
  providers: [KnowledgeService, KnowledgeRepository],
})
export class KnowledgeModule {}
