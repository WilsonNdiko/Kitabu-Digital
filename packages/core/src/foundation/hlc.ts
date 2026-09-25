/**
 * Hybrid Logical Clock (ADR-004).
 *
 * Orders events across devices while tolerating clock skew: physical time from the
 * local clock, logical counter for same-millisecond events, device id as final
 * tiebreaker. Encoded form is lexicographically sortable:
 *
 *   `<physicalMs padded to 15>.<counter padded to 8>.<deviceId>`
 *
 * Ordering contract: a.hlc < b.hlc (encoded) ⇔ a is causally "not after" b, modulo
 * the usual HLC guarantees. Used for sync ordering and LWW-by-HLC conflict policy.
 */

import type { Clock } from './clock.ts';

export class Hlc {
  readonly physicalMs: number;
  readonly counter: number;
  readonly deviceId: string;

  constructor(physicalMs: number, counter: number, deviceId: string) {
    this.physicalMs = physicalMs;
    this.counter = counter;
    this.deviceId = deviceId;
  }

  get encoded(): string {
    return `${this.physicalMs.toString().padStart(15, '0')}.${this.counter.toString().padStart(8, '0')}.${this.deviceId}`;
  }

  static decode(encoded: string): Hlc {
    const parts = encoded.split('.');
    if (parts.length !== 3) throw new Error(`Invalid HLC: ${encoded}`);
    const physicalMs = Number(parts[0]);
    const counter = Number(parts[1]);
    const deviceId = parts[2]!;
    if (!Number.isInteger(physicalMs) || !Number.isInteger(counter) || deviceId.length === 0) {
      throw new Error(`Invalid HLC: ${encoded}`);
    }
    return new Hlc(physicalMs, counter, deviceId);
  }

  static compare(a: Hlc, b: Hlc): number {
    if (a.physicalMs !== b.physicalMs) return a.physicalMs < b.physicalMs ? -1 : 1;
    if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
    if (a.deviceId !== b.deviceId) return a.deviceId < b.deviceId ? -1 : 1;
    return 0;
  }

  static max(a: Hlc, b: Hlc): Hlc {
    return Hlc.compare(a, b) >= 0 ? a : b;
  }
}

const MAX_COUNTER = 99_999_999;

export class HybridLogicalClock {
  readonly deviceId: string;
  readonly #clock: Clock;
  #physicalMs: number = 0;
  #counter: number = 0;

  constructor(deviceId: string, clock: Clock) {
    this.deviceId = deviceId;
    this.#clock = clock;
  }

  /** Local event: strictly greater than every previously issued/observed HLC. */
  now(): Hlc {
    const wall = this.#clock.nowMs();
    if (wall > this.#physicalMs) {
      this.#physicalMs = wall;
      this.#counter = 0;
    } else {
      this.#counter += 1;
      if (this.#counter > MAX_COUNTER) {
        this.#physicalMs += 1;
        this.#counter = 0;
      }
    }
    return new Hlc(this.#physicalMs, this.#counter, this.deviceId);
  }

  /** Remote event received: the next local HLC will be greater than both sides. */
  observe(remote: Hlc): Hlc {
    const wall = this.#clock.nowMs();
    const maxPhys = Math.max(wall, this.#physicalMs, remote.physicalMs);
    if (maxPhys === this.#physicalMs && maxPhys === remote.physicalMs) {
      this.#counter = Math.max(this.#counter, remote.counter) + 1;
    } else if (maxPhys === this.#physicalMs) {
      this.#counter += 1;
    } else if (maxPhys === remote.physicalMs) {
      this.#counter = remote.counter + 1;
    } else {
      this.#counter = 0; // wall clock is strictly newest
    }
    this.#physicalMs = maxPhys;
    if (this.#counter > MAX_COUNTER) {
      this.#physicalMs += 1;
      this.#counter = 0;
    }
    return new Hlc(this.#physicalMs, this.#counter, this.deviceId);
  }

  /** Restore persisted state after restart so HLCs never regress across boots. */
  restore(encoded: string): void {
    this.observe(Hlc.decode(encoded));
  }
}
