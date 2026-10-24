import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { GithubConnector } from '../src/connectors/github';
import { IdentityResolver, Person } from '../src/identity/resolver';

async function main(): Promise<void> {
  const c = new GithubConnector({ mock: true });
  await c.authenticate();
  const repos = await c.fetchEntities();
  const entities = await c.collect();
  const deps = await c.fetchDependencies();
  const members = await c.fetchMembers();
  const health = await c.healthCheck();

  console.log('repos:', repos.length, '| members:', members.length, '| dependencies:', deps.length);
  assert.strictEqual(repos.length, 3);
  assert.strictEqual(entities.length, 3);
  assert.ok(entities.every((e) => e.type === 'TOOL' && e.source === 'github'));
  assert.strictEqual(members.length, 4);
  assert.strictEqual(deps.length, 5);
  assert.ok(health.ok);

  const admin = deps.find((d) => d.fromSourceId === '11' && d.toSourceId === '1001');
  const read = deps.find((d) => d.fromSourceId === '13' && d.toSourceId === '1001');
  assert.ok(admin && read && (admin.criticality ?? 0) > (read.criticality ?? 0));

  const legacy = entities.find((e) => e.name.endsWith('legacy-scripts'));
  assert.strictEqual(legacy?.metadata?.['collaboratorsAccessible'], false);

  const dir = path.join(process.cwd(), 'tests', 'fixtures');
  const roster = JSON.parse(fs.readFileSync(path.join(dir, 'roster.json'), 'utf8').replace(/^\uFEFF/, '')) as Person[];
  const aliases = JSON.parse(fs.readFileSync(path.join(dir, 'aliases.json'), 'utf8').replace(/^\uFEFF/, '')) as Record<string, string>;
  const resolver = new IdentityResolver(roster, aliases);
  const mapping: Record<string, string> = {
    'natasha-khan-dev': 'natasha.khan@sohaibadnanhorquvaoutlook.onmicrosoft.com',
    'ahmedabubakr-horquva': 'ahmed.abubakr.horquva@gmail.com',
  };
  const accounts = members.map((m) => ({ source: 'github', sourceId: String(m.id), email: mapping[m.login.toLowerCase()] ?? m.email ?? null, displayName: m.login }));
  const { results, reviewQueue } = resolver.resolveAll(accounts);
  console.log('resolved exact:', results.filter((r) => r.status === 'exact').length, '| alias:', results.filter((r) => r.status === 'alias').length, '| review queue:', reviewQueue.length);
  assert.strictEqual(results[0]!.status, 'exact');
  assert.strictEqual(results[1]!.status, 'alias');
  assert.strictEqual(reviewQueue.length, 2);

  console.log('PASS');
}
main().catch((e) => { console.error('FAIL', e instanceof Error ? e.message : String(e)); process.exit(1); });
