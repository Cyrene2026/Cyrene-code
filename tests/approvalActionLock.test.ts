import { describe, expect, test } from "bun:test";
import { createApprovalActionLock } from "../src/application/chat/approvalActionLock";

describe("approvalActionLock", () => {
  test("allows only one in-flight approval action", () => {
    const lock = createApprovalActionLock();

    expect(lock.isLocked()).toBe(false);
    expect(lock.acquire("approve:a1")).toBe(true);
    expect(lock.isLocked()).toBe(true);
    expect(lock.current()).toBe("approve:a1");

    expect(lock.acquire("approve:a1")).toBe(false);
    expect(lock.acquire("reject:a1")).toBe(false);

    lock.release();

    expect(lock.isLocked()).toBe(false);
    expect(lock.current()).toBeNull();
    expect(lock.acquire("reject:a1")).toBe(true);
  });
});
