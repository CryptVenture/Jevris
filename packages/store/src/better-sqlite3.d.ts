declare module 'better-sqlite3' {
  interface Statement {
    run(...params: readonly unknown[]): unknown;
    get(...params: readonly unknown[]): unknown;
    all(...params: readonly unknown[]): unknown[];
  }

  interface PragmaOptions {
    simple?: boolean;
  }

  interface BackupProgress {
    totalPages: number;
    remainingPages: number;
  }

  interface BackupOptions {
    attached?: string;
    progress?: (progress: BackupProgress) => number | undefined;
  }

  class Database {
    constructor(filename: string);
    pragma(source: string, options?: PragmaOptions): unknown;
    defaultSafeIntegers(toggle?: boolean): this;
    transaction(fn: () => void): () => void;
    prepare(sql: string): Statement;
    exec(sql: string): this;
    close(): void;
    backup(filename: string, options?: BackupOptions): Promise<BackupProgress>;
  }

  export default Database;
}
