import type { DuplexTransport } from "@muse-code/sdk";

export interface FakeRpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export type FakeRpcHandler = (request: FakeRpcRequest) => Promise<Record<string, unknown>> | Record<string, unknown>;

class AsyncQueue<T> implements AsyncIterable<T>, AsyncIterator<T> {
  private readonly values: T[] = [];
  private readonly readers: Array<(value: IteratorResult<T>) => void> = [];
  private ended = false;

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this;
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ value, done: false });
    if (this.ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.readers.push(resolve));
  }

  push(value: T): void {
    const reader = this.readers.shift();
    if (reader) reader({ value, done: false });
    else if (!this.ended) this.values.push(value);
  }

  end(): void {
    this.ended = true;
    for (const reader of this.readers.splice(0)) reader({ value: undefined, done: true });
  }
}

export class FakeMspTransport implements DuplexTransport {
  private readonly incomingQueue = new AsyncQueue<string>();
  private readonly requestWaiters: Array<{
    predicate: (request: FakeRpcRequest) => boolean;
    resolve: (request: FakeRpcRequest) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  readonly incoming = this.incomingQueue;
  readonly requests: FakeRpcRequest[] = [];
  private closed = false;

  constructor(private readonly handler: FakeRpcHandler = () => ({})) {}

  async write(chunk: string): Promise<void> {
    for (const line of chunk.split("\n").filter(Boolean)) {
      let request: FakeRpcRequest;
      try {
        request = JSON.parse(line) as FakeRpcRequest;
      } catch {
        continue;
      }
      this.requests.push(request);
      for (const waiter of [...this.requestWaiters]) {
        if (!waiter.predicate(request)) continue;
        clearTimeout(waiter.timer);
        this.requestWaiters.splice(this.requestWaiters.indexOf(waiter), 1);
        waiter.resolve(request);
      }
      if (request.id === undefined) continue;
      void this.respond(request);
    }
  }

  private async respond(request: FakeRpcRequest): Promise<void> {
    try {
      const result = await this.handler(request);
      this.deliver({ jsonrpc: "2.0", id: request.id, result });
    } catch (error) {
      this.deliver({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32603, message: error instanceof Error ? error.message : "fake error" },
      });
    }
  }

  deliver(frame: unknown): void {
    if (!this.closed) this.incomingQueue.push(`${JSON.stringify(frame)}\n`);
  }

  deliverRaw(frame: string): void {
    if (!this.closed) this.incomingQueue.push(`${frame}\n`);
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.deliver({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
  }

  async waitForRequest(predicate: (request: FakeRpcRequest) => boolean, timeoutMs = 1_000): Promise<FakeRpcRequest> {
    const existing = this.requests.find(predicate);
    if (existing) return existing;
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        timer: setTimeout(() => {
          const index = this.requestWaiters.indexOf(waiter);
          if (index >= 0) this.requestWaiters.splice(index, 1);
          reject(new Error("Timed out waiting for fake MSP request"));
        }, timeoutMs),
      };
      this.requestWaiters.push(waiter);
    });
  }

  close(flushed?: Promise<void>): Promise<void> {
    return Promise.resolve(flushed).finally(() => {
      this.closed = true;
      this.incomingQueue.end();
    });
  }
}
