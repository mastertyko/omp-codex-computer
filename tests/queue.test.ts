import { describe, expect, it } from "vitest";
import { SerialQueue } from "../src/queue";

describe("SerialQueue", () => {
  it("runs tasks sequentially", async () => {
    const queue = new SerialQueue();
    const events: string[] = [];

    const first = queue.enqueue(async () => {
      events.push("first:start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      events.push("first:end");
      return 1;
    });

    const second = queue.enqueue(async () => {
      events.push("second:start");
      events.push("second:end");
      return 2;
    });

    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  it("continues after a failed task", async () => {
    const queue = new SerialQueue();

    await expect(
      queue.enqueue(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(queue.enqueue(async () => "ok")).resolves.toBe("ok");
  });

  it("rejects a queued task immediately on abort and skips it", async () => {
    const queue = new SerialQueue();
    const controller = new AbortController();
    const firstGate = Promise.withResolvers<void>();
    let secondRan = false;

    const first = queue.enqueue(() => firstGate.promise);
    const second = queue.enqueue(async () => {
      secondRan = true;
      return "never";
    }, controller.signal);

    controller.abort();
    await expect(second).rejects.toMatchObject({ name: "AbortError" });

    firstGate.resolve();
    await first;
    await queue.enqueue(async () => undefined);
    expect(secondRan).toBe(false);
  });

  it("delivers the task's own outcome once it has started", async () => {
    const queue = new SerialQueue();
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const result = Promise.withResolvers<string>();

    const task = queue.enqueue(() => {
      started.resolve();
      return result.promise;
    }, controller.signal);
    await started.promise;

    controller.abort();
    result.resolve("done");
    await expect(task).resolves.toBe("done");
  });

  it("rejects an already-aborted enqueue without touching the queue", async () => {
    const queue = new SerialQueue();
    const controller = new AbortController();
    controller.abort();
    let ran = false;

    await expect(queue.enqueue(async () => {
      ran = true;
    }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(ran).toBe(false);
    await expect(queue.enqueue(async () => "ok")).resolves.toBe("ok");
  });
});
