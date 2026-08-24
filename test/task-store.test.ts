import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DuplicateSessionMappingError, TaskStore, TaskStoreError } from "../src/task-store.js";
import { assertPortablePrivateMode } from "./support/platform.js";

test("TaskStore persists only taskId to sessionId with private POSIX modes where supported", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-store-"));
  try {
    const store = new TaskStore(home);
    const record = await store.create("session-root");
    const path = join(home, "tasks", `${record.taskId}.json`);
    const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;

    assert.deepEqual(Object.keys(raw).sort(), ["sessionId", "taskId"]);
    assert.deepEqual(await store.get(record.taskId), record);
    assert.deepEqual(await store.list(), [record]);
    assertPortablePrivateMode((await stat(join(home, "tasks"))).mode, 0o700);
    assertPortablePrivateMode((await stat(path)).mode, 0o600);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("TaskStore rejects invalid ids, malformed mappings, and content-bearing extras", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-store-"));
  try {
    const store = new TaskStore(home);
    await assert.rejects(() => store.get("../escape"), TaskStoreError);

    await mkdir(join(home, "tasks"), { recursive: true });
    await writeFile(join(home, "tasks", "dsh_000000000001.json"), "{not-json}\n");
    await assert.rejects(() => store.get("dsh_000000000001"), TaskStoreError);

    await writeFile(
      join(home, "tasks", "dsh_000000000002.json"),
      JSON.stringify({ taskId: "dsh_000000000002", sessionId: "session-2", prompt: "must-not-surface" }),
    );
    await assert.rejects(() => store.get("dsh_000000000002"), TaskStoreError);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("TaskStore atomically reuses one task mapping for the same session", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-store-"));
  try {
    const stores = Array.from({ length: 8 }, () => new TaskStore(home));
    const resolutions = await Promise.all(stores.map((store) => store.createOrGetBySession("session-shared")));

    assert.equal(new Set(resolutions.map(({ task }) => task.taskId)).size, 1);
    assert.equal(resolutions.filter(({ created }) => created).length, 1);
    assert.equal((await stores[0]!.list()).length, 1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("TaskStore fails closed when legacy mappings duplicate one session", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-store-"));
  try {
    const tasksDir = join(home, "tasks");
    await mkdir(tasksDir, { recursive: true });
    await writeFile(
      join(tasksDir, "dsh_000000000010.json"),
      JSON.stringify({ taskId: "dsh_000000000010", sessionId: "session-duplicate" }),
    );
    await writeFile(
      join(tasksDir, "dsh_000000000011.json"),
      JSON.stringify({ taskId: "dsh_000000000011", sessionId: "session-duplicate" }),
    );

    await assert.rejects(
      () => new TaskStore(home).createOrGetBySession("session-duplicate"),
      (error: unknown) => error instanceof DuplicateSessionMappingError && error.taskIds.length === 2,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
