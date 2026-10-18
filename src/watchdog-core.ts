import * as fs from 'fs';
import * as path from 'path';

export interface RawFailure {
  executionId: string;
  workflowId: string;
  failedAt: string;
  error?: string;
}

export interface Failure {
  executionId: string;
  workflowId: string;
  workflowName: string;
  failedAt: string;
  error: string;
  impact: string;
}

export interface WatchdogState {
  baselineDone: boolean;
  seen: string[];
  consecutiveErrors: number;
  outageAlerted: boolean;
}

export interface PollDeps {
  listFailures(): Promise<RawFailure[]>;
  describe(raw: RawFailure): Promise<Failure>;
  ownerOf(f: Failure): string;
  onCall(now: Date): string;
  send(text: string): Promise<void>;
  now(): Date;
  log(msg: string): void;
}

export interface PollOptions {
  baseline: boolean;
  maxAlertsPerPoll: number;
  outageThreshold: number;
}

export interface PollResult {
  listed: number;
  newFailures: number;
  alertsSent: number;
  baselined: number;
  outage: boolean;
}

export interface OnCallPerson {
  name: string;
  start: string;
  stop: string;
}

export interface OnCallConfig {
  rotationStart: string;
  people: OnCallPerson[];
}

const MAX_SEEN = 2000;

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function loadJson<T>(file: string): T {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(raw) as T;
}

export function escapeSlack(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 3) + '...' : s;
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const s = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(d);
  return s.replace(',', '') + ' PKT';
}

export function formatAlert(f: Failure, owner: string, onCall: string): string {
  const err = truncate(f.error.replace(/\s+/g, ' ').trim(), 300);
  return [
    ':red_circle: WORKFLOW FAILURE DETECTED',
    `Workflow: ${escapeSlack(f.workflowName)}`,
    `Owner: ${escapeSlack(owner)}`,
    `Failed at: ${formatTime(f.failedAt)} (execution ${escapeSlack(f.executionId)})`,
    `Error: ${escapeSlack(err)}`,
    `Impact: ${escapeSlack(f.impact)}`,
    'Action: Investigate within 1 hour',
    `On-call: ${escapeSlack(onCall)}`,
  ].join('\n');
}

export function ownerFor(owners: Record<string, string>, workflowId: string, workflowName: string): string {
  const v = owners[workflowId] || owners[workflowName];
  return v && v.trim().length > 0 ? v : 'UNASSIGNED (ask Sumavia)';
}

export function dateInPkt(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

function dayNumber(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number);
  return Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) / 86400000;
}

/** On-call comes from the 16 project workers only (Clarification 10), rotating daily among those available that day. */
export function pickOnCall(cfg: OnCallConfig, now: Date): string {
  const day = dateInPkt(now);
  const available = cfg.people.filter((p) => p.start <= day && day <= p.stop);
  if (available.length === 0) return 'No project worker available - escalate to Sumavia Abid';
  const n = available.length;
  const idx = (((dayNumber(day) - dayNumber(cfg.rotationStart)) % n) + n) % n;
  return available[idx]!.name;
}

export function freshState(): WatchdogState {
  return { baselineDone: false, seen: [], consecutiveErrors: 0, outageAlerted: false };
}

export function loadState(file: string, log: (m: string) => void): WatchdogState {
  if (!fs.existsSync(file)) return freshState();
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as Partial<WatchdogState>;
    return {
      baselineDone: raw.baselineDone === true,
      seen: Array.isArray(raw.seen) ? raw.seen.map(String) : [],
      consecutiveErrors: Number(raw.consecutiveErrors) || 0,
      outageAlerted: raw.outageAlerted === true,
    };
  } catch (e) {
    const bad = `${file}.corrupt-${Date.now()}`;
    fs.renameSync(file, bad);
    log(`state file unreadable (${errMsg(e)}); moved to ${bad}; starting fresh, existing failures will be baselined`);
    return freshState();
  }
}

export function saveState(file: string, state: WatchdogState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

export async function runPoll(state: WatchdogState, d: PollDeps, opts: PollOptions): Promise<PollResult> {
  const result: PollResult = { listed: 0, newFailures: 0, alertsSent: 0, baselined: 0, outage: false };

  let raws: RawFailure[];
  try {
    raws = await d.listFailures();
  } catch (e) {
    state.consecutiveErrors += 1;
    result.outage = true;
    d.log(`poll failed (${state.consecutiveErrors} in a row): ${errMsg(e)}`);
    if (state.consecutiveErrors >= opts.outageThreshold && !state.outageAlerted) {
      try {
        await d.send(
          `:warning: WATCHDOG: cannot reach n8n (${state.consecutiveErrors} polls failed in a row). Failures cannot be detected until it is back.`
        );
        state.outageAlerted = true;
      } catch (sendErr) {
        d.log(`could not send outage alert: ${errMsg(sendErr)}`);
      }
    }
    return result;
  }

  if (state.consecutiveErrors > 0) {
    const wasAlerted = state.outageAlerted;
    state.consecutiveErrors = 0;
    state.outageAlerted = false;
    if (wasAlerted) {
      try {
        await d.send(':white_check_mark: WATCHDOG: n8n is reachable again. Monitoring resumed.');
      } catch (sendErr) {
        d.log(`could not send recovery message: ${errMsg(sendErr)}`);
      }
    }
  }

  result.listed = raws.length;
  const seen = new Set(state.seen);

  if (!state.baselineDone && opts.baseline) {
    for (const r of raws) seen.add(r.executionId);
    state.seen = [...seen].slice(-MAX_SEEN);
    state.baselineDone = true;
    result.baselined = raws.length;
    d.log(`baseline recorded: ${raws.length} existing failed executions will not be alerted`);
    return result;
  }
  state.baselineDone = true;

  const fresh = raws
    .filter((r) => !seen.has(r.executionId))
    .sort((a, b) => a.failedAt.localeCompare(b.failedAt));
  result.newFailures = fresh.length;

  const toSend = fresh.slice(0, opts.maxAlertsPerPoll);
  const overflow = fresh.slice(opts.maxAlertsPerPoll);

  for (const raw of toSend) {
    try {
      const f = await d.describe(raw);
      await d.send(formatAlert(f, d.ownerOf(f), d.onCall(d.now())));
      seen.add(raw.executionId);
      result.alertsSent += 1;
    } catch (e) {
      d.log(`could not alert execution ${raw.executionId}, will retry next poll: ${errMsg(e)}`);
      break;
    }
  }

  if (overflow.length > 0 && result.alertsSent === toSend.length) {
    try {
      await d.send(
        `:red_circle: ${overflow.length} more failed executions were detected in the same poll and are not listed individually. Check the n8n Executions page.`
      );
      for (const r of overflow) seen.add(r.executionId);
    } catch (e) {
      d.log(`could not send overflow summary: ${errMsg(e)}`);
    }
  }

  state.seen = [...seen].slice(-MAX_SEEN);
  return result;
}
