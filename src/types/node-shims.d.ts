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
  exitCode?: number;
};

declare module "node:crypto" {
  export interface Hash {
    update(data: string): Hash;
    digest(encoding: "hex"): string;
  }
  export function createHash(algorithm: "sha256"): Hash;
}
