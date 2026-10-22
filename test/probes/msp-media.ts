import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  createUuidV7Mint,
  spawnMspConnection,
  type Connection,
} from "@muse-code/sdk";

type ProbeEvent = { method: string; params: Record<string, unknown> };

const workspaceRoot = process.env.MUSE_PROBE_WORKSPACE ?? mkdtempSync("/tmp/opencode/muse-media-workspace-");
const provider = "meta";
const modelId = process.env.MUSE_PROBE_MODEL;
const emit = (value: unknown) => console.log(JSON.stringify(value));
const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);

mkdirSync(workspaceRoot, { recursive: true });
if (process.env.MUSE_PROBE_WORKSPACE === undefined) {
  execFileSync("git", ["init", "--quiet", "-b", "main", workspaceRoot]);
  execFileSync("git", ["-C", workspaceRoot, "config", "user.name", "Muse Probe"]);
  execFileSync("git", ["-C", workspaceRoot, "config", "user.email", "muse-probe@example.invalid"]);
  execFileSync("git", ["-C", workspaceRoot, "commit", "--quiet", "--allow-empty", "-m", "probe workspace"]);
}

const fixtureDir = mkdtempSync("/tmp/opencode/muse-media-fixture-");
const imagePath = join(fixtureDir, "red.png");
const videoPath = join(fixtureDir, "red.mp4");
let spawned: Awaited<ReturnType<ReturnType<typeof spawnMspConnection>["initialize"]>> | undefined;
let stage = "fixture-generation";

function makeFixture(command: string, args: string[]): void {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: "ignore" });
  if (result.error || result.status !== 0) throw new Error("fixture generation failed");
}

function collectNotifications(connection: Connection) {
  const events: ProbeEvent[] = [];
  const waiters: Array<{
    afterIndex: number;
    predicate: (event: ProbeEvent) => boolean;
    resolve: (event: ProbeEvent) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  connection.onNotification((notification) => {
    const event: ProbeEvent = { method: notification.method, params: notification.params ?? {} };
    events.push(event);
    for (const waiter of [...waiters]) {
      if (events.length - 1 < waiter.afterIndex || !waiter.predicate(event)) continue;
      clearTimeout(waiter.timer);
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(event);
    }
  });

  return {
    events,
    waitFor(predicate: (event: ProbeEvent) => boolean, afterIndex: number, timeoutMs = 120_000): Promise<ProbeEvent> {
      const existing = events.slice(afterIndex).find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = {
          afterIndex,
          predicate,
          resolve,
          timer: setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) waiters.splice(index, 1);
            reject(new Error("timed out waiting for turn completion"));
          }, timeoutMs),
        };
        waiters.push(waiter);
      });
    },
  };
}

function ownsTurn(event: ProbeEvent, sessionId: string, turnId: string): boolean {
  if (event.params.sessionId !== sessionId) return false;
  if (event.params.turnId === turnId) return true;
  const item = event.params.item as { turnId?: string | null } | undefined;
  return item?.turnId === turnId;
}

function summarizeEvent(event: ProbeEvent) {
  const item = event.params.item as { kind?: string; status?: string; turnId?: string | null } | undefined;
  const eventTurnId = typeof event.params.turnId === "string" ? event.params.turnId : item?.turnId;
  const usage = event.params.usage as Record<string, unknown> | undefined;
  return {
    method: event.method,
    turnIdHash: typeof eventTurnId === "string" ? hash(eventTurnId) : null,
    itemKind: item?.kind ?? null,
    itemStatus: item?.status ?? null,
    usage: usage
      ? Object.fromEntries(Object.entries(usage).filter(([, count]) => typeof count === "number"))
      : null,
  };
}

