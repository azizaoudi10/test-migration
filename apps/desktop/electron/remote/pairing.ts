import { randomBytes, timingSafeEqual } from 'node:crypto';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 — unambiguous
const CODE_CHARS = 8;
/** Failed submissions before the current code is rotated away (defense in
 *  depth against online guessing — audit REM-21). */
const MAX_ATTEMPTS = 5;

export interface PairingCodesOpts {
  /** How long a code stays valid before it rotates (default 5 min). */
  ttlMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export interface PairingCode {
  /** Display form: XXXX-XXXX. */
  code: string;
  expiresAt: number;
}

export type CodeVerdict = 'ok' | 'invalid-code';

/**
 * One-time pairing codes. A code is valid for `ttlMs`, is invalidated as soon
 * as it is used, and a fresh code is generated on demand (the bridge rotates
 * on a timer and right after a successful pair).
 *
 * The wire verdict is deliberately two-valued: a stale code answers
 * `invalid-code` exactly like a wrong one, so an attacker can never learn
 * that a guess matched the (about-to-rotate) code.
 */
export class PairingCodes {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private current: PairingCode | null = null;
  private failures = 0;

  constructor(opts: PairingCodesOpts = {}) {
    this.ttlMs = opts.ttlMs ?? 5 * 60_000;
    this.now = opts.now ?? (() => Date.now());
  }

  /** The live code, generated lazily; never returns an expired code. */
  currentOrNew(): PairingCode {
    if (!this.current || this.current.expiresAt <= this.now()) {
      this.current = this.generate();
    }
    return this.current;
  }

  /** Forces a fresh code (used right after a successful pair). */
  rotate(): PairingCode {
    this.failures = 0;
    this.current = this.generate();
    return this.current;
  }

  /** One failed submission; after MAX_ATTEMPTS the code rotates so an
   *  attacker's window restarts from zero (audit REM-21). */
  private registerFailure(): void {
    this.failures += 1;
    if (this.failures >= MAX_ATTEMPTS) {
      this.failures = 0;
      this.current = this.generate();
    }
  }

  get ttl(): number {
    return this.ttlMs;
  }

  /** Validates a submitted code: format, expiry, constant-time compare,
   *  and consumes it on success (single use). */
  check(submitted: string): CodeVerdict {
    const cleaned = submitted.toUpperCase().replace(/[\s-]/g, '');
    if (!/^[A-Z2-9]{8}$/.test(cleaned)) {
      this.registerFailure();
      return 'invalid-code';
    }
    const current = this.current;
    if (!current) {
      this.registerFailure();
      return 'invalid-code';
    }
    if (current.expiresAt <= this.now()) {
      // a matching stale code is consumed so rotation is forced; the verdict
      // stays 'invalid-code' — the response must not confirm a guess
      if (current.code.replace('-', '') === cleaned) this.current = null;
      this.registerFailure();
      return 'invalid-code';
    }
    if (!timingSafeEqual(Buffer.from(current.code.replace('-', '')), Buffer.from(cleaned))) {
      this.registerFailure();
      return 'invalid-code';
    }
    // single use: consume it even on the happy path
    this.failures = 0;
    this.current = null;
    return 'ok';
  }

  private generate(): PairingCode {
    const bytes = randomBytes(CODE_CHARS);
    let raw = '';
    for (let i = 0; i < CODE_CHARS; i += 1) {
      raw += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length]!;
    }
    return { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, expiresAt: this.now() + this.ttlMs };
  }
}
