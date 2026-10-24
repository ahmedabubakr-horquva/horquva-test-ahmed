import * as fs from 'fs';
import * as path from 'path';
import { loadEnv } from '../src/env';
import { GithubConnector } from '../src/connectors/github';
import { IdentityResolver, Person } from '../src/identity/resolver';

function readJson<T>(file: string, fallback: T): T {
  const p = path.join(process.cwd(), file);
  if (!fs.existsSync(p)) return fallback;
  return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) as T;
}

async function main(): Promise<void> {
  loadEnv('.env');
  const appId = process.env['GITHUB_APP_ID'];
  const installationId = process.env['GITHUB_INSTALLATION_ID'];
  const keyPath = process.env['GITHUB_PRIVATE_KEY_PATH'];
  const org = process.env['GITHUB_ORG'];
  if (!appId || !installationId || !keyPath || !org) throw new Error('Set GITHUB_APP_ID, GITHUB_INSTALLATION_ID, GITHUB_PRIVATE_KEY_PATH, GITHUB_ORG in .env');

  const c = new GithubConnector({ appId, installationId, privateKey: fs.readFileSync(keyPath, 'utf8'), org, mock: false });
  await c.authenticate();
  const health = await c.healthCheck();
  console.log('health:', health.ok, '-', health.message);
  if (!health.ok) throw new Error('GitHub not reachable');

  const repos = await c.fetchEntities();
  console.log('repos:', repos.length);
  for (const r of repos) {
    console.log(' -', r.fullName, '| private:', r.private, '| collaborators:', r.collaboratorsAccessible ? r.collaborators.length : 'NOT READABLE (permission)', '| teams:', r.teams.length);
  }
  const deps = c.dependenciesFrom(repos);
  console.log('access dependencies:', deps.length);
  const members = await c.fetchMembers();
  console.log('org members:', members.length);

  const roster = readJson<Person[]>(path.join('tests', 'fixtures', 'roster.json'), []);
  const aliases = readJson<Record<string, string>>(path.join('tests', 'fixtures', 'aliases.json'), {});
  const mapping = readJson<Record<string, string>>(path.join('config', 'github-users.json'), {});
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(mapping)) lower[k.toLowerCase()] = v;
  const resolver = new IdentityResolver(roster, aliases);
  const { results, reviewQueue } = resolver.resolveAll(members.map((m) => ({ source: 'github', sourceId: String(m.id), email: lower[m.login.toLowerCase()] ?? m.email ?? null, displayName: m.login })));
  console.log('identity: exact', results.filter((r) => r.status === 'exact').length, '| alias', results.filter((r) => r.status === 'alias').length, '| review queue', reviewQueue.length);
  if (reviewQueue.length > 0) { console.log('logins needing a mapping in config/github-users.json:'); for (const item of reviewQueue) console.log(' -', item.account.displayName); }

  console.log('LIVE PASS');
}
main().catch((e) => {
  const status = (e as { response?: { status?: number; data?: { message?: string } } })?.response;
  console.error('LIVE FAIL', status?.status ?? '', status?.data?.message ?? (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
