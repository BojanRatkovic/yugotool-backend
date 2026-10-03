import {
  createProjectSchema,
  lineSchema,
  projectSchema,
  previewDetectionSchema,
  projectRemoteSchema,
  previewStatusSchema,
  previewSessionStatusSchema,
  finishSignInSchema,
  previewTestResultSchema,
  projectStatsSchema,
  routeMapStatusSchema,
  updateRoutesSchema,
  updateLineSchema,
  updateReviewLineSchema,
  updateProjectSchema,
} from "@zastava/contracts";
import { createZodDto } from "nestjs-zod";

export class CreateProjectDto extends createZodDto(createProjectSchema) {}
export class ProjectDto extends createZodDto(projectSchema) {}
export class LineDto extends createZodDto(lineSchema) {}
export class UpdateLineDto extends createZodDto(updateLineSchema) {}
export class UpdateReviewLineDto extends createZodDto(updateReviewLineSchema) {}
export class ProjectStatsDto extends createZodDto(projectStatsSchema) {}
export class UpdateProjectDto extends createZodDto(updateProjectSchema) {}
export class PreviewTestResultDto extends createZodDto(previewTestResultSchema) {}
export class PreviewStatusDto extends createZodDto(previewStatusSchema) {}
export class RouteMapStatusDto extends createZodDto(routeMapStatusSchema) {}
export class UpdateRoutesDto extends createZodDto(updateRoutesSchema) {}
export class ProjectRemoteDto extends createZodDto(projectRemoteSchema) {}
export class PreviewDetectionDto extends createZodDto(previewDetectionSchema) {}
export class PreviewSessionStatusDto extends createZodDto(previewSessionStatusSchema) {}
export class FinishSignInDto extends createZodDto(finishSignInSchema) {}
