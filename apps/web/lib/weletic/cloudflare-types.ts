export interface D1PreparedStatement {
  bind(...values: any[]): D1PreparedStatement;
  first<T = unknown>(colName?: string): Promise<T | null>;
  run<T = unknown>(): Promise<any>;
  all<T = unknown>(): Promise<{ results?: T[]; success: boolean; meta: any }>;
  raw<T = unknown>(): Promise<T[]>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  dump?(): Promise<ArrayBuffer>;
  batch?<T = unknown>(statements: any[]): Promise<any[]>;
  exec?<T = unknown>(query: string): Promise<any>;
}

export interface KVNamespace {
  get(key: string, type?: any): Promise<any>;
  put(
    key: string,
    value: string | ArrayBuffer | ReadableStream,
    options?: any,
  ): Promise<void>;
  delete(key: string): Promise<void>;
  list?(options?: any): Promise<any>;
}

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

declare global {
  interface D1PreparedStatement {
    bind(...values: any[]): D1PreparedStatement;
    first<T = unknown>(colName?: string): Promise<T | null>;
    run<T = unknown>(): Promise<any>;
    all<T = unknown>(): Promise<{ results?: T[]; success: boolean; meta: any }>;
    raw<T = unknown>(): Promise<T[]>;
  }

  interface D1Database {
    prepare(query: string): D1PreparedStatement;
    dump?(): Promise<ArrayBuffer>;
    batch?<T = unknown>(statements: any[]): Promise<any[]>;
    exec?<T = unknown>(query: string): Promise<any>;
  }

  interface KVNamespace {
    get(key: string, type?: any): Promise<any>;
    put(
      key: string,
      value: string | ArrayBuffer | ReadableStream,
      options?: any,
    ): Promise<void>;
    delete(key: string): Promise<void>;
    list?(options?: any): Promise<any>;
  }

  interface ExecutionContext {
    waitUntil(promise: Promise<unknown>): void;
    passThroughOnException(): void;
  }
}
