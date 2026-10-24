import axios, { AxiosInstance } from 'axios';
import { createAppAuth } from '@octokit/auth-app';
import * as fs from 'fs';
import * as path from 'path';
import { BaseConnector, CanonicalDependency, CanonicalEntity, HealthStatus } from './base';

export interface GithubCollaborator { login: string; id: number; role: string; email?: string; }
export interface GithubRepo {
  id: number; name: string; fullName: string; private: boolean; archived: boolean;
  pushedAt?: string; collaborators: GithubCollaborator[]; collaboratorsAccessible: boolean; teams: string[];
}
export interface GithubMember { login: string; id: number; email?: string; }
export interface GithubOptions {
  appId?: string; installationId?: string; privateKey?: string; org?: string;
  mock?: boolean; fixtureDir?: string; apiBaseUrl?: string; getToken?: () => Promise<string>;
}
interface RawRepo { id: number; name: string; full_name: string; private: boolean; archived: boolean; pushed_at?: string | null; }
interface RawCollaborator {
  login: string; id: number; role_name?: string;
  permissions?: { admin?: boolean; maintain?: boolean; push?: boolean; triage?: boolean; pull?: boolean };
  email?: string | null;
}
interface RawMember { login: string; id: number; email?: string | null; }
interface RawTeam { slug: string; }

const ROLE_CRITICALITY: Record<string, number> = { admin: 0.9, maintain: 0.8, write: 0.7, triage: 0.5, read: 0.3 };

function roleOf(c: RawCollaborator): string {
  if (c.role_name) return c.role_name;
  const p = c.permissions ?? {};
  if (p.admin) return 'admin';
  if (p.maintain) return 'maintain';
  if (p.push) return 'write';
  if (p.triage) return 'triage';
  return 'read';
}

export class GithubConnector extends BaseConnector<GithubRepo> {
  readonly source = 'github';
  private http?: AxiosInstance;
  private readonly mock: boolean;

  constructor(private opts: GithubOptions = {}) {
    super();
    const hasAuth = Boolean(opts.getToken) || Boolean(opts.appId && opts.installationId && opts.privateKey);
    this.mock = opts.mock ?? !(hasAuth && opts.org);
  }

  private org(): string {
    if (!this.opts.org) throw new Error('GithubConnector: org is not set');
    return this.opts.org;
  }

  private async installationToken(): Promise<string> {
    if (this.opts.getToken) return this.opts.getToken();
    const auth = createAppAuth({
      appId: this.opts.appId as string, privateKey: this.opts.privateKey as string,
      installationId: this.opts.installationId as string,
    });
    const result = await auth({ type: 'installation', refresh: true });
    return result.token;
  }

  async authenticate(): Promise<void> {
    if (this.mock) return;
    const token = await this.installationToken();
    this.http = axios.create({
      baseURL: this.opts.apiBaseUrl ?? 'https://api.github.com',
      headers: {
        Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'horquva-github-connector',
      },
      timeout: 20000,
    });
  }

  private client(): AxiosInstance {
    if (!this.http) throw new Error('GithubConnector: call authenticate() first');
    return this.http;
  }

  private loadFixture<T>(file: string): T {
    const dir = this.opts.fixtureDir ?? path.join(process.cwd(), 'tests', 'fixtures');
    return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8').replace(/^\uFEFF/, '')) as T;
  }

  private async get<T>(url: string, params?: Record<string, unknown>): Promise<T> {
    return this.withRetry(async () => {
      try {
        const res = await this.client().get<T>(url, { params });
        return res.data;
      } catch (err) {
        const e = err as { response?: { status?: number; headers?: Record<string, string> } };
        const h = e.response?.headers;
        if (e.response?.status === 403 && h && (h['x-ratelimit-remaining'] === '0' || h['retry-after'])) {
          throw { response: { status: 429, headers: h } };
        }
        throw err;
      }
    });
  }

