import axios, { AxiosInstance } from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { BaseConnector, CanonicalDependency, CanonicalEntity, HealthStatus } from './base';

export interface N8nNode {
  name: string;
  type: string;
  credentials?: Record<string, { id?: string; name?: string }>;
}

export interface N8nWorkflow {
  id: string;
  name: string;
  active: boolean;
  createdAt?: string;
  updatedAt?: string;
  nodes?: N8nNode[];
}

export interface N8nExecution {
  id: string;
  workflowId: string;
  status: string;
  startedAt?: string;
  stoppedAt?: string;
}

export interface N8nOptions {
  baseUrl?: string;
  apiKey?: string;
  mock?: boolean;
  fixturePath?: string;
}

// Node types that are plumbing, not real tool dependencies.
const CORE_NODES = new Set([
  'scheduleTrigger', 'manualTrigger', 'webhook', 'set', 'if', 'code',
  'merge', 'noOp', 'wait', 'httpRequest', 'function', 'cron',
]);

export class N8nConnector extends BaseConnector<N8nWorkflow> {
  readonly source = 'n8n';
  private http?: AxiosInstance;
  private readonly mock: boolean;

  constructor(private opts: N8nOptions = {}) {
    super();
    this.mock = opts.mock ?? !(opts.baseUrl && opts.apiKey);
  }

  async authenticate(): Promise<void> {
    if (this.mock) return;
    this.http = axios.create({
      baseURL: this.opts.baseUrl as string,
      headers: { 'X-N8N-API-KEY': this.opts.apiKey as string },
      timeout: 15000,
    });
  }

  private client(): AxiosInstance {
    if (!this.http) throw new Error('N8nConnector: call authenticate() first');
    return this.http;
  }

  private loadFixture(): N8nWorkflow[] {
    const p = this.opts.fixturePath ?? path.join(process.cwd(), 'tests', 'fixtures', 'n8n-workflows.json');
    return JSON.parse(fs.readFileSync(p, 'utf8')) as N8nWorkflow[];
  }

  async fetchEntities(): Promise<N8nWorkflow[]> {
    if (this.mock) return this.loadFixture();
    const all: N8nWorkflow[] = [];
    let cursor: string | undefined;
    do {
      const res = await this.withRetry(() =>
        this.client().get('/api/v1/workflows', { params: { limit: 100, cursor } })
      );
      all.push(...(res.data.data as N8nWorkflow[]));
      cursor = res.data.nextCursor ?? undefined;
    } while (cursor);
    return all;
  }

  /** Used by the watchdog: executions that ended in error. */
  async fetchFailedExecutions(limit = 50): Promise<N8nExecution[]> {
    if (this.mock) return [];
    const res = await this.withRetry(() =>
      this.client().get('/api/v1/executions', { params: { status: 'error', limit } })
    );
    return res.data.data as N8nExecution[];
  }

  normalize(wf: N8nWorkflow): CanonicalEntity {
    return {
      type: 'WORKFLOW',
      name: wf.name,
      source: this.source,
      sourceId: String(wf.id),
      metadata: {
        active: wf.active,
        nodeCount: wf.nodes?.length ?? 0,
        updatedAt: wf.updatedAt ?? null,
      },
    };
  }

  async fetchDependencies(): Promise<CanonicalDependency[]> {
    const workflows = await this.fetchEntities();
    const deps: CanonicalDependency[] = [];
    for (const wf of workflows) {
      const tools = new Set<string>();
      for (const node of wf.nodes ?? []) {
        const tool = node.type.split('.').pop() as string;
        if (!CORE_NODES.has(tool)) tools.add(tool);
      }
      for (const tool of tools) {
        deps.push({
          fromSource: this.source,
          fromSourceId: String(wf.id),
          toSource: 'n8n-node',
          toSourceId: tool,
          type: 'USES_TOOL',
          criticality: wf.active ? 0.7 : 0.3,
          evidenceSource: 'n8n-workflow-definition',
        });
      }
    }
    return deps;
  }

  async healthCheck(): Promise<HealthStatus> {
    const checkedAt = new Date().toISOString();
    if (this.mock) return { ok: true, message: 'mock mode', checkedAt };
    try {
      await this.withRetry(() => this.client().get('/api/v1/workflows', { params: { limit: 1 } }));
      return { ok: true, message: 'n8n reachable', checkedAt };
    } catch (err) {
      return { ok: false, message: `n8n unreachable (status ${this.statusOf(err) ?? 'none'})`, checkedAt };
    }
  }
}
