import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import path from "node:path";

/** Appends timestamped lines to `<dir>/<name>.log`; partial chunks are buffered to whole lines. */
export class LogFile {
  private readonly stream: WriteStream;
  private partial = "";

  constructor(dir: string, name: string) {
    mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, `${name}.log`);
    this.stream = createWriteStream(this.file, { flags: "a" });
  }

  readonly file: string;

  write(chunk: Buffer | string): void {
    const text = this.partial + chunk.toString();
    const lines = text.split("\n");
    this.partial = lines.pop() ?? "";
    for (const line of lines) this.line(line);
  }

  line(text: string): void {
    this.stream.write(`${new Date().toISOString()} ${text}\n`);
  }

  close(): Promise<void> {
    if (this.partial) this.line(this.partial);
    this.partial = "";
    return new Promise((resolve) => this.stream.end(resolve));
  }
}
