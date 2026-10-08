export type EntityType = 'EMPLOYEE' | 'AGENT' | 'WORKFLOW' | 'TOOL' | 'MODEL' | 'VENDOR';

export interface CanonicalEntity {
  type: EntityType;
  name: string;
  source: string;
  sourceId: string;
  metadata?: Record<string, unknown>;
}

export interface CanonicalDependency {
  fromSource: string;
  fromSourceId: string;
  toSource: string;
  toSourceId: string;
  type: string;
  criticality?: number;
  evidenceSource: string;
}

export interface HealthStatus {
  ok: boolean;
  message: string;
  checkedAt: string;
}

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
}

export abstract class BaseConnector<TRaw = unknown> {
  abstract readonly source: string;

  abstract authenticate(): Promise<void>;
  abstract fetchEntities(): Promise<TRaw[]>;
  abstract fetchDependencies(): Promise<CanonicalDependency[]>;
  abstract normalize(raw: TRaw): CanonicalEntity;
  abstract healthCheck(): Promise<HealthStatus>;

  protected statusOf(err: unknown): number | undefined {
    const e = err as { response?: { status?: number }; status?: number };
    return e?.response?.status ?? e?.status;
  }

  protected retryAfterMs(err: unknown): number | undefined {
    const e = err as { response?: { headers?: Record<string, string> } };
    const h = e?.response?.headers?.['retry-after'];
    const secs = h ? Number(h) : NaN;
    return Number.isFinite(secs) ? secs * 1000 : undefined;
  }

  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Retries on 429 with exponential backoff; on 401 re-authenticates once, then retries. */
  protected async withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
    const maxRetries = opts.maxRetries ?? 5;
    const baseDelayMs = opts.baseDelayMs ?? 500;
    let refreshed = false;

    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const status = this.statusOf(err);

        if (status === 401 && !refreshed) {
          refreshed = true;
          await this.authenticate();
          continue;
        }
        if (status === 429 && attempt < maxRetries) {
          const backoff = baseDelayMs * 2 ** attempt + Math.random() * 100;
          await this.sleep(this.retryAfterMs(err) ?? backoff);
          continue;
        }
        throw err;
      }
    }
  }

  /** Convenience: fetch + normalize in one call. */
  async collect(): Promise<CanonicalEntity[]> {
    const raw = await this.fetchEntities();
    return raw.map((r) => this.normalize(r));
  }
}
