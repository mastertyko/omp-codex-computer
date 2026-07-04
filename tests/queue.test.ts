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
});
