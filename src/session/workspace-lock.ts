import { randomUUID } from "node:crypto";
import {
  closeSync,
  chmodSync,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  WorkspaceBusyError,
  WorkspaceLockCorruptError,
  RegistryValidationError,
} from "../errors.js";
import { assertSafeStateDirectory, SessionRegistry, type ResolveStateDirectoryOptions } from "./registry.js";

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:@+_-]{1,512}$/;
const LOCK_VERSION = 1;

interface LockRecord {
  version: 1;
  workspaceFingerprint: string;
  openCodeSessionId: string;
  ownerToken: string;
  pid: number;
  acquiredAt: number;
}

export interface WorkspaceLockOptions extends ResolveStateDirectoryOptions {
  stateDirectory?: string;
  isProcessAlive?: (pid: number) => boolean;
  now?: () => number;
  ownerToken?: () => string;
}

export interface LockLease {
  readonly workspaceFingerprint: string;
  readonly openCodeSessionId: string;
  release(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeLock(value: unknown, workspaceFingerprint: string): LockRecord {
  if (!isRecord(value)
    || value.version !== LOCK_VERSION
    || value.workspaceFingerprint !== workspaceFingerprint
    || typeof value.openCodeSessionId !== "string"
    || !IDENTIFIER_PATTERN.test(value.openCodeSessionId)
    || typeof value.ownerToken !== "string"
    || value.ownerToken.length === 0
    || typeof value.pid !== "number"
    || !Number.isInteger(value.pid)
    || value.pid <= 0
    || typeof value.acquiredAt !== "number"
    || !Number.isFinite(value.acquiredAt)
    || Object.keys(value).some((key) => !["version", "workspaceFingerprint", "openCodeSessionId", "ownerToken", "pid", "acquiredAt"].includes(key))) {
    throw new WorkspaceLockCorruptError();
  }
  return value as unknown as LockRecord;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM" || code !== "ESRCH";
  }
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function syncDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    fsyncSync(descriptor);
  } catch {
    // Directory fsync is not available on every supported platform.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export class WorkspaceLock {
  private readonly directory: string;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly now: () => number;
  private readonly createOwnerToken: () => string;

  constructor(options: WorkspaceLockOptions = {}) {
    const stateDirectory = assertSafeStateDirectory(
      options.stateDirectory ?? SessionRegistry.resolveStateDirectory(options),
      options,
    );
    this.directory = join(stateDirectory, "locks");
    this.isProcessAlive = options.isProcessAlive ?? processIsAlive;
    this.now = options.now ?? Date.now;
    this.createOwnerToken = options.ownerToken ?? randomUUID;
  }

  async acquire(workspaceFingerprint: string, openCodeSessionId: string): Promise<LockLease> {
    if (!HASH_PATTERN.test(workspaceFingerprint) || !IDENTIFIER_PATTERN.test(openCodeSessionId)) throw new RegistryValidationError();
    ensurePrivateDirectory(dirname(this.directory));
    ensurePrivateDirectory(this.directory);
    const path = join(this.directory, `${workspaceFingerprint}.lock`);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const record: LockRecord = {
        version: LOCK_VERSION,
        workspaceFingerprint,
        openCodeSessionId,
        ownerToken: this.createOwnerToken(),
        pid: process.pid,
        acquiredAt: this.now(),
      };
      try {
        this.create(path, record);
        return this.lease(path, record);
      } catch (error) {
        if (!isExistsError(error)) throw new WorkspaceLockCorruptError();
      }

      const existing = this.read(path, workspaceFingerprint);
      if (!existing) continue;
      if (this.isProcessAlive(existing.pid)) throw new WorkspaceBusyError();
      if (!this.removeIfUnchanged(path, existing)) throw new WorkspaceBusyError();
    }

    throw new WorkspaceBusyError();
  }

  private create(path: string, record: LockRecord): void {
    let descriptor: number | undefined;
    const temporary = `${path}.${record.ownerToken}.tmp`;
    try {
      descriptor = openSync(temporary, "wx", 0o600);
      writeFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      linkSync(temporary, path);
      try { unlinkSync(temporary); } catch { /* the private temporary hard link is safe to clean later */ }
      syncDirectory(dirname(path));
    } catch (error) {
      if (descriptor !== undefined) {
        try { closeSync(descriptor); } catch { /* preserve the original failure */ }
      }
      try { unlinkSync(temporary); } catch { /* best-effort temp cleanup */ }
      throw error;
    }
  }

