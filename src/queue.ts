export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();

  /**
   * Enqueue a task. With a signal, an abort while the task is still QUEUED
   * rejects the caller immediately and skips the task when its turn comes;
   * once the task has started, its own outcome is always delivered.
   */
  enqueue<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) {
      const run = this.tail.then(fn, fn);
      this.tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    }

    if (signal.aborted) return Promise.reject(createAbortError());

    return new Promise<T>((resolve, reject) => {
      let started = false;
      const onAbort = () => {
        if (!started) reject(createAbortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      // Listeners added after abort never fire; re-check once subscribed so
      // the wait can never outlive its signal.
      if (signal.aborted) onAbort();

      const task = async (): Promise<void> => {
        started = true;
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) {
          reject(createAbortError());
          return;
        }
        try {
          resolve(await fn());
        } catch (error) {
          reject(error);
        }
      };
      const run = this.tail.then(task, task);
      this.tail = run.then(
        () => undefined,
        () => undefined,
      );
    });
  }
}

function createAbortError(): Error {
  const error = new Error("Queued operation aborted");
  error.name = "AbortError";
  return error;
}
