import { createRequire } from 'node:module';
import { gzipSync } from 'node:zlib';
import { z } from 'zod';
import type { EventEnvelope } from '../schema.js';

/** Read from package.json so the CLI, register and health can never drift from what is published. */
export const VERSION: string = (
  createRequire(import.meta.url)('../../package.json') as { version: string }
).version;

/**
 * HTTP client for the AgentsTrack API.
 *
 * Bodies are gzipped: a session's events compress by roughly 10x and a
 * developer on a hotel connection should not notice the collector at all.
 */
export interface ClientOptions {
  apiUrl: string;
  apiKey: string;
  timeoutMs?: number;
}

/**
 * The batch response is a trust boundary: a proxy error page or a newer
 * server shape must fail loudly here, not surface as `undefined.length` deep
 * in the upload policy. `quota` arrives only from servers that meter events.
 */
export const BatchResult = z.object({
  accepted: z.number().int().nonnegative(),
  duplicates: z.number().int().nonnegative(),
  rejected: z.array(z.object({ index: z.number().int(), reason: z.string() })),
  quota: z
    .object({
      limit: z.number().nullable(),
      used: z.number().nullable(),
      exceeded: z.boolean(),
    })
    .optional(),
});
export type BatchResult = z.infer<typeof BatchResult>;

export interface ServerConfig {
  privacy_mode: 'metadata' | 'analytics' | 'full';
  idle_timeout_seconds: number;
  retention_days: number;
  redaction_rules: { pattern: string; replacement: string }[];
  max_batch_events: number;
  batch_interval_seconds: number;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Whether trying again later could succeed. */
    readonly retryable: boolean,
    /** Server-requested minimum wait before the next attempt, from Retry-After. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class ApiClient {
  constructor(private readonly options: ClientOptions) {}

  async registerCollector(input: {
    hostname: string;
    label?: string;
    os?: string;
    arch?: string;
    version?: string;
    /** The mode this device will actually enforce, which may be stricter than the org's. */
    privacy_mode?: string;
    agents: { agent: string; version?: string }[];
  }): Promise<{ collector_id: string; privacy_mode: string }> {
    return this.request('POST', '/v1/collector/register', input);
  }

  async getConfig(): Promise<ServerConfig> {
    return this.request('GET', '/v1/collector/config');
  }

  async sendBatch(events: EventEnvelope[]): Promise<BatchResult> {
    const raw = await this.request<unknown>('POST', '/v1/events/batch', { events }, true);
    const parsed = BatchResult.safeParse(raw);
    if (!parsed.success) {
      // Not acking on a response we cannot read: the events stay spooled.
      throw new ApiError('POST /v1/events/batch returned an unreadable response', 200, true);
    }
    return parsed.data;
  }

  async health(input: { collector_id: string; queue_depth: number; version?: string; privacy_mode?: string; agents: { agent: string; version?: string }[] }): Promise<{ ok: boolean }> {
    return this.request('POST', '/v1/collector/health', input);
  }

  private async request<T>(method: string, path: string, body?: unknown, compress = false): Promise<T> {
    const url = `${this.options.apiUrl.replace(/\/$/, '')}${path}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.options.apiKey}`,
      accept: 'application/json',
      'user-agent': `agentstrack-collector/${VERSION}`,
    };

    let payload: Buffer | string | undefined;
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      const json = JSON.stringify(body);
      if (compress && json.length > 1024) {
        payload = gzipSync(json);
        headers['content-encoding'] = 'gzip';
      } else {
        payload = json;
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 30_000);

    try {
      const response = await fetch(url, { method, headers, body: payload, signal: controller.signal });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        // 4xx means we sent something wrong — retrying will not fix it, except
        // 408/429 which are explicitly "try again".
        const retryable = response.status >= 500 || response.status === 408 || response.status === 429;
        throw new ApiError(
          `${method} ${path} failed: ${response.status} ${text.slice(0, 200)}`,
          response.status,
          retryable,
          retryAfterMs(response.headers.get('retry-after-ingest') ?? response.headers.get('retry-after')),
        );
      }
      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      // Network failure, DNS, timeout: always worth retrying.
      throw new ApiError(
        error instanceof Error ? error.message : String(error),
        0,
        true,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** Retry-After is either delta-seconds or an HTTP date. Unparseable means no request. */
export function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

/** Exponential backoff with jitter, capped. */
export function backoffMs(attempt: number, baseMs = 1000, capMs = 300_000): number {
  const exponential = Math.min(capMs, baseMs * 2 ** attempt);
  // Jitter prevents a fleet of collectors reconnecting in lockstep after an
  // outage and immediately knocking the API over again.
  return Math.round(exponential / 2 + Math.random() * (exponential / 2));
}
