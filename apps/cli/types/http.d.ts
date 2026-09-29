// The node:http surface the loopback stub provider uses (stub-provider.ts). The product builds
// without @types/node, so each built-in a module needs is declared here, and only that much.
declare module 'node:http' {
  export interface IncomingMessage {
    readonly method?: string;
    readonly url?: string;
    readonly headers: { readonly [name: string]: string | readonly string[] | undefined };
    on(event: 'data', listener: (chunk: Uint8Array) => void): this;
    on(event: 'end' | 'close', listener: () => void): this;
    on(event: 'error', listener: (err: unknown) => void): this;
    destroy(): void;
  }
  export interface ServerResponse {
    writeHead(status: number, headers?: { readonly [name: string]: string | number }): this;
    write(chunk: string): boolean;
    end(chunk?: string): void;
    readonly headersSent: boolean;
  }
  export interface AddressInfo {
    readonly address: string;
    readonly port: number;
  }
  export interface Server {
    listen(port: number, host: string, callback?: () => void): this;
    address(): AddressInfo | string | null;
    close(callback?: (err?: unknown) => void): this;
    closeAllConnections?(): void;
    on(event: 'error', listener: (err: unknown) => void): this;
    unref(): this;
  }
  export function createServer(listener: (request: IncomingMessage, response: ServerResponse) => void): Server;
}
