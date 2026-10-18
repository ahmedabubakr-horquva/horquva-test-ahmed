import * as assert from 'assert';
import * as path from 'path';
import {
  Failure,
  OnCallConfig,
  PollDeps,
  PollOptions,
  RawFailure,
  formatAlert,
  freshState,
  loadJson,
  ownerFor,
  pickOnCall,
  runPoll,
} from '../src/watchdog-core';

const cfg = loadJson<OnCallConfig>(path.join(process.cwd(), 'config', 'oncall.json'));
const opts: PollOptions = { baseline: true, maxAlertsPerPoll: 10, outageThreshold: 2 };

const mkRaw = (id: number, wf = 'wf-001'): RawFailure => ({
  executionId: String(id),
  workflowId: wf,
  failedAt: new Date(Date.UTC(2026, 9, 17, 5, id % 60)).toISOString(),
  error: `boom ${id}`,
});

interface Ctl {
  list: RawFailure[];
  sendFails: boolean;
  listFails: boolean;
  sent: string[];
}

function mkCtl(): Ctl {
  return { list: [], sendFails: false, listFails: false, sent: [] };
}

function mkDeps(ctl: Ctl): PollDeps {
  return {
    listFailures: async () => {
      if (ctl.listFails) throw new Error('n8n down');
      return ctl.list;
    },
    describe: async (raw): Promise<Failure> => ({
      executionId: raw.executionId,
      workflowId: raw.workflowId,
      workflowName: `Workflow ${raw.workflowId}`,
      failedAt: raw.failedAt,
      error: raw.error ?? 'unknown',
      impact: 'test impact',
    }),
    ownerOf: () => 'Test Owner',
    onCall: (now) => pickOnCall(cfg, now),
    send: async (text) => {
      if (ctl.sendFails) throw new Error('slack down');
      ctl.sent.push(text);
    },
    now: () => new Date(Date.UTC(2026, 9, 17, 6, 0)),
    log: () => {},
  };
}

async function main(): Promise<void> {
  // 1. First run records existing failures as a baseline and sends nothing
  const ctl = mkCtl();
  const d = mkDeps(ctl);
  const state = freshState();
  ctl.list = Array.from({ length: 10 }, (_, i) => mkRaw(i + 1));
  let r = await runPoll(state, d, opts);
  assert.strictEqual(r.alertsSent, 0);
  assert.strictEqual(r.baselined, 10);
  assert.strictEqual(ctl.sent.length, 0);
  console.log('1 baseline: 10 old failures, 0 alerts');

  // 2. Three new (simulated) failures produce exactly three alerts in the agreed format
  ctl.list = [...ctl.list, mkRaw(11, 'wf-002'), mkRaw(12, 'wf-002'), mkRaw(13, 'wf-003')];
  r = await runPoll(state, d, opts);
  assert.strictEqual(r.alertsSent, 3);
  assert.strictEqual(ctl.sent.length, 3);
  const first = ctl.sent[0]!;
  for (const needle of [
    'WORKFLOW FAILURE DETECTED',
    'Workflow: Workflow wf-002',
    'Owner: Test Owner',
    'Failed at: 2026-10-17',
    'Error: boom 11',
    'Impact: test impact',
    'Action: Investigate within 1 hour',
    'On-call: ',
  ]) {
    assert.ok(first.includes(needle), `alert missing "${needle}"`);
  }
  console.log('2 three new failures: 3 alerts, format OK');

  // 3. Same failures again: no duplicates
  r = await runPoll(state, d, opts);
  assert.strictEqual(r.alertsSent, 0);
  assert.strictEqual(ctl.sent.length, 3);
  console.log('3 repeat poll: 0 duplicate alerts');

  // 4. Slack down: failure is NOT marked as seen, then delivered exactly once
  ctl.list = [...ctl.list, mkRaw(14)];
  ctl.sendFails = true;
  r = await runPoll(state, d, opts);
  assert.strictEqual(r.alertsSent, 0);
  assert.ok(!state.seen.includes('14'));
  ctl.sendFails = false;
  r = await runPoll(state, d, opts);
  assert.strictEqual(r.alertsSent, 1);
  r = await runPoll(state, d, opts);
  assert.strictEqual(r.alertsSent, 0);
  assert.strictEqual(ctl.sent.length, 4);
  console.log('4 slack outage: retried, delivered once');

  // 5. n8n unreachable: one outage alert (not one per poll), then a recovery message
  const c2 = mkCtl();
  const d2 = mkDeps(c2);
  const s2 = freshState();
  s2.baselineDone = true;
  c2.listFails = true;
  await runPoll(s2, d2, opts);
  assert.strictEqual(c2.sent.length, 0);
  await runPoll(s2, d2, opts);
  assert.strictEqual(c2.sent.length, 1);
  assert.ok(c2.sent[0]!.includes('cannot reach n8n'));
  await runPoll(s2, d2, opts);
  assert.strictEqual(c2.sent.length, 1);
  c2.listFails = false;
  await runPoll(s2, d2, opts);
  assert.strictEqual(c2.sent.length, 2);
  assert.ok(c2.sent[1]!.includes('reachable again'));
  assert.strictEqual(s2.consecutiveErrors, 0);
  assert.strictEqual(s2.outageAlerted, false);
  console.log('5 n8n outage: 1 alert + 1 recovery');

  // 6. Flood protection: 15 new failures -> 10 alerts + 1 summary, nothing repeated
  const c3 = mkCtl();
  const d3 = mkDeps(c3);
  const s3 = freshState();
  s3.baselineDone = true;
  c3.list = Array.from({ length: 15 }, (_, i) => mkRaw(100 + i));
  r = await runPoll(s3, d3, opts);
  assert.strictEqual(r.alertsSent, 10);
  assert.strictEqual(c3.sent.length, 11);
  r = await runPoll(s3, d3, opts);
  assert.strictEqual(c3.sent.length, 11);
  console.log('6 flood: 10 alerts + 1 summary');

  // 7. On-call uses only project workers who are available that day
  const day17 = ['Ahmed Abubakr', 'Halima Maryam', 'Tooba Ghaffar', 'Sumavia Abid'];
  assert.ok(day17.includes(pickOnCall(cfg, new Date(Date.UTC(2026, 9, 17, 6, 0)))));
  assert.ok(['Affan Ahmed Khan', 'Sumavia Abid'].includes(pickOnCall(cfg, new Date(Date.UTC(2026, 9, 27, 6, 0)))));
  assert.ok(pickOnCall(cfg, new Date(Date.UTC(2026, 10, 5, 6, 0))).startsWith('No project worker'));
  console.log('7 on-call: only available project workers');

  // 8. Slack characters are escaped, owner falls back to UNASSIGNED, never invented
  const f: Failure = {
    executionId: '1', workflowId: 'w', workflowName: 'A <b> & C', failedAt: '2026-10-17T05:00:00.000Z',
    error: 'x <y>', impact: 'i',
  };
  const text = formatAlert(f, 'Owner', 'Person');
  assert.ok(text.includes('A &lt;b&gt; &amp; C'));
  assert.ok(ownerFor({}, 'w', 'n').startsWith('UNASSIGNED'));
  assert.ok(ownerFor({ n: 'UNASSIGNED' }, 'w', 'n').startsWith('UNASSIGNED'));
  console.log('8 escaping and owner fallback OK');

  console.log('PASS');
}

main().catch((e) => {
  console.error('FAIL', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
