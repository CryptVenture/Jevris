// Ambient declarations of the few node:http, node:https and node:stream members the production
// fetch adapter (node-fetch.ts) uses. The package compiles without Node types.
declare module 'node:http' {
  export interface IncomingMessage {
    readonly statusCode?: number;
    readonly statusMessage?: string;
    readonly headers: { readonly [name: string]: string | readonly string[] | undefined };
    readonly rawHeaders: readonly string[];
    on(event: 'error', listener: (error: Error) => void): this;
    destroy(error?: Error): this;
  }
  export interface ClientRequest {
    on(event: 'error', listener: (error: Error) => void): this;
    on(event: 'response', listener: (response: IncomingMessage) => void): this;
    write(chunk: Uint8Array): boolean;
    end(chunk?: Uint8Array): this;
    destroy(error?: Error): this;
  }
  export interface AgentOptions {
    readonly keepAlive?: boolean;
    readonly keepAliveMsecs?: number;
    readonly maxSockets?: number;
    readonly maxFreeSockets?: number;
    readonly timeout?: number;
  }
  export class Agent {
    constructor(options?: AgentOptions);
    destroy(): void;
  }
  export interface RequestOptions {
    readonly method?: string;
    readonly headers?: { readonly [name: string]: string };
    readonly agent?: Agent;
  }
  export function request(url: URL, options: RequestOptions, callback?: (response: IncomingMessage) => void): ClientRequest;
}
declare module 'node:https' {
  import type { Agent as HttpAgent, AgentOptions, ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
  export class Agent extends HttpAgent {
    constructor(options?: AgentOptions);
  }
  export function request(url: URL, options: RequestOptions, callback?: (response: IncomingMessage) => void): ClientRequest;
}
declare module 'node:stream' {
  import type { IncomingMessage } from 'node:http';
  export const Readable: {
    toWeb(readable: IncomingMessage): ReadableStream<Uint8Array>;
  };
}
