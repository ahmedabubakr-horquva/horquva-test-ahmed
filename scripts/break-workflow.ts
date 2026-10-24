import { loadEnv } from '../src/env';
import { N8nConnector } from '../src/connectors/n8n';
import axios from 'axios';

const WORKFLOW_NAME = 'Single Point of Failure';
const BAD_URL = 'https://jsonplaceholder.typicode.com/users?_limit=3-BROKEN';
const GOOD_URL = 'https://jsonplaceholder.typicode.com/users?_limit=3';

async function main(): Promise<void> {
  loadEnv('.env');
  const baseUrl = (process.env['N8N_BASE_URL'] as string).replace(/\/+$/, '');
  const apiKey = process.env['N8N_API_KEY'] as string;
  const http = axios.create({ baseURL: baseUrl, headers: { 'X-N8N-API-KEY': apiKey }, timeout: 15000 });

  const c = new N8nConnector({ baseUrl, apiKey, mock: false });
  await c.authenticate();
  const workflows = await c.fetchEntities();
  const wf = workflows.find(w => w.name === WORKFLOW_NAME);
  if (!wf) throw new Error('Workflow not found: ' + WORKFLOW_NAME);

  const action = process.argv[2]; // "arm" | "disarm"
  const full = (await http.get(`/api/v1/workflows/${wf.id}`)).data;

  if (action === 'arm') {
    // break the URL, speed up the schedule to 1 minute, activate
    const httpNode = full.nodes.find((n: any) => n.name === 'HTTP Request');
    const schedNode = full.nodes.find((n: any) => n.type === 'n8n-nodes-base.scheduleTrigger');
    if (!httpNode || !schedNode) throw new Error('Expected nodes not found');
    httpNode.parameters.url = BAD_URL;
    schedNode.parameters.rule.interval[0].field = 'minutes';
    schedNode.parameters.rule.interval[0].minutesInterval = 1;
    await http.put(`/api/v1/workflows/${wf.id}`, {
      name: full.name, nodes: full.nodes, connections: full.connections, settings: full.settings,
    });
    await http.post(`/api/v1/workflows/${wf.id}/activate`, {});
    console.log('Armed: URL broken, schedule set to 1 min, workflow activated. It will fail on its next run (within 1 min).');
  } else if (action === 'disarm') {
    // deactivate, restore URL, restore 15-min schedule
    await http.post(`/api/v1/workflows/${wf.id}/deactivate`, {});
    const fresh = (await http.get(`/api/v1/workflows/${wf.id}`)).data;
    const httpNode = fresh.nodes.find((n: any) => n.name === 'HTTP Request');
    const schedNode = fresh.nodes.find((n: any) => n.type === 'n8n-nodes-base.scheduleTrigger');
    httpNode.parameters.url = GOOD_URL;
    schedNode.parameters.rule.interval[0].minutesInterval = 15;
    await http.put(`/api/v1/workflows/${wf.id}`, {
      name: fresh.name, nodes: fresh.nodes, connections: fresh.connections, settings: fresh.settings,
    });
    console.log('Disarmed: deactivated, URL restored, schedule restored to 15 min.');
  } else {
    console.log('Usage: npx tsx scripts/break-workflow.ts [arm|disarm]');
  }
}

main().catch(e => {
  const r = (e as any)?.response;
  console.error('FAILED', r?.status ?? '', r?.data ?? (e instanceof Error ? e.message : e));
  process.exit(1);
});
