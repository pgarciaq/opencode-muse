export type MuseBridgeErrorCode =
  | "MUSE_HOST_START_FAILED"
  | "MUSE_STARTUP_TIMEOUT"
  | "MUSE_COMMAND_TIMEOUT"
  | "MUSE_REQUEST_TIMEOUT"
  | "MUSE_COMMAND_REJECTED"
  | "MUSE_PROTOCOL_ERROR"
  | "MUSE_TRANSPORT_ERROR"
  | "MUSE_HOST_CLOSED"
  | "MUSE_REGISTRY_ERROR"
  | "MUSE_REGISTRY_STORAGE_ERROR"
  | "MUSE_WORKSPACE_BUSY"
  | "MUSE_WORKSPACE_LOCK_CORRUPT";

/** Safe plugin error: never attach raw CLI stderr, MSP text, prompts, or payloads. */
export class MuseBridgeError extends Error {
  constructor(
    readonly code: MuseBridgeErrorCode,
    message: string,
    readonly retryable?: boolean,
  ) {
    super(message);
    this.name = "MuseBridgeError";
  }
}

export class MspStartupTimeoutError extends MuseBridgeError {
  constructor(readonly timeoutMs: number) {
    super("MUSE_STARTUP_TIMEOUT", `Muse host did not initialize within ${timeoutMs}ms`, true);
    this.name = "MspStartupTimeoutError";
  }
}

export class MspCommandTimeoutError extends MuseBridgeError {
  readonly outcomeMayBeUnknown = true;

  constructor(readonly method: string, readonly timeoutMs: number) {
    super("MUSE_COMMAND_TIMEOUT", `Muse command ${method} timed out; its outcome may be unknown`, false);
    this.name = "MspCommandTimeoutError";
  }
}

export class MspRequestTimeoutError extends MuseBridgeError {
  constructor(readonly method: string, readonly timeoutMs: number) {
    super("MUSE_REQUEST_TIMEOUT", `Muse request ${method} timed out`, true);
    this.name = "MspRequestTimeoutError";
  }
}

export class MspCommandRejectedError extends MuseBridgeError {
  constructor(
    readonly method: string,
    readonly mspCode: number,
    readonly mspKind: string,
    retryable?: boolean,
  ) {
    super("MUSE_COMMAND_REJECTED", `Muse rejected command ${method} (${mspKind}, ${mspCode})`, retryable);
    this.name = "MspCommandRejectedError";
  }
}

export class MspProtocolError extends MuseBridgeError {
  constructor(readonly method?: string) {
    super("MUSE_PROTOCOL_ERROR", method ? `Muse protocol error during ${method}` : "Muse protocol error", false);
    this.name = "MspProtocolError";
  }
}

export class MspTransportError extends MuseBridgeError {
  constructor(readonly method?: string) {
    super("MUSE_TRANSPORT_ERROR", method ? `Muse transport failed during ${method}` : "Muse transport failed", true);
    this.name = "MspTransportError";
  }
}

export class MspHostClosedError extends MuseBridgeError {
  constructor() {
    super("MUSE_HOST_CLOSED", "Muse host is closed", false);
    this.name = "MspHostClosedError";
  }
}

export class MspHostStartError extends MuseBridgeError {
  constructor(readonly reason: "spawn-failed" | "host-exited" | "initialize-rejected" | "unknown") {
    super("MUSE_HOST_START_FAILED", `Muse host failed to start (${reason})`, reason !== "initialize-rejected");
    this.name = "MspHostStartError";
  }
}

export class MspInitializeRejectedError extends MuseBridgeError {
  constructor(readonly mspCode: number, readonly mspKind: string) {
    super("MUSE_HOST_START_FAILED", `Muse rejected initialization (${mspKind}, ${mspCode})`, false);
    this.name = "MspInitializeRejectedError";
  }
}

export class MspSchemaMismatchError extends MuseBridgeError {
  constructor(readonly pinned: string, readonly served: string) {
    super("MUSE_HOST_START_FAILED", "Muse host schema fingerprint does not match the pinned MSP schema", false);
    this.name = "MspSchemaMismatchError";
  }
}

export class RegistryValidationError extends MuseBridgeError {
  constructor() {
    super("MUSE_REGISTRY_ERROR", "Muse session registry entry is invalid or contains unsupported fields", false);
    this.name = "RegistryValidationError";
  }
}

export class RegistryCorruptError extends MuseBridgeError {
  constructor() {
    super("MUSE_REGISTRY_ERROR", "Muse session registry entry is corrupt and could not be quarantined safely", false);
    this.name = "RegistryCorruptError";
  }
}

export class RegistryStorageError extends MuseBridgeError {
  constructor() {
    super("MUSE_REGISTRY_STORAGE_ERROR", "Muse session registry storage operation failed", true);
    this.name = "RegistryStorageError";
  }
}

export class RegistryWorkspaceMismatchError extends MuseBridgeError {
  constructor() {
    super("MUSE_REGISTRY_ERROR", "OpenCode session is already bound to a different workspace", false);
    this.name = "RegistryWorkspaceMismatchError";
  }
}

export class WorkspaceBusyError extends MuseBridgeError {
  constructor() {
    super("MUSE_WORKSPACE_BUSY", "Another OpenCode session currently owns this workspace", true);
    this.name = "WorkspaceBusyError";
  }
}

export class WorkspaceLockCorruptError extends MuseBridgeError {
  constructor() {
    super("MUSE_WORKSPACE_LOCK_CORRUPT", "Workspace lock is corrupt; refusing to assume it is stale", false);
    this.name = "WorkspaceLockCorruptError";
  }
}