  private read(path: string, workspaceFingerprint: string): LockRecord | undefined {
    try {
      if (!existsSync(path)) return undefined;
      if (statSync(path).size > 16_384) throw new WorkspaceLockCorruptError();
      return decodeLock(JSON.parse(readFileSync(path, "utf8")) as unknown, workspaceFingerprint);
    } catch (error) {
      if (isMissingError(error)) return undefined;
      if (error instanceof WorkspaceLockCorruptError) throw error;
      throw new WorkspaceLockCorruptError();
    }
  }

  /** Synchronous recheck narrows the stale-owner race before reclaiming its lock. */
  private removeIfUnchanged(path: string, observed: LockRecord): boolean {
    const claimPath = `${path}.reclaim`;
    const claimToken = this.createOwnerToken();
    const claim = { version: LOCK_VERSION, ownerToken: claimToken, pid: process.pid };
    let claimDescriptor: number | undefined;
    const temporaryClaimPath = `${claimPath}.${claimToken}.tmp`;
    try {
      claimDescriptor = openSync(temporaryClaimPath, "wx", 0o600);
      writeFileSync(claimDescriptor, `${JSON.stringify(claim)}\n`, "utf8");
      fsyncSync(claimDescriptor);
      closeSync(claimDescriptor);
      claimDescriptor = undefined;
      linkSync(temporaryClaimPath, claimPath);
      try { unlinkSync(temporaryClaimPath); } catch { /* the private temporary hard link is safe to clean later */ }
      syncDirectory(dirname(path));
    } catch (error) {
      if (claimDescriptor !== undefined) {
        try { closeSync(claimDescriptor); } catch { /* preserve the original failure */ }
      }
      try { unlinkSync(temporaryClaimPath); } catch { /* best-effort temporary cleanup */ }
      if (!isExistsError(error)) throw new WorkspaceLockCorruptError();
      const existingClaim = this.readRecoveryClaim(claimPath);
      if (this.isProcessAlive(existingClaim.pid)) throw new WorkspaceBusyError();
      // A crashed recovery owner cannot be safely removed by a competing process;
      // fail closed rather than risk deleting a newly acquired workspace lock.
      throw new WorkspaceLockCorruptError();
    }

    try {
      const before = statSync(path);
      const current = this.read(path, observed.workspaceFingerprint);
      if (!current) return true;
      const after = statSync(path);
      if (current.ownerToken !== observed.ownerToken || before.dev !== after.dev || before.ino !== after.ino) return false;
      if (this.isProcessAlive(current.pid)) return false;
      unlinkSync(path);
      syncDirectory(dirname(path));
      return true;
    } catch (error) {
      if (isMissingError(error)) return true;
      if (error instanceof WorkspaceLockCorruptError) throw error;
      return false;
    } finally {
      try {
        const currentClaim = this.readRecoveryClaim(claimPath);
        if (currentClaim.ownerToken === claimToken && currentClaim.pid === process.pid) unlinkSync(claimPath);
      } catch {
        // Do not remove a malformed or replaced recovery claim.
      }
    }
  }

  private readRecoveryClaim(path: string): { ownerToken: string; pid: number } {
    try {
      const value: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!isRecord(value)
        || value.version !== LOCK_VERSION
        || typeof value.ownerToken !== "string"
        || typeof value.pid !== "number"
        || !Number.isInteger(value.pid)
        || Object.keys(value).some((key) => !["version", "ownerToken", "pid"].includes(key))) {
        throw new WorkspaceLockCorruptError();
      }
      return { ownerToken: value.ownerToken, pid: value.pid };
    } catch (error) {
      if (error instanceof WorkspaceLockCorruptError) throw error;
      throw new WorkspaceLockCorruptError();
    }
  }

  private lease(path: string, record: LockRecord): LockLease {
    let released = false;
    return {
      workspaceFingerprint: record.workspaceFingerprint,
      openCodeSessionId: record.openCodeSessionId,
      release: async () => {
        if (released) return;
        released = true;
        let current: LockRecord | undefined;
        try {
          current = this.read(path, record.workspaceFingerprint);
        } catch (error) {
          throw error;
        }
        if (!current) {
          released = true;
          return;
        }
        if (current.ownerToken !== record.ownerToken || current.pid !== record.pid) {
          released = true;
          return;
        }
        try {
          unlinkSync(path);
          syncDirectory(dirname(path));
          released = true;
        } catch (error) {
          if (isMissingError(error)) {
            released = true;
            return;
          }
          throw new WorkspaceLockCorruptError();
        }
      },
    };
  }
}

function isExistsError(error: unknown): boolean {
  return isNodeErrorCode(error, "EEXIST");
}

function isMissingError(error: unknown): boolean {
  return isNodeErrorCode(error, "ENOENT");
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