  private async getAll<T>(url: string, params: Record<string, unknown> = {}): Promise<T[]> {
    const all: T[] = [];
    for (let page = 1; page <= 50; page++) {
      const batch = await this.get<T[]>(url, { ...params, per_page: 100, page });
      all.push(...batch);
      if (batch.length < 100) break;
    }
    return all;
  }

  async fetchEntities(): Promise<GithubRepo[]> {
    if (this.mock) return this.loadFixture<GithubRepo[]>('github-repos.json');
    const org = this.org();
    const rawRepos = await this.getAll<RawRepo>(`/orgs/${org}/repos`, { type: 'all' });
    const repos: GithubRepo[] = [];
    for (const r of rawRepos) {
      let collaborators: GithubCollaborator[] = [];
      let accessible = true;
      try {
        const raw = await this.getAll<RawCollaborator>(`/repos/${r.full_name}/collaborators`, { affiliation: 'all' });
        collaborators = raw.map((c) => ({ login: c.login, id: c.id, role: roleOf(c), ...(c.email ? { email: c.email } : {}) }));
      } catch (err) {
        const s = this.statusOf(err);
        if (s === 403 || s === 404) accessible = false; else throw err;
      }
      let teams: string[] = [];
      try {
        teams = (await this.getAll<RawTeam>(`/repos/${r.full_name}/teams`)).map((t) => t.slug);
      } catch (err) {
        const s = this.statusOf(err);
        if (s !== 403 && s !== 404) throw err;
      }
      repos.push({
        id: r.id, name: r.name, fullName: r.full_name, private: r.private, archived: r.archived,
        ...(r.pushed_at ? { pushedAt: r.pushed_at } : {}), collaborators, collaboratorsAccessible: accessible, teams,
      });
    }
    return repos;
  }

  async fetchMembers(): Promise<GithubMember[]> {
    if (this.mock) return this.loadFixture<GithubMember[]>('github-members.json');
    const raw = await this.getAll<RawMember>(`/orgs/${this.org()}/members`);
    return raw.map((m) => ({ login: m.login, id: m.id, ...(m.email ? { email: m.email } : {}) }));
  }

  normalize(repo: GithubRepo): CanonicalEntity {
    return {
      type: 'TOOL', name: repo.fullName, source: this.source, sourceId: String(repo.id),
      metadata: {
        kind: 'repository', private: repo.private, archived: repo.archived, pushedAt: repo.pushedAt ?? null,
        collaboratorCount: repo.collaborators.length, collaboratorsAccessible: repo.collaboratorsAccessible, teams: repo.teams,
      },
    };
  }

  normalizeMember(m: GithubMember): CanonicalEntity {
    return { type: 'EMPLOYEE', name: m.login, source: this.source, sourceId: String(m.id),
      metadata: { kind: 'org-member', login: m.login, email: m.email ?? null } };
  }

  dependenciesFrom(repos: GithubRepo[]): CanonicalDependency[] {
    const deps: CanonicalDependency[] = [];
    for (const repo of repos) {
      for (const c of repo.collaborators) {
        deps.push({
          fromSource: this.source, fromSourceId: String(c.id), toSource: this.source, toSourceId: String(repo.id),
          type: 'HAS_ACCESS', criticality: ROLE_CRITICALITY[c.role] ?? 0.3, evidenceSource: 'github-collaborators-api',
        });
      }
    }
    return deps;
  }

  async fetchDependencies(): Promise<CanonicalDependency[]> {
    return this.dependenciesFrom(await this.fetchEntities());
  }

  async healthCheck(): Promise<HealthStatus> {
    const checkedAt = new Date().toISOString();
    if (this.mock) return { ok: true, message: 'mock mode', checkedAt };
    try {
      await this.get('/installation/repositories', { per_page: 1 });
      return { ok: true, message: 'github reachable', checkedAt };
    } catch (err) {
      return { ok: false, message: `github unreachable (status ${this.statusOf(err) ?? 'none'})`, checkedAt };
    }
  }
}
