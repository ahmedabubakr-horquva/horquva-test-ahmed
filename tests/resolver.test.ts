import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { IdentityResolver, Person, SourceAccount } from '../src/identity/resolver';

function loadJson<T>(file: string): T {
  const raw = fs.readFileSync(path.join(process.cwd(), 'tests', 'fixtures', file), 'utf8');
  return JSON.parse(raw.replace(/^\uFEFF/, '')) as T;
}

const roster = loadJson<Person[]>('roster.json');
const aliases = loadJson<Record<string, string>>('aliases.json');

assert.strictEqual(roster.length, 30, 'roster should have 30 people');
assert.strictEqual(Object.keys(aliases).length, 5, 'should have 3 Entra aliases + 2 personal');

const resolver = new IdentityResolver(roster, aliases);

const acct = (source: string, id: string, email: string | null, name: string | null): SourceAccount => ({
  source, sourceId: id, email, displayName: name,
});

const accounts: SourceAccount[] = [
  acct('slack', 'U1', '  Natasha.Khan@SohaibAdnanHorquvaOutlook.onmicrosoft.com ', 'Natasha Khan'),
  acct('github', 'g1', 'ahmed.abubakr.horquva@gmail.com', 'ahmed'),
  acct('jira', 'j1', 'stranger@example.com', 'Some Stranger'),
  acct('github', 'g2', null, 'Natasha Khan'),
  acct('slack', 'U2', 'natasha.khan@sohaibadnanhorquvaoutlook.onmicrosoft.co', 'Natasha Khan'),
];

const { results, reviewQueue } = resolver.resolveAll(accounts);

assert.strictEqual(results[0]!.status, 'exact', 'case/whitespace should still match exactly');
assert.strictEqual(results[0]!.person!.fullName, 'Natasha Khan');
assert.strictEqual(results[1]!.status, 'alias', 'gmail alias should resolve');
assert.strictEqual(results[1]!.person!.fullName, 'Ahmed Abubakr');
assert.strictEqual(results[2]!.status, 'unmatched');
assert.strictEqual(results[3]!.reason, 'no-valid-email', 'name alone must never match');
assert.strictEqual(results[4]!.status, 'unmatched', 'near-miss email must not match (no fuzzy)');
assert.strictEqual(reviewQueue.length, 3, 'three accounts should go to review');

assert.throws(
  () => new IdentityResolver([roster[0]!, roster[0]!], {}),
  /Duplicate roster email/
);
assert.throws(
  () => new IdentityResolver(roster, { 'x@example.com': 'nobody@example.com' }),
  /unknown roster email/
);

console.log('roster:', roster.length, '| aliases:', Object.keys(aliases).length);
console.log('exact:', results.filter((r) => r.status === 'exact').length,
  '| alias:', results.filter((r) => r.status === 'alias').length,
  '| review queue:', reviewQueue.length);
console.log('PASS');