try {
  stage = "fixture-generation";
  makeFixture("convert", ["-size", "16x16", "xc:red", imagePath]);
  makeFixture("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=16x16:d=1:r=1",
    "-an", "-c:v", "mpeg4", "-pix_fmt", "yuv420p", "-y", videoPath,
  ]);
  const image = readFileSync(imagePath);
  const video = readFileSync(videoPath);

  stage = "msp-handshake";
  const handshake = spawnMspConnection({
    command: process.env.MUSE_BIN ?? "muse",
    args: ["serve", "--provider", provider, "--trust-workspace", "--disable-shell", "--disable-write", ...(modelId ? ["--model", modelId] : [])],
    cwd: workspaceRoot,
    shutdownTimeoutMs: 5_000,
  });
  try {
    spawned = await handshake.initialize({
      clientInfo: { name: "opencode_muse_media_probe", version: "0.1.0" },
    });
  } catch (error) {
    await handshake.close();
    throw error;
  }

  const connection = spawned.connection;
  const notifications = collectNotifications(connection);
  stage = "session-start";
  const start = await connection.command("session/start", {
    workspaceRoot,
    approvalMode: "onRequest",
    ...(modelId ? { modelId } : {}),
    providerId: "meta",
  });
  const sessionId = String((start.session as { sessionId: string }).sessionId);

  stage = "video-upload";
  const mintUuidV7 = createUuidV7Mint();
  const uploadId = mintUuidV7();
  const upload = await connection.command("media/upload", {
    chunkBase64: video.toString("base64"),
    chunkCount: 1,
    chunkIndex: 0,
    mediaType: "video/mp4",
    sessionId,
    totalBytes: video.byteLength,
    uploadId,
  });
  const receiptMatches = String(upload.uploadId) === uploadId;

  stage = "turn-start";
  const turnStartIndex = notifications.events.length;
  const ack = await connection.command("turn/start", {
    sessionId,
    displayText: "opencode-muse image/video probe",
    input: [
      { type: "text", text: "Briefly identify the image and video colors; if either attachment is unavailable, say which one." },
      { type: "image", base64Data: image.toString("base64"), mediaType: "image/png", width: 16, height: 16 },
      { type: "video", uploadId: String(upload.uploadId) },
    ],
  });
  const turnId = String(ack.turnId);
  stage = "wait-turn-completed";
  const terminal = await notifications.waitFor((event) =>
    event.method === "turn/completed" && event.params.sessionId === sessionId && event.params.turnId === turnId,
    turnStartIndex,
  );
  const turnEvents = notifications.events
    .filter((event) => ownsTurn(event, sessionId, turnId))
    .map(summarizeEvent);
  const completed = terminal.params;
  const terminalUsage = completed.usage as Record<string, unknown> | undefined;
  const sessionUsage = notifications.events
    .filter((event) => event.method === "session/tokenUsage" && event.params.sessionId === sessionId)
    .map(summarizeEvent);

  emit({
    status: "MSP_MEDIA_PROBED",
    provider,
    schemaFingerprint: spawned.initializeResult.schema.fingerprint,
    workspaceRootHash: hash(workspaceRoot),
    sessionIdHash: hash(sessionId),
    image: { mediaType: "image/png", width: 16, height: 16, byteCount: image.byteLength },
    video: {
      mediaType: "video/mp4",
      byteCount: video.byteLength,
      chunkCount: 1,
      uploadReceiptMatches: receiptMatches,
    },
    turnDisposition: ack.disposition,
    turnEvents,
    terminal: {
      method: terminal.method,
      kind: completed.terminal ?? null,
      usage: terminalUsage
        ? Object.fromEntries(Object.entries(terminalUsage).filter(([, count]) => typeof count === "number"))
        : null,
    },
    sessionUsage,
    audioPartInStableSchema: false,
    pdfPartInStableSchema: false,
    responseFormatInTurnStartSchema: false,
  });
} catch (error) {
  const failure = error as { name?: string; code?: number; kind?: string; retryable?: boolean };
  emit({
    status: "MSP_MEDIA_FAILED",
    stage,
    provider,
    failure: {
      name: failure.name ?? "Error",
      code: failure.code ?? null,
      kind: failure.kind ?? null,
      retryable: failure.retryable ?? null,
    },
  });
  process.exitCode = 1;
} finally {
  if (spawned !== undefined) await spawned.close();
  rmSync(fixtureDir, { recursive: true, force: true });
  if (process.env.MUSE_PROBE_KEEP_WORKSPACE !== "1" && process.env.MUSE_PROBE_WORKSPACE === undefined) {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
}
