/// <reference path="../types/http.d.ts" />
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

/**
 * The loopback stub provider for no-cost certify cases (owner decision OD-9; routing design R33,
 * cases K1-K12; interface agreed with A). A harness in certify's throwaway profile is pointed at
 * this server with the dummy key, so its model requests reach 127.0.0.1 and no provider:
 * - Claude Code through `ANTHROPIC_BASE_URL`;
 * - Codex through a `[model_providers.stub]` with `wire_api = "responses"`;
 * - OpenCode and Kilo through the built-in anthropic provider's `options.baseURL`.
 * Antigravity has no custom endpoint, so its cases stay owner-run. A's stub-profile.ts writes
 * those settings.
 *
 * Every request gets a short, valid, finished answer in the API's own shape, streamed when the
 * request asks for a stream. A case may script one tool call (K1-K3: the harness's subagent
 * tool). The stub keeps no request body. It records only what a case checks: the shape, path,
 * model, effort, stream, `store`, the time, the header names (never a value), the names of the
 * tools offered, and which of the case's own marker strings appeared, and where. A request that
 * carries a key other than the dummy key gets 401. The server binds only 127.0.0.1, caps each
 * body, and records at most MAX_RECORDED requests.
 */

/** The API a request used, from its method and path. */
export type StubShape = 'anthropic-messages' | 'anthropic-count-tokens' | 'openai-responses' | 'openai-chat' | 'models' | 'unknown';

/** A case marker found in a request: in the system text (system, instructions, system or developer messages) or in the conversation. */
export interface StubMarker {
  readonly marker: string;
  readonly where: 'system' | 'messages';
}

export interface StubRequest {
  readonly shape: StubShape;
  readonly path: string;
  readonly model: string | null;
  /** Responses `reasoning.effort`, Chat `reasoning_effort`, Messages `output_config.effort`, else `budget:<n>` from `thinking.budget_tokens`. */
  readonly effort: string | null;
  readonly stream: boolean;
  /** The Responses API `store` flag (K12); null when absent or another API. */
  readonly store: boolean | null;
  readonly atMs: number;
  /** Header names only, lower case, sorted; never a value. */
  readonly headerNames: readonly string[];
  /**
   * The tool names the request offers the model, at most 128. A Responses namespace (Codex puts
   * spawn_agent under one) is listed by its own name and then as `<namespace>.<tool>` per tool.
   */
  readonly toolNames: readonly string[];
  readonly markersSeen: readonly StubMarker[];
  /** Whether the request was refused for a key other than the dummy key. */
  readonly refused: boolean;
}

/**
 * One scripted answer: assistant text, or one tool call. A case scripts a tool call to make the
 * harness act, for example Claude Code starting a subagent through its Agent tool (K1).
 */
export type StubReply =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'tool'; readonly name: string; readonly input: Json; /** A Responses function_call's namespace, for a tool offered inside one. */ readonly namespace?: string }
  /**
   * An error reply in the API's own shape (access limits R69, K16-K20): the status, the JSON body
   * and response headers the case scripts, for example a 429 with `retry-after` or a 402
   * `billing_error`. Never streamed.
   */
  | { readonly kind: 'error'; readonly status: number; readonly body: Json; readonly headers?: { readonly [name: string]: string } };

export interface StubProvider {
  /** `http://127.0.0.1:<port>`: the API root, with no `/v1`. */
  readonly baseUrl: string;
  /** The key the harness must send. A fixed literal, not a secret. */
  readonly dummyKey: string;
  requests(): readonly StubRequest[];
  close(): Promise<void>;
}

export interface StubProviderOptions {
  /** The model ids GET /v1/models lists; the first also names answers to a request without a model. */
  readonly models?: readonly string[];
  /** The assistant text every answer carries, unless `script` gives another reply. */
  readonly reply?: string;
  /** The reply for one model request (1-based count of model requests); undefined means `reply`. */
  readonly script?: (request: StubRequest, seq: number) => StubReply | undefined;
  /** Strings the case planted (a probe plugin's system text, say); only their presence is recorded. */
  readonly markers?: readonly string[];
}

export const STUB_DUMMY_KEY = 'jevris-stub-key';
export const STUB_BODY_CAP = 8 * 1024 * 1024;
export const MAX_RECORDED = 256;
const MODEL_CAP = 200;
const NAME_CAP = 64;
const DEFAULT_REPLY = 'ok';
const DEFAULT_MODEL = 'stub-model';

