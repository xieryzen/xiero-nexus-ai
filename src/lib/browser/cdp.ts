import "server-only";
import WebSocket from "ws";

/**
 * The connection to the browser: the DevTools protocol over one WebSocket.
 * Every page the app has open speaks over it, each under its own session.
 * Only what the app needs of the protocol is here.
 */

/** The browser answered a command with an error, or did not answer. */
export class CdpError extends Error {
  constructor(
    message: string,
    readonly method: string,
    /** The connection is gone: nothing more can be asked over it. */
    readonly gone = false,
  ) {
    super(message);
    this.name = "CdpError";
  }
}

type Params = Record<string, unknown>;
type Listener = (params: Params, sessionId: string | undefined) => void;

interface Pending {
  method: string;
  resolve: (result: Params) => void;
  reject: (err: CdpError) => void;
  timer: ReturnType<typeof setTimeout>;
}

const COMMAND_TIMEOUT_MS = 30_000;

export class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly closers = new Set<() => void>();
  closed = false;

  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (data) => this.receive(data.toString()));
    socket.on("close", () => this.ended());
    socket.on("error", () => this.ended());
  }

  /** Connect to the browser's DevTools address (ws:// or wss://). */
  static connect(address: string, timeoutMs = 10_000): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      let settled = false;
      // Messages can be large (a picture of a page); nothing is compressed on a connection this short.
      const socket = new WebSocket(address, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024, handshakeTimeout: timeoutMs });
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        try {
          socket.terminate();
        } catch {
          // Not open yet.
        }
        reject(new CdpError(message, "connect", true));
      };
      socket.once("open", () => {
        if (settled) return;
        settled = true;
        resolve(new CdpConnection(socket));
      });
      socket.once("unexpected-response", (_req, res) => fail(`the browser service answered ${res.statusCode}`));
      socket.once("error", (err) => fail(err.message));
    });
  }

  private receive(text: string): void {
    let message: { id?: number; result?: Params; error?: { message?: string }; method?: string; params?: Params; sessionId?: string };
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof message.id === "number") {
      const waiting = this.pending.get(message.id);
      if (!waiting) return;
      this.pending.delete(message.id);
      clearTimeout(waiting.timer);
      if (message.error) waiting.reject(new CdpError(message.error.message ?? "the browser refused", waiting.method));
      else waiting.resolve(message.result ?? {});
      return;
    }
    if (!message.method) return;
    for (const key of [`${message.sessionId ?? ""}|${message.method}`, `*|${message.method}`]) {
      const set = this.listeners.get(key);
      if (!set) continue;
      for (const listener of [...set]) {
        try {
          listener(message.params ?? {}, message.sessionId);
        } catch {
          // A listener's own trouble does not stop the others.
        }
      }
    }
  }

  private ended(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, waiting] of this.pending) {
      clearTimeout(waiting.timer);
      waiting.reject(new CdpError("the connection to the browser was lost", waiting.method, true));
    }
    this.pending.clear();
    for (const tell of [...this.closers]) {
      try {
        tell();
      } catch {
        // As above.
      }
    }
    this.closers.clear();
    this.listeners.clear();
  }

  /** Ask the browser to do something, and get what it answers. */
  send<T = Params>(method: string, params: Params = {}, sessionId?: string, timeoutMs = COMMAND_TIMEOUT_MS): Promise<T> {
    if (this.closed) return Promise.reject(new CdpError("the connection to the browser was lost", method, true));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`the browser did not answer within ${Math.round(timeoutMs / 1000)} s`, method));
      }, timeoutMs);
      this.pending.set(id, { method, resolve: resolve as (result: Params) => void, reject, timer });
      try {
        this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new CdpError(err instanceof Error ? err.message : String(err), method, true));
      }
    });
  }

  /** Hear an event: of one session, of the browser itself (no session), or of every session ("*"). Returns how to stop. */
  on(method: string, sessionId: string | undefined | "*", listener: Listener): () => void {
    const key = `${sessionId ?? ""}|${method}`;
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(key);
    };
  }

  /** Called once when the connection is gone. */
  onClose(tell: () => void): () => void {
    if (this.closed) {
      tell();
      return () => undefined;
    }
    this.closers.add(tell);
    return () => this.closers.delete(tell);
  }

  /** Forget every listener of a session that has ended. */
  forget(sessionId: string): void {
    for (const key of [...this.listeners.keys()]) {
      if (key.startsWith(`${sessionId}|`)) this.listeners.delete(key);
    }
  }

  close(): void {
    try {
      this.socket.close();
    } catch {
      // Closed already.
    }
    this.ended();
  }
}
