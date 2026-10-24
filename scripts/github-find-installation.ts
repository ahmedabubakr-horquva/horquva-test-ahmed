import * as fs from 'fs';
import axios from 'axios';
import { createAppAuth } from '@octokit/auth-app';
import { loadEnv } from '../src/env';

async function main(): Promise<void> {
  loadEnv('.env');
  const appId = process.env['GITHUB_APP_ID'];
  const keyPath = process.env['GITHUB_PRIVATE_KEY_PATH'];
  if (!appId || !keyPath) throw new Error('Set GITHUB_APP_ID and GITHUB_PRIVATE_KEY_PATH in .env');
  const auth = createAppAuth({ appId, privateKey: fs.readFileSync(keyPath, 'utf8') });
  const { token } = await auth({ type: 'app' });
  const res = await axios.get('https://api.github.com/app/installations', {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'horquva-github-connector' },
    timeout: 20000,
  });
  const items = res.data as Array<{ id: number; account?: { login?: string }; target_type?: string; repository_selection?: string; suspended_at?: string | null; permissions?: Record<string, string> }>;
  if (items.length === 0) console.log('No installations found.');
  for (const i of items) {
    console.log(`installation id=${i.id} account=${i.account?.login ?? '?'} type=${i.target_type ?? '?'} repos=${i.repository_selection ?? '?'} suspended=${i.suspended_at ? 'YES' : 'no'}`);
    console.log('  permissions:', Object.entries(i.permissions ?? {}).map(([k, v]) => `${k}=${v}`).join(', '));
  }
}
main().catch((e) => {
  const r = (e as { response?: { status?: number; data?: { message?: string } } })?.response;
  console.error('FAILED', r?.status ?? '', r?.data?.message ?? (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