type Json = { readonly [key: string]: unknown };

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function own(value: unknown, key: string): unknown {
  return isObject(value) && Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
}

/** Every string inside a value, depth-first, bounded; for marker search only (nothing is kept). */
function strings(value: unknown, out: string[], depth = 0): void {
  if (out.length >= 4096 || depth > 12) return;
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, out, depth + 1);
  else if (isObject(value)) for (const key of Object.keys(value)) strings(value[key], out, depth + 1);
}

export function shapeOf(method: string, path: string): StubShape {
  const bare = path.split('?')[0] ?? '';
  if (method === 'POST' && /\/messages\/count_tokens$/.test(bare)) return 'anthropic-count-tokens';
  if (method === 'POST' && /\/messages$/.test(bare)) return 'anthropic-messages';
  if (method === 'POST' && /\/responses$/.test(bare)) return 'openai-responses';
  if (method === 'POST' && /\/chat\/completions$/.test(bare)) return 'openai-chat';
  if (method === 'GET' && /\/models(?:\/[^/]+)?$/.test(bare)) return 'models';
  return 'unknown';
}

function toolNamesOf(shape: StubShape, body: unknown): string[] {
  const tools = own(body, 'tools');
  if (!Array.isArray(tools)) return [];
  const names: string[] = [];
  for (const tool of tools.slice(0, 128)) {
    const name = shape === 'openai-chat' ? own(own(tool, 'function'), 'name') : (own(tool, 'name') ?? own(tool, 'type'));
    if (typeof name !== 'string' || name.length === 0) continue;
    names.push(name.slice(0, NAME_CAP));
    const inner = shape === 'openai-responses' && own(tool, 'type') === 'namespace' ? own(tool, 'tools') : undefined;
    if (!Array.isArray(inner)) continue;
    for (const member of inner.slice(0, 128)) {
      const memberName = own(member, 'name');
      if (typeof memberName === 'string' && memberName.length > 0) names.push(`${name.slice(0, NAME_CAP)}.${memberName.slice(0, NAME_CAP)}`);
    }
  }
  return names.slice(0, 128);
}

/** What a case checks in one request. Never throws, and keeps no text of the body. */
export function describeRequest(shape: StubShape, path: string, body: unknown, context: { readonly atMs?: number; readonly headerNames?: readonly string[]; readonly markers?: readonly string[]; readonly refused?: boolean } = {}): StubRequest {
  const model = own(body, 'model');
  const system: unknown[] = [];
  const messages: unknown[] = [];
  let effort: unknown = null;
  let store: boolean | null = null;
  if (shape === 'anthropic-messages' || shape === 'anthropic-count-tokens') {
    system.push(own(body, 'system'));
    messages.push(own(body, 'messages'));
    effort = own(own(body, 'output_config'), 'effort');
    const budget = own(own(body, 'thinking'), 'budget_tokens');
    if (typeof effort !== 'string' && typeof budget === 'number' && Number.isSafeInteger(budget)) effort = `budget:${budget}`;
  } else if (shape === 'openai-responses') {
    system.push(own(body, 'instructions'));
    const input = own(body, 'input');
    if (Array.isArray(input)) {
      for (const item of input) {
        const role = own(item, 'role');
        (role === 'system' || role === 'developer' ? system : messages).push(item);
      }
    } else messages.push(input);
    effort = own(own(body, 'reasoning'), 'effort');
    const stored = own(body, 'store');
    store = typeof stored === 'boolean' ? stored : null;
  } else if (shape === 'openai-chat') {
    const list = own(body, 'messages');
    if (Array.isArray(list)) {
      for (const message of list) {
        const role = own(message, 'role');
        (role === 'system' || role === 'developer' ? system : messages).push(message);
      }
    }
    effort = own(body, 'reasoning_effort');
  }
  const markersSeen: StubMarker[] = [];
  const markers = (context.markers ?? []).filter((marker) => marker.length > 0).slice(0, 16);
  if (markers.length > 0) {
    for (const [where, part] of [['system', system], ['messages', messages]] as const) {
      const found: string[] = [];
      strings(part, found);
      for (const marker of markers) if (found.some((text) => text.includes(marker))) markersSeen.push({ marker, where });
    }
  }
  return {
    shape,
    path: path.slice(0, 256),
    model: typeof model === 'string' ? model.slice(0, MODEL_CAP) : null,
    effort: typeof effort === 'string' ? effort.slice(0, 32) : null,
    stream: own(body, 'stream') === true,
    store,
    atMs: context.atMs ?? 0,
    headerNames: [...(context.headerNames ?? [])],
    toolNames: toolNamesOf(shape, body),
    markersSeen,
    refused: context.refused === true,
  };
}

