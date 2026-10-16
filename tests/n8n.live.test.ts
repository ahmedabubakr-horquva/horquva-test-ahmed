import * as fs from 'fs';
import * as path from 'path';
import { N8nConnector } from '../src/connectors/n8n';

function loadEnv(file: string): void {
  const p = path.join(process.cwd(), file);
  if (!fs.existsSync(p)) return;
  const text = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m && m[1] !== undefined && m[2] !== undefined && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].trim();
    }
  }
}

async function main() {
  loadEnv('.env');
  const baseUrl = process.env['N8N_BASE_URL'];
  const apiKey = process.env['N8N_API_KEY'];
  if (!baseUrl || !apiKey) throw new Error('Set N8N_BASE_URL and N8N_API_KEY in .env');

  const c = new N8nConnector({ baseUrl: baseUrl.replace(/\/+$/, ''), apiKey, mock: false });
  await c.authenticate();

  const health = await c.healthCheck();
  console.log('health:', health.ok, '-', health.message);
  if (!health.ok) throw new Error('n8n not reachable: check URL, key, and that the instance is running');

  const entities = await c.collect();
  console.log('workflows:', entities.length);
  for (const e of entities) {
    console.log(' -', e.name, '| active:', e.metadata?.['active']);
  }

  const deps = await c.fetchDependencies();
  console.log('dependencies:', deps.length);

  const failed = await c.fetchFailedExecutions(10);
  console.log('failed executions (latest 10):', failed.length);

  console.log('LIVE PASS');
}

main().catch((e) => {
  const status = (e as { response?: { status?: number } })?.response?.status;
  console.error('LIVE FAIL', status ?? '', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
