import { gzipSync } from 'node:zlib';
import type { EventEnvelope } from '../schema.js';

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

export interface BatchResult {
  accepted: number;
  duplicates: number;
  rejected: { index: number; reason: string }[];
}

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
    return this.request('POST', '/v1/events/batch', { events }, true);
  }

  async health(input: { collector_id: string; queue_depth: number; version?: string; privacy_mode?: string; agents: { agent: string; version?: string }[] }): Promise<{ ok: boolean }> {
    return this.request('POST', '/v1/collector/health', input);
  }

  private async request<T>(method: string, path: string, body?: unknown, compress = false): Promise<T> {
    const url = `${this.options.apiUrl.replace(/\/$/, '')}${path}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.options.apiKey}`,
      accept: 'application/json',
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

/** Exponential backoff with jitter, capped. */
export function backoffMs(attempt: number, baseMs = 1000, capMs = 300_000): number {
  const exponential = Math.min(capMs, baseMs * 2 ** attempt);
  // Jitter prevents a fleet of collectors reconnecting in lockstep after an
  // outage and immediately knocking the API over again.
  return Math.round(exponential / 2 + Math.random() * (exponential / 2));
}
