type Job = { key: string; work: () => Promise<void> };

/**
 * Schedules out-of-band refreshes so a Deck tick never awaits a subprocess.
 * Two bounds: one in-flight job per key (a slow call is not re-issued by the next
 * tick), and a hard concurrency cap (a first open with a dozen stale repos must
 * not fork a dozen processes). Never rejects — a failing job frees its slot.
 */
export class RefreshQueue {
  private readonly active = new Set<string>();
  private readonly queued: Job[] = [];
  private waiters: (() => void)[] = [];

  constructor(private readonly limit = 4) {}

  get inFlight(): number {
    return this.active.size;
  }

  get pending(): number {
    return this.queued.length;
  }

  /** Enqueue work for `key`. A no-op when that key is already active or queued. */
  push(key: string, work: () => Promise<void>): void {
    if (this.active.has(key) || this.queued.some((j) => j.key === key)) return;
    this.queued.push({ key, work });
    this.pump();
  }

  /** Resolves once nothing is active or queued. */
  idle(): Promise<void> {
    if (this.active.size === 0 && this.queued.length === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  /** Drop everything not yet started. In-flight work is left to settle — killing a
   * subprocess mid-flight would risk a half-written cache entry. */
  clear(): void {
    this.queued.length = 0;
    this.settle();
  }

  private pump(): void {
    while (this.queued.length > 0 && this.active.size < this.limit) {
      const job = this.queued.shift() as Job;
      this.active.add(job.key);
      void job
        .work()
        .catch(() => {
          /* a job owns its own errors; the queue only owns the slot */
        })
        .then(() => {
          this.active.delete(job.key);
          this.pump();
          this.settle();
        });
    }
  }

  private settle(): void {
    if (this.active.size > 0 || this.queued.length > 0) return;
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }
}
