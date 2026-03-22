declare module 'node:sqlite' {
  interface RunResult {
    changes: number;
    lastInsertRowid: number;
  }

  interface StatementSync {
    run(...params: unknown[]): RunResult;
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Record<string, unknown>[];
  }

  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
