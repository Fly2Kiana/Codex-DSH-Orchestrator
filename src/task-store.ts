import { randomBytes } from "node:crypto";
import { chmod, link, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { withFileLock } from "./file-lock.js";

export interface TaskRecord {
  taskId: string;
  sessionId: string;
}

export class TaskStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TaskStoreError";
  }
}

export class TaskNotFoundError extends TaskStoreError {
  constructor(readonly taskId: string) {
    super(`DSH task ${JSON.stringify(taskId)} does not exist`);
    this.name = "TaskNotFoundError";
  }
}

export class DuplicateSessionMappingError extends TaskStoreError {
  readonly code = "duplicate_session_mapping";

  constructor(
    readonly sessionId: string,
    readonly taskIds: string[],
  ) {
    super(
      `DSH session ${JSON.stringify(sessionId)} is mapped to multiple bridge tasks: ${taskIds
        .map((taskId) => JSON.stringify(taskId))
        .join(", ")}`,
    );
    this.name = "DuplicateSessionMappingError";
  }
}

export interface TaskMappingResolution {
  task: TaskRecord;
  created: boolean;
}

const TASK_ID_PATTERN = /^dsh_[a-f0-9]{12}$/;

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
}

function validateRecord(value: unknown, expectedTaskId: string): TaskRecord {
  const keys =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? Object.keys(value as Record<string, unknown>).sort()
      : [];
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof (value as Record<string, unknown>).taskId !== "string" ||
    (value as Record<string, unknown>).taskId !== expectedTaskId ||
    !TASK_ID_PATTERN.test(expectedTaskId) ||
    typeof (value as Record<string, unknown>).sessionId !== "string" ||
    ((value as Record<string, unknown>).sessionId as string).length === 0 ||
    keys.length !== 2 ||
    keys[0] !== "sessionId" ||
    keys[1] !== "taskId"
  ) {
    throw new TaskStoreError(`invalid dsh-Agentlink task mapping for ${JSON.stringify(expectedTaskId)}`);
  }
  return { taskId: expectedTaskId, sessionId: (value as Record<string, unknown>).sessionId as string };
}

function parseRecord(raw: string, expectedTaskId: string): TaskRecord {
  try {
    return validateRecord(JSON.parse(raw), expectedTaskId);
  } catch (error) {
    if (error instanceof TaskStoreError) throw error;
    throw new TaskStoreError(`could not parse dsh-Agentlink task mapping ${JSON.stringify(expectedTaskId)}`, { cause: error });
  }
}

export class TaskStore {
  private readonly tasksDir: string;

  constructor(homeDir: string) {
    this.tasksDir = join(homeDir, "tasks");
  }

  generateTaskId(): string {
    return `dsh_${randomBytes(6).toString("hex")}`;
  }

  async create(sessionId: string): Promise<TaskRecord> {
    return (await this.createOrGetBySession(sessionId)).task;
  }

  async createOrGetBySession(sessionId: string): Promise<TaskMappingResolution> {
    if (sessionId.length === 0) throw new TaskStoreError("session id must not be empty");
    return this.withRegistryLock(() => this.resolveOrCreateUnlocked(sessionId));
  }

  async createOrGetBySessionTransaction<T>(
    sessionId: string,
    work: (resolution: TaskMappingResolution) => Promise<T>,
  ): Promise<T> {
    if (sessionId.length === 0) throw new TaskStoreError("session id must not be empty");
    return this.withRegistryLock(async () => {
      const resolution = await this.resolveOrCreateUnlocked(sessionId);
      try {
        return await work(resolution);
      } catch (error) {
        if (resolution.created) {
          try {
            await unlink(this.pathFor(resolution.task.taskId));
          } catch (rollbackError) {
            throw new TaskStoreError(
              `could not roll back failed dsh-Agentlink task mapping ${JSON.stringify(resolution.task.taskId)}`,
              { cause: new AggregateError([error, rollbackError]) },
            );
          }
        }
        throw error;
      }
    });
  }

  private async resolveOrCreateUnlocked(sessionId: string): Promise<TaskMappingResolution> {
    const matches = (await this.listUnlocked()).filter((record) => record.sessionId === sessionId);
    if (matches.length > 1) {
      throw new DuplicateSessionMappingError(
        sessionId,
        matches.map((record) => record.taskId),
      );
    }
    if (matches[0] !== undefined) return { task: matches[0], created: false };
    return { task: await this.createUnlocked(sessionId), created: true };
  }

  private async createUnlocked(sessionId: string): Promise<TaskRecord> {
    if (sessionId.length === 0) throw new TaskStoreError("session id must not be empty");

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const taskId = this.generateTaskId();
      const target = this.pathFor(taskId);
      const temp = join(this.tasksDir, `.${taskId}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
      const record: TaskRecord = { taskId, sessionId };
      try {
        await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
        await link(temp, target);
        await unlink(temp).catch(() => undefined);
        return record;
      } catch (error) {
        await unlink(temp).catch(() => undefined);
        if (errorCode(error) !== "EEXIST") throw error;
      }
    }
    throw new TaskStoreError("could not allocate a unique DSH task id");
  }

  async get(taskId: string): Promise<TaskRecord> {
    let raw: string;
    try {
      raw = await readFile(this.pathFor(taskId), "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") throw new TaskNotFoundError(taskId);
      throw error;
    }
    return parseRecord(raw, taskId);
  }

  async list(): Promise<TaskRecord[]> {
    return this.listUnlocked();
  }

  private async listUnlocked(): Promise<TaskRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.tasksDir);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return [];
      throw error;
    }
    const taskIds = names
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length))
      .sort();
    return Promise.all(
      taskIds.map(async (taskId) => parseRecord(await readFile(this.pathFor(taskId), "utf8"), taskId)),
    );
  }

  private async withRegistryLock<T>(work: () => Promise<T>): Promise<T> {
    await mkdir(this.tasksDir, { recursive: true, mode: 0o700 });
    await chmod(this.tasksDir, 0o700);
    return withFileLock(join(this.tasksDir, "registry.lock"), work);
  }

  private pathFor(taskId: string): string {
    if (!TASK_ID_PATTERN.test(taskId)) throw new TaskStoreError(`invalid task id ${JSON.stringify(taskId)}`);
    return join(this.tasksDir, `${taskId}.json`);
  }
}
