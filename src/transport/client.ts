import { createRequire } from 'node:module';
import { gzipSync } from 'node:zlib';
import { z } from 'zod';
import { PRIVACY_MODES, type EventEnvelope, type PrivacyMode } from '../schema.js';
import type { MachineInfo } from '../machine.js';
import { isPrivacyMode } from '../privacy/mode.js';
import { redact } from '../privacy/redact.js';

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

/**
 * `GET /v1/collector/config` is a trust boundary too, and the org ceiling and
 * redaction rules inside it are privacy controls. Unknown fields are kept
 * (a newer server must not break an older collector); an unreadable mode is
 * the strictest one, never a looser default.
 */
export const ServerConfig = z.looseObject({
  privacy_mode: z.enum(PRIVACY_MODES).catch('metadata'),
  idle_timeout_seconds: z.number().optional(),
  retention_days: z.number().optional(),
  redaction_rules: z.array(z.object({ pattern: z.string(), replacement: z.string() })).default([]),
  // 0 = no server cap; the daemon only applies a positive integer.
  max_batch_events: z.number().catch(0),
  batch_interval_seconds: z.number().optional(),
  /** Every event type the server accepts. Absent on servers older than the field. */
  event_types: z.array(z.string()).optional(),
});
export type ServerConfig = z.infer<typeof ServerConfig>;

export function parseServerConfig(raw: unknown): ServerConfig | null {
  const parsed = ServerConfig.safeParse(raw);
  return parsed.success ? parsed.data : null;
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

  /**
   * Register and health both carry `MachineInfo`. The server keeps hostname,
   * os, release, arch, machine kind and the request IP for operations and
   * abuse prevention only; none of it is shown in the product.
   */
  async registerCollector(input: Partial<MachineInfo> & {
    hostname: string;
    label?: string;
    version?: string;
    /** The mode this device will actually enforce, which may be stricter than the org's. */
    privacy_mode?: string;
    agents: { agent: string; version?: string }[];
  }): Promise<{ collector_id: string; privacy_mode: PrivacyMode | undefined }> {
    const raw = await this.request<{ collector_id: string; privacy_mode?: unknown }>(
      'POST',
      '/v1/collector/register',
      input,
    );
    // Validated here so no caller has to cast: an unreadable mode is
    // undefined, which clampPrivacyMode treats as the strictest ceiling.
    return { collector_id: raw.collector_id, privacy_mode: isPrivacyMode(raw.privacy_mode) ? raw.privacy_mode : undefined };
  }

  async getConfig(): Promise<ServerConfig> {
    const config = parseServerConfig(await this.request<unknown>('GET', '/v1/collector/config'));
    if (!config) throw new ApiError('GET /v1/collector/config returned an unreadable response', 200, true);
    return config;
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

  async health(
    input: Partial<MachineInfo> & {
      collector_id: string;
      queue_depth: number;
      version?: string;
      privacy_mode?: string;
      agents: { agent: string; version?: string }[];
    },
  ): Promise<{ ok: boolean }> {
    return this.request('POST', '/v1/collector/health', input);
  }

  /**
   * The key owner's own recent totals (1–30 days). The only read a collector
   * key is allowed; the shape is passed through untouched so a server-side
   * field addition reaches `agentstrack summary --json` without a release.
   */
  async summary(days: number): Promise<unknown> {
    return this.request('GET', `/v1/collector/summary?days=${Math.trunc(days)}`);
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
        const code = errorCode(await response.text().catch(() => ''));
        // 4xx means we sent something wrong — retrying will not fix it, except
        // 408/429 which are explicitly "try again".
        const retryable = response.status >= 500 || response.status === 408 || response.status === 429;
        throw new ApiError(
          `${method} ${path} failed: ${response.status}${code ? ` ${code}` : ''}`,
          response.status,
          retryable,
          retryAfterMs(response.headers.get('retry-after-ingest') ?? response.headers.get('retry-after')),
        );
      }
      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      // Network failure, DNS, timeout: always worth retrying.
      const timedOut = error instanceof Error && error.name === 'AbortError';
      throw new ApiError(
        timedOut
          ? `request timed out after ${(this.options.timeoutMs ?? 30_000) / 1000}s`
          : error instanceof Error ? error.message : String(error),
        0,
        true,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * The server's `error` code from a failure body, or '' — never the raw body.
 * A 4xx can echo back what we sent (a rejected event, the key itself), and a
 * proxy error page is noise; this message lands in a log file.
 */
export function errorCode(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return '';
  }
  if (!parsed || typeof parsed !== 'object') return '';
  const error = (parsed as Record<string, unknown>)['error'];
  const code =
    typeof error === 'string'
      ? error
      : error && typeof error === 'object' && typeof (error as Record<string, unknown>)['code'] === 'string'
        ? ((error as Record<string, unknown>)['code'] as string)
        : '';
  // Redacted before the cut, as everywhere else.
  return redact(code).text.slice(0, 120);
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
