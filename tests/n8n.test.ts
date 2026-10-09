import { N8nConnector } from '../src/connectors/n8n';

async function main() {
  const c = new N8nConnector({ mock: true });
  await c.authenticate();

  const entities = await c.collect();
  const deps = await c.fetchDependencies();
  const health = await c.healthCheck();

  console.log('entities:', entities.length);
  console.log('dependencies:', deps.length);
  console.log('health:', health.ok, health.message);

  if (entities.length !== 3) throw new Error('expected 3 workflows');
  if (deps.length !== 4) throw new Error('expected 4 dependencies');
  if (!health.ok) throw new Error('health check failed');
  console.log('PASS');
}

main().catch((e) => { console.error('FAIL', e); process.exit(1); });