/** Whether the request carries a key other than the dummy key (x-api-key or a bearer token). */
export function wrongKey(headers: { readonly [name: string]: string | readonly string[] | undefined }, dummyKey: string): boolean {
  const apiKey = headers['x-api-key'];
  if (apiKey !== undefined && apiKey !== dummyKey) return true;
  const authorization = headers['authorization'];
  if (authorization !== undefined && authorization !== `Bearer ${dummyKey}`) return true;
  return false;
}

function sse(response: ServerResponse, events: readonly (readonly [string | null, unknown])[]): void {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const [name, data] of events) response.write(`${name === null ? '' : `event: ${name}\n`}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
  response.end();
}

function json(response: ServerResponse, status: number, body: unknown, headers: { readonly [name: string]: string } = {}): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { ...headers, 'content-type': 'application/json', 'content-length': new TextEncoder().encode(text).length });
  response.end(text);
}

function answer(request: StubRequest, response: ServerResponse, reply: StubReply, models: readonly string[], seq: number): void {
  const model = request.model ?? models[0] ?? DEFAULT_MODEL;
  const id = `stub_${seq}`;
  const callId = `call_stub_${seq}`;
  if (reply.kind === 'error') {
    const status = Number.isSafeInteger(reply.status) && reply.status >= 400 && reply.status <= 599 ? reply.status : 500;
    return json(response, status, reply.body, reply.headers ?? {});
  }
  const args = reply.kind === 'tool' ? JSON.stringify(reply.input) : '';
  if (request.shape === 'anthropic-count-tokens') return json(response, 200, { input_tokens: 1 });
  if (request.shape === 'anthropic-messages') {
    const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    const stopReason = reply.kind === 'tool' ? 'tool_use' : 'end_turn';
    const block = reply.kind === 'tool' ? { type: 'tool_use', id: `toolu_stub_${seq}`, name: reply.name, input: reply.input } : { type: 'text', text: reply.text };
    if (!request.stream) {
      return json(response, 200, { id, type: 'message', role: 'assistant', model, content: [block], stop_reason: stopReason, stop_sequence: null, usage });
    }
    const start = reply.kind === 'tool' ? { ...block, input: {} } : { type: 'text', text: '' };
    const delta = reply.kind === 'tool' ? { type: 'input_json_delta', partial_json: args } : { type: 'text_delta', text: reply.text };
    return sse(response, [
      ['message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 0 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: start }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 1 } }],
      ['message_stop', { type: 'message_stop' }],
    ]);
  }
  if (request.shape === 'openai-responses') {
    const item =
      reply.kind === 'tool'
        ? { type: 'function_call', id: `fc_${seq}`, call_id: callId, name: reply.name, ...(reply.namespace === undefined ? {} : { namespace: reply.namespace }), arguments: args, status: 'completed' }
        : { type: 'message', role: 'assistant', id: `msg_${seq}`, status: 'completed', content: [{ type: 'output_text', text: reply.text, annotations: [] }] };
    const usage = { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 };
    const done = { id, object: 'response', status: 'completed', model, output: [item], usage };
    if (!request.stream) return json(response, 200, done);
    const middle: (readonly [string, unknown])[] =
      reply.kind === 'tool'
        ? [['response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', output_index: 0, item_id: item.id, delta: args }]]
        : [['response.output_text.delta', { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: item.id, delta: reply.text }]];
    const added = reply.kind === 'tool' ? { ...item, arguments: '', status: 'in_progress' } : { ...item, status: 'in_progress', content: [] };
    return sse(response, [
      ['response.created', { type: 'response.created', response: { id, object: 'response', status: 'in_progress', model } }],
      ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: added }],
      ...middle,
      ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item }],
      ['response.completed', { type: 'response.completed', response: done }],
    ]);
  }
  if (request.shape === 'openai-chat') {
    const created = 0;
    const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
    const finish = reply.kind === 'tool' ? 'tool_calls' : 'stop';
    const toolCall = { id: callId, type: 'function', function: { name: reply.kind === 'tool' ? reply.name : '', arguments: args } };
    if (!request.stream) {
      const message = reply.kind === 'tool' ? { role: 'assistant', content: null, tool_calls: [toolCall] } : { role: 'assistant', content: reply.text };
      return json(response, 200, { id, object: 'chat.completion', created, model, choices: [{ index: 0, message, finish_reason: finish }], usage });
    }
    const chunk = (delta: unknown, finishReason: string | null, extra: Json = {}): unknown => ({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finishReason }], ...extra });
    const body = reply.kind === 'tool' ? { tool_calls: [{ index: 0, ...toolCall }] } : { content: reply.text };
    return sse(response, [
      [null, chunk({ role: 'assistant', content: '' }, null)],
      [null, chunk(body, null)],
      [null, chunk({}, finish, { usage })],
      [null, '[DONE]'],
    ]);
  }
  if (request.shape === 'models') {
    const data = models.map((modelId) => ({ id: modelId, object: 'model', type: 'model', display_name: modelId, created: 0, created_at: '2026-01-01T00:00:00Z', owned_by: 'stub' }));
    return json(response, 200, { object: 'list', data, has_more: false, first_id: models[0] ?? null, last_id: models.at(-1) ?? null });
  }
  return json(response, 404, { type: 'error', error: { type: 'not_found_error', message: 'The Jevris stub provider does not serve this path.' } });
}

/** Starts the stub on 127.0.0.1 at a free port. */
export async function startStubProvider(options: StubProviderOptions = {}): Promise<StubProvider> {
  const text: StubReply = { kind: 'text', text: options.reply ?? DEFAULT_REPLY };
  const models = options.models !== undefined && options.models.length > 0 ? options.models.map((id) => id.slice(0, MODEL_CAP)) : [DEFAULT_MODEL];
  const markers = options.markers ?? [];
  let modelRequests = 0;
  const recorded: StubRequest[] = [];
  let seq = 0;
  const handle = (request: IncomingMessage, response: ServerResponse): void => {
    const method = (request.method ?? 'GET').toUpperCase();
    const path = request.url ?? '/';
    const headerNames = Object.keys(request.headers).map((name) => name.toLowerCase().slice(0, NAME_CAP)).sort().slice(0, 64);
    const refused = wrongKey(request.headers, STUB_DUMMY_KEY);
    const chunks: Uint8Array[] = [];
    let size = 0;
    let tooLarge = false;
    request.on('data', (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > STUB_BODY_CAP) {
        tooLarge = true;
        json(response, 413, { type: 'error', error: { type: 'request_too_large', message: 'The request body is over the stub cap.' } });
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('error', () => {});
    request.on('end', () => {
      if (tooLarge) return;
      let body: unknown = null;
      if (size > 0 && !refused) {
        try {
          const all = new Uint8Array(size);
          let at = 0;
          for (const chunk of chunks) {
            all.set(chunk, at);
            at += chunk.length;
          }
          body = JSON.parse(new TextDecoder().decode(all));
        } catch {
          body = null;
        }
      }
      chunks.length = 0;
      seq += 1;
      const described = describeRequest(shapeOf(method, path), path, body, { atMs: Date.now(), headerNames, markers, refused });
      body = null;
      if (recorded.length < MAX_RECORDED) recorded.push(described);
      if (refused) {
        json(response, 401, { type: 'error', error: { type: 'authentication_error', message: 'The Jevris stub provider takes only its dummy key.' } });
        return;
      }
      let reply: StubReply = text;
      if (described.shape === 'anthropic-messages' || described.shape === 'openai-responses' || described.shape === 'openai-chat') {
        modelRequests += 1;
        try {
          reply = options.script?.(described, modelRequests) ?? text;
        } catch {
          reply = text;
        }
      }
      try {
        answer(described, response, reply, models, seq);
      } catch {
        if (!response.headersSent) json(response, 500, { type: 'error', error: { type: 'api_error', message: 'stub failure' } });
      }
    });
  };
  const server: Server = createServer(handle);
  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    dummyKey: STUB_DUMMY_KEY,
    requests: () => [...recorded],
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
