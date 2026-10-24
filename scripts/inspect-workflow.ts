import * as fs from 'fs';
import { loadEnv } from '../src/env';
import { N8nConnector } from '../src/connectors/n8n';

async function main(): Promise<void> {
  loadEnv('.env');
  const baseUrl = process.env['N8N_BASE_URL'];
  const apiKey = process.env['N8N_API_KEY'];
  if (!baseUrl || !apiKey) throw new Error('Set N8N_BASE_URL and N8N_API_KEY in .env');
  const c = new N8nConnector({ baseUrl: baseUrl.replace(/\/+$/, ''), apiKey, mock: false });
  await c.authenticate();
  const workflows = await c.fetchEntities();
  const target = workflows.find(w => w.name === process.argv[2]);
  if (!target) { console.log('Not found. Available:', workflows.map(w => w.name).join(', ')); return; }
  console.log(JSON.stringify(target, null, 2));
}
main().catch(e => { console.error(e); process.exit(1); });
