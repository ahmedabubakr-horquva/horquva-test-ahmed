import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { IdentityResolver, Person } from '../src/identity/resolver';

const load = <T>(f: string): T =>
  JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests', 'fixtures', f), 'utf8').replace(/^\uFEFF/, '')) as T;

const resolver = new IdentityResolver(load<Person[]>('roster.json'), load<Record<string, string>>('aliases.json'));

const expected: Record<string, string> = {
  'natasha.ceo@sohaibadnanhorquvaoutlook.onmicrosoft.com': 'Natasha Khan',
  'kia.cfo@sohaibadnanhorquvaoutlook.onmicrosoft.com': 'Kia Vang',
  'taha.board@sohaibadnanhorquvaoutlook.onmicrosoft.com': 'Taha Nadeem',
};

for (const [email, name] of Object.entries(expected)) {
  const r = resolver.resolve({ source: 'entra', sourceId: email, email, displayName: null });
  assert.strictEqual(r.status, 'alias', `${email} should be an alias`);
  assert.strictEqual(r.person!.fullName, name);
}
console.log('3 Entra aliases resolve correctly');
console.log('PASS');
