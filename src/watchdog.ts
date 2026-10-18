import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { N8nConnector } from './connectors/n8n';
import {
  Failure,
  OnCallConfig,
  PollDeps,
  PollOptions,
  RawFailure,
  errMsg,
  loadJson,
  loadState,
  ownerFor,
  pickOnCall,
  runPoll,
  saveState,
} from './watchdog-core';

const root = process.cwd();
const logFile = path.join(root, 'logs', 'watchdog.log');

function loadEnv(file: string): void {
  const p = path.join(root, file);
  if (!fs.existsSync(p)) return;
  const text = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m && m[1] !== undefined && m[2] !== undefined && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].trim();
    }
  }
}

function log(msg: string): void {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, line + '\n');
  } catch {
    // logging must never crash the watchdog
  }
}

const sleep = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms));
const hasFlag = (f: string): boolean => process.argv.includes(f);

// Never log or rethrow raw axios errors: they can contain the webhook URL or tokens.
async function postWithRetry(fn: () => Promise<void>): Promise<void> {
  let last = 'unknown';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await fn();
      return;
    } catch (e) {
      const status = (e as { response?: { status?: number } })?.response?.status;
      last = status !== undefined ? `HTTP ${status}` : errMsg(e);
      if (attempt < 3) await sleep(1000 * attempt);
    }
  }
  throw new Error(`Slack post failed: ${last}`);
}

function makeSender(dry: boolean): (text: string) => Promise<void> {
  if (dry) {
    return async (text: string): Promise<void> => {
      log('[DRY RUN - not posted to Slack]\n' + text);
    };
  }
  const webhook = process.env['SLACK_WEBHOOK_URL'];
  const token = process.env['SLACK_BOT_TOKEN'];
  const channel = process.env['SLACK_CHANNEL'] ?? '#ops-alerts';

  if (webhook) {
    return async (text: string): Promise<void> => {
      await postWithRetry(async () => {
        await axios.post(webhook, { text }, { timeout: 15000 });
      });
    };
  }
  if (token) {
    return async (text: string): Promise<void> => {
      await postWithRetry(async () => {
        const res = await axios.post(
          'https://slack.com/api/chat.postMessage',
          { channel, text },
          { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
        );
        if (!res.data?.ok) throw new Error(`Slack error: ${res.data?.error ?? 'unknown'}`);
      });
    };
  }
  throw new Error('Set SLACK_WEBHOOK_URL or SLACK_BOT_TOKEN in .env, or use --dry-run');
}

interface WorkflowInfo {
  name: string;
  active: boolean;
  tools: string[];
}

async function main(): Promise<void> {
  loadEnv('.env');

  const MOCK = hasFlag('--mock');
  const DRY = hasFlag('--dry-run') || MOCK; // mock data is never posted to the real channel
  const ONCE = hasFlag('--once');
  const ALERT_EXISTING = hasFlag('--alert-existing');

  const intervalMin = Number(process.env['WATCHDOG_INTERVAL_MIN'] ?? '15');
  if (!Number.isFinite(intervalMin) || intervalMin <= 0) {
    throw new Error('WATCHDOG_INTERVAL_MIN must be a positive number');
  }

  const stateFile =
    process.env['WATCHDOG_STATE_FILE'] ??
    path.join(root, 'state', DRY ? 'watchdog-state.dry.json' : 'watchdog-state.json');

  const owners = loadJson<Record<string, string>>(path.join(root, 'config', 'workflow-owners.json'));
  const onCallCfg = loadJson<OnCallConfig>(path.join(root, 'config', 'oncall.json'));

  let connector: N8nConnector;
  if (MOCK) {
    connector = new N8nConnector({ mock: true });
  } else {
    const baseUrl = process.env['N8N_BASE_URL'];
    const apiKey = process.env['N8N_API_KEY'];
    if (!baseUrl || !apiKey) throw new Error('Set N8N_BASE_URL and N8N_API_KEY in .env (or use --mock)');
    connector = new N8nConnector({ baseUrl: baseUrl.replace(/\/+$/, ''), apiKey, mock: false });
  }
  await connector.authenticate();

  const send = makeSender(DRY);
  let wfCache: Map<string, WorkflowInfo> | null = null;

  async function loadWorkflowInfo(): Promise<Map<string, WorkflowInfo>> {
    const workflows = await connector.fetchEntities();
    const deps = await connector.fetchDependencies();
    const m = new Map<string, WorkflowInfo>();
    for (const wf of workflows) m.set(String(wf.id), { name: wf.name, active: wf.active, tools: [] });
    for (const dep of deps) m.get(dep.fromSourceId)?.tools.push(dep.toSourceId);
    return m;
  }

  const deps: PollDeps = {
    async listFailures(): Promise<RawFailure[]> {
      wfCache = null;
      if (MOCK) {
        return loadJson<RawFailure[]>(path.join(root, 'tests', 'fixtures', 'mock-failures.json'));
      }
      const execs = await connector.fetchFailedExecutions(100);
      return execs.map((e) => ({
        executionId: String(e.id),
        workflowId: String(e.workflowId),
        failedAt: e.stoppedAt ?? e.startedAt ?? new Date().toISOString(),
      }));
    },

    async describe(raw: RawFailure): Promise<Failure> {
      if (!wfCache) wfCache = await loadWorkflowInfo();
      const info = wfCache.get(raw.workflowId);
      const error =
        raw.error ??
        (await connector.fetchExecutionError(raw.executionId).catch(() => 'Error details unavailable'));
      const impact = info
        ? `Workflow is ${info.active ? 'ACTIVE' : 'inactive'}. Uses: ${
            info.tools.length > 0 ? [...new Set(info.tools)].join(', ') : 'no external tools'
          }.`
        : 'Impact unknown (workflow not found in n8n).';
      return {
        executionId: raw.executionId,
        workflowId: raw.workflowId,
        workflowName: info?.name ?? `Unknown workflow (id ${raw.workflowId})`,
        failedAt: raw.failedAt,
        error,
        impact,
      };
    },

    ownerOf: (f: Failure): string => ownerFor(owners, f.workflowId, f.workflowName),
    onCall: (now: Date): string => pickOnCall(onCallCfg, now),
    send,
    now: (): Date => new Date(),
    log,
  };

  const opts: PollOptions = { baseline: !ALERT_EXISTING, maxAlertsPerPoll: 10, outageThreshold: 2 };

  async function tick(): Promise<void> {
    try {
      const state = loadState(stateFile, log);
      const r = await runPoll(state, deps, opts);
      saveState(stateFile, state);
      log(
        `poll done: listed=${r.listed} new=${r.newFailures} alerts=${r.alertsSent} baselined=${r.baselined} outage=${r.outage}`
      );
    } catch (e) {
      log(`tick crashed: ${errMsg(e)}`);
    }
  }

  log(`watchdog starting: mode=${MOCK ? 'mock' : 'live'} dry=${DRY} interval=${intervalMin}min once=${ONCE}`);
  if (ONCE) {
    await tick();
    return;
  }
  for (;;) {
    await tick();
    await sleep(intervalMin * 60 * 1000);
  }
}

main().catch((e) => {
  console.error('FATAL', errMsg(e));
  process.exit(1);
});
