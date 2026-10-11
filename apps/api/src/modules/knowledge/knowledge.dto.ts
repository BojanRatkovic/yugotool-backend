import {
  createKnowledgeSourceSchema,
  knowledgeSourceSchema,
  projectKnowledgeSchema,
  updateKnowledgeSourceSchema,
} from "@yugotool/contracts";
import { createZodDto } from "nestjs-zod";

export class KnowledgeSourceDto extends createZodDto(knowledgeSourceSchema) {}
export class CreateKnowledgeSourceDto extends createZodDto(createKnowledgeSourceSchema) {}
export class UpdateKnowledgeSourceDto extends createZodDto(updateKnowledgeSourceSchema) {}
export class ProjectKnowledgeDto extends createZodDto(projectKnowledgeSchema) {}
