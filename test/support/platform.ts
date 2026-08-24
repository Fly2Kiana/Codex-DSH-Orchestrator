import assert from "node:assert/strict";

export function assertPortablePrivateMode(mode: number, posixExpected: number): void {
  const observed = mode & 0o777;
  if (process.platform === "win32") {
    // Node exposes only a limited compatibility view of Windows ACLs.
    assert.equal(observed & 0o111, 0);
    return;
  }
  assert.equal(observed, posixExpected);
}

export function assertModePreserved(before: number, after: number): void {
  assert.equal(after & 0o777, before & 0o777);
}
