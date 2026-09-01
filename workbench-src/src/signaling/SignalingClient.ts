import type { SignalingMessage } from "../rtc/messages";

/** Thin JSON-over-WebSocket transport to the Worker's per-host Durable Object — see
 *  /signaling/src/HostSession.ts for the server side. This only connects and shuttles JSON;
 *  RemoteSession interprets what arrives. */
export class SignalingClient {
  private socket: WebSocket;
  /** Frames handed to send() before the socket finished opening. Without this, the very first
   *  message — the account-auth that every session starts with — races the open handshake and
   *  throws "still in CONNECTING state" on a fast reconnect. */
  private queue: string[] = [];

  onMessage: ((msg: SignalingMessage) => void) | null = null;
  onOpen: (() => void) | null = null;
  onClose: ((event: CloseEvent) => void) | null = null;

  constructor(workerBaseUrl: string, hostId: string) {
    const url = new URL(workerBaseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/ws";
    url.search = `?hostId=${encodeURIComponent(hostId)}&role=client`;

    this.socket = new WebSocket(url.toString());
    this.socket.onopen = () => {
      for (const frame of this.queue) this.socket.send(frame);
      this.queue = [];
      this.onOpen?.();
    };
    this.socket.onerror = (event) => {
      console.error("Signaling socket error", event);
    };
    this.socket.onclose = (event) => this.onClose?.(event);
    this.socket.onmessage = (event) => {
      try {
        this.onMessage?.(JSON.parse(event.data) as SignalingMessage);
      } catch {
        // Ignore malformed frames rather than killing the connection over one bad line.
      }
    };
  }

  send(msg: SignalingMessage): void {
    const frame = JSON.stringify(msg);
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(frame);
    else if (this.socket.readyState === WebSocket.CONNECTING) this.queue.push(frame);
  }

  close(): void {
    this.socket.close();
  }
}
