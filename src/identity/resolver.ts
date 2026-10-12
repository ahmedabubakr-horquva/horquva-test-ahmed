export interface Person {
  fullName: string;
  email: string;
}

export interface SourceAccount {
  source: string;
  sourceId: string;
  email: string | null;
  displayName: string | null;
}

export type MatchStatus = 'exact' | 'alias' | 'unmatched';
export type ReviewReason = 'no-valid-email' | 'no-match';

export interface ResolveResult {
  status: MatchStatus;
  person: Person | null;
  matchedOn: string | null;
  reason: ReviewReason | null;
  account: SourceAccount;
}

export interface ReviewItem {
  account: SourceAccount;
  reason: ReviewReason;
}

export function normalizeEmail(email: string | null | undefined): string | null {
  if (email === null || email === undefined) return null;
  const e = email.trim().toLowerCase();
  return e.length > 0 && e.includes('@') ? e : null;
}

/**
 * Email-first identity resolver.
 * Order: 1) exact lowercase email, 2) documented alias, 3) review queue.
 * Names are NEVER used for matching. No fuzzy logic.
 */
export class IdentityResolver {
  private byEmail = new Map<string, Person>();
  private aliasToEmail = new Map<string, string>();

  constructor(roster: Person[], aliases: Record<string, string> = {}) {
    for (const person of roster) {
      const email = normalizeEmail(person.email);
      if (email === null) throw new Error(`Roster entry has invalid email: ${person.fullName}`);
      if (this.byEmail.has(email)) throw new Error(`Duplicate roster email: ${email}`);
      this.byEmail.set(email, { fullName: person.fullName, email });
    }

    for (const [aliasRaw, canonicalRaw] of Object.entries(aliases)) {
      const alias = normalizeEmail(aliasRaw);
      const canonical = normalizeEmail(canonicalRaw);
      if (alias === null || canonical === null) {
        throw new Error(`Invalid alias entry: ${aliasRaw} -> ${canonicalRaw}`);
      }
      if (this.byEmail.has(alias)) {
        throw new Error(`Alias ${alias} is already a primary roster email`);
      }
      if (!this.byEmail.has(canonical)) {
        throw new Error(`Alias ${alias} points to unknown roster email ${canonical}`);
      }
      if (this.aliasToEmail.has(alias)) throw new Error(`Duplicate alias: ${alias}`);
      this.aliasToEmail.set(alias, canonical);
    }
  }

  resolve(account: SourceAccount): ResolveResult {
    const email = normalizeEmail(account.email);
    if (email === null) {
      return { status: 'unmatched', person: null, matchedOn: null, reason: 'no-valid-email', account };
    }

    const exact = this.byEmail.get(email);
    if (exact) {
      return { status: 'exact', person: exact, matchedOn: email, reason: null, account };
    }

    const canonical = this.aliasToEmail.get(email);
    if (canonical !== undefined) {
      const person = this.byEmail.get(canonical) ?? null;
      if (person) {
        return { status: 'alias', person, matchedOn: email, reason: null, account };
      }
    }

    return { status: 'unmatched', person: null, matchedOn: email, reason: 'no-match', account };
  }

  resolveAll(accounts: SourceAccount[]): { results: ResolveResult[]; reviewQueue: ReviewItem[] } {
    const results = accounts.map((a) => this.resolve(a));
    const reviewQueue: ReviewItem[] = [];
    for (const r of results) {
      if (r.status === 'unmatched' && r.reason !== null) {
        reviewQueue.push({ account: r.account, reason: r.reason });
      }
    }
    return { results, reviewQueue };
  }
}
