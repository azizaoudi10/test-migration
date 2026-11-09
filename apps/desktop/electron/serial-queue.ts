/** A promise chain that serializes async work (file appends, rewrites,
 *  persistence) so callers can fire overlapping operations without ever
 *  interleaving their side effects or observing a half-written file. The
 *  chain never rejects: a failed task does not poison the queue. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task);
    this.tail = next.catch(() => undefined);
    return next;
  }

  /** Waits for everything queued so far (used at shutdown). */
  idle(): Promise<void> {
    return this.tail.then(
      () => undefined,
      () => undefined,
    );
  }
}
