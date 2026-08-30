declare module "node:sqlite" {
  export interface StatementRunResult {
    changes: number;
    lastInsertRowid: number | bigint;
  }

  export class StatementSync {
    run(...anonymousParameters: readonly unknown[]): StatementRunResult;
    get(...anonymousParameters: readonly unknown[]): unknown;
    all(...anonymousParameters: readonly unknown[]): unknown[];
  }

  export class DatabaseSync {
    constructor(location: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  platform: string;
  pid: number;
  kill(pid: number, signal: number): void;
  versions: { node: string };
  cwd(): string;
  exitCode?: number;
  on(event: "SIGINT" | "SIGTERM", listener: () => void): void;
};

declare module "node:crypto" {
  export interface Hash {
    update(data: string | Uint8Array): Hash;
    digest(encoding: "hex" | "base64" | "base64url"): string;
  }
  export function createHash(algorithm: "sha256"): Hash;
  export function randomBytes(size: number): { toString(encoding?: string): string };
  export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
}

declare module "node:fs" {
  export function mkdirSync(path: string, options?: { recursive?: boolean; mode?: number }): string | undefined;
  export function openSync(path: string, flags: string, mode?: number): number;
  export function closeSync(fd: number): void;
  export function writeFileSync(file: string | number, data: string, options?: string | { encoding?: string; mode?: number }): void;
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function readFileSync(path: string): Uint8Array;
  export function existsSync(path: string): boolean;
  export function rmSync(path: string, options?: { force?: boolean; recursive?: boolean }): void;
  export function readSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null): number;
  export function renameSync(oldPath: string, newPath: string): void;
  export function statSync(path: string): { size: number; mode: number; mtime: { toISOString(): string }; isFile(): boolean; isDirectory(): boolean };
  export function accessSync(path: string, mode?: number): void;
  export const constants: { X_OK: number };
  export function createWriteStream(path: string, options?: { mode?: number }): unknown;
  export interface ReadStream {
    on(event: "data", listener: (chunk: Uint8Array) => void): this;
    on(event: "error", listener: (error: Error) => void): this;
    on(event: "end", listener: () => void): this;
  }
  export function createReadStream(path: string, options?: { encoding?: string }): ReadStream;
  export function mkdtempSync(prefix: string): string;
  export function copyFileSync(source: string, destination: string): void;
  export function cpSync(source: string, destination: string, options?: { recursive?: boolean; force?: boolean; errorOnExist?: boolean }): void;
  export function readdirSync(path: string): string[];
}

declare module "node:fs/promises" {
  export function mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<string | undefined>;
  export function readFile(path: string, encoding: "utf8"): Promise<string>;
  export function readFile(path: string): Promise<Uint8Array>;
  export function writeFile(path: string, data: string | Uint8Array, options?: { encoding?: string; mode?: number }): Promise<void>;
  export function rename(oldPath: string, newPath: string): Promise<void>;
  export function rm(path: string, options?: { force?: boolean; recursive?: boolean }): Promise<void>;
  export function stat(path: string): Promise<{ size: number; mode: number; mtime: { toISOString(): string }; isFile(): boolean; isDirectory(): boolean }>;
  export function copyFile(source: string, destination: string): Promise<void>;
  export function readdir(path: string): Promise<string[]>;
}

declare module "node:path" {
  export const sep: string;
  export const delimiter: string;
  export function resolve(...paths: string[]): string;
  export function join(...paths: string[]): string;
  export function dirname(path: string): string;
  export function basename(path: string): string;
  export function extname(path: string): string;
  export function relative(from: string, to: string): string;
}

declare module "node:child_process" {
  export interface SpawnedProcess {
    once(event: "exit", listener: (code?: number | null, signal?: string | null) => void): this;
    kill(signal?: string): boolean;
  }
  export function spawn(command: string, args?: readonly string[], options?: { stdio?: string }): SpawnedProcess;
  export interface SpawnSyncResult {
    status: number | null;
    stdout: string;
    stderr: string;
    error?: Error;
  }
  export function spawnSync(command: string, args?: readonly string[], options?: {
    cwd?: string; input?: string; encoding?: string; timeout?: number; maxBuffer?: number; env?: Record<string, string>;
  }): SpawnSyncResult;
}

declare module "node:timers/promises" {
  export function setTimeout<T = void>(delay?: number, value?: T): Promise<T>;
}


declare module "node:stream" {
  export class Readable {
    static fromWeb(stream: unknown): unknown;
  }
}

declare module "node:stream/promises" {
  export function pipeline(...streams: unknown[]): Promise<void>;
}

declare const Buffer: {
  from(value: string, encoding?: string): Uint8Array & { length: number; toString(encoding?: string): string };
};

declare module "node:http" {
  export interface IncomingMessage {
    method?: string;
    url?: string;
    headers: Record<string, string | string[] | undefined>;
    on(event: "data", listener: (chunk: { toString(): string }) => void): this;
    on(event: "end", listener: () => void): this;
  }
  export interface ServerResponse {
    statusCode: number;
    setHeader(name: string, value: string): void;
    end(data?: string): void;
  }
  export interface AddressInfo { port: number; address: string; family: string; }
  export interface Server {
    listen(port: number, host: string, callback?: () => void): this;
    close(callback?: (error?: Error) => void): this;
    address(): AddressInfo | string | null;
  }
  export function createServer(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>): Server;
}


declare module "node:net" {
  export interface Socket {
    setTimeout(ms: number): this;
    once(event: "connect" | "error" | "timeout", listener: () => void): this;
    destroy(): void;
  }
  export function connect(options: { port: number; host: string }): Socket;
}

declare module "node:os" {
  export function tmpdir(): string;
}
