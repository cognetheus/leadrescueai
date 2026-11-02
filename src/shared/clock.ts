/** Injectable time source so retry, lease and deadline logic is testable without sleeping. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export class ManualClock implements Clock {
  constructor(private current: number = Date.UTC(2026, 0, 1)) {}
  now(): number {
    return this.current;
  }
  advance(ms: number): void {
    this.current += ms;
  }
  set(ms: number): void {
    this.current = ms;
  }
}

export const iso = (ms: number): string => new Date(ms).toISOString();
