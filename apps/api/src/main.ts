import "reflect-metadata";
import { existsSync } from "node:fs";
import path from "node:path";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { cleanupOpenApiDoc, ZodValidationPipe } from "nestjs-zod";
import type { NextFunction, Request, Response } from "express";
import { AppModule } from "./app.module";
import { GlobalExceptionFilter } from "./common/filters/global-exception.filter";
import type { Env } from "./core/config/env.schema";

async function bootstrap(): Promise<void> {
  // Open SSE streams never end on their own: without this, shutdown (and every dev
  // restart) waited forever on a browser tab's /events connection.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    forceCloseConnections: true,
  });
  const config = app.get<ConfigService<Env, true>>(ConfigService);

  app.useGlobalPipes(new ZodValidationPipe());
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.enableCors({ origin: config.get("CORS_ORIGINS", { infer: true }).split(",") });
  app.enableShutdownHooks();

  const webDist = config.get("WEB_DIST", { infer: true });
  if (webDist) serveWeb(app, webDist);

  if (config.get("NODE_ENV", { infer: true }) !== "production") {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle("YugoTool API").setVersion("0.1.0").build(),
    );
    SwaggerModule.setup("docs", app, cleanupOpenApiDoc(document));
  }

  const host = config.get("HOST", { infer: true });
  const port = config.get("PORT", { infer: true });
  await (host ? app.listen(port, host) : app.listen(port));
}

/**
 * One origin for app and API (no Vite in production): the API moves under
 * `/api`, built assets are served as files and every other GET falls back to
 * index.html so client-side routes survive a reload.
 */
function serveWeb(app: NestExpressApplication, webDist: string): void {
  const index = path.join(path.resolve(webDist), "index.html");
  if (!existsSync(index)) throw new Error(`WEB_DIST has no index.html: ${index}`);
  app.setGlobalPrefix("api");
  app.useStaticAssets(path.resolve(webDist), { index: false, maxAge: "1h" });
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "GET" || req.path.startsWith("/api/") || req.path.startsWith("/docs")) {
      next();
      return;
    }
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(index);
  });
}

void bootstrap();
