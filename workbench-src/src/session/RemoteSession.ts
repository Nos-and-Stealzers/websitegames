import { SignalingClient } from "../signaling/SignalingClient";
import { ClientPeerConnection, type SessionStats } from "../rtc/PeerConnection";
import { getAccessToken } from "../auth/AuthProvider";
import { fetchIceServers } from "./iceServers";
import { sha256Hex } from "../lib/crypto";
import type { ControlMessage, SignalingMessage } from "../rtc/messages";

export type SessionState =
  | "connecting"
  | "authorizing"
  | "waiting-for-host"
  | "negotiating"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "denied"
  | "offline"
  | "error";

/** Client-side mirror of the host's session handler: drives the signaling handshake, then a
 *  ClientPeerConnection once the relay confirms this account is allowed on this computer.
 *
 *  Unlike the pairing-code flow this replaces, there is no interactive step in the middle. Either
 *  the account has access — in which case the whole thing completes without asking anything — or
 *  it doesn't, and the answer is to have the owner share it from their dashboard. */
export class RemoteSession {
  private signaling: SignalingClient | null = null;
  private pc: ClientPeerConnection | null = null;
  private readonly workerUrl: string;
  private readonly hostId: string;
  /** Only set for a Connect-by-ID attempt using a PIN instead of a standing share — see
   *  0003_pin_access.sql. Hashed before it ever leaves this class; the plaintext PIN itself is
   *  never sent anywhere. */
  private readonly pin: string | undefined;
  /** Terminal states set this so a socket closing a moment later doesn't overwrite a specific,
   *  useful message ("you don't have access to this computer") with a generic one. */
  private settled = false;
  private closedByUser = false;
  private authTimer: number | null = null;

  onStateChange: ((state: SessionState, detail?: string) => void) | null = null;
  onRemoteStream: ((stream: MediaStream) => void) | null = null;
  onReady: ((pc: ClientPeerConnection) => void) | null = null;
  onClipboardText: ((text: string) => void) | null = null;
  onControlMessage: ((msg: ControlMessage) => void) | null = null;
  onStats: ((stats: SessionStats) => void) | null = null;

  constructor(workerBaseUrl: string, hostId: string, pin?: string) {
    this.workerUrl = workerBaseUrl;
    this.hostId = hostId;
    this.pin = pin;
  }

  /** Kept separate from the constructor so callers can attach their handlers first — otherwise
   *  the initial state change fires into a set of null callbacks and the UI never leaves idle. */
  start(): void {
    this.onStateChange?.("connecting");
    this.clearAuthTimer();

    const signaling = new SignalingClient(this.workerUrl, this.hostId);
    this.signaling = signaling;

    signaling.onOpen = () => void this.authorize();
    signaling.onMessage = (msg) => void this.handleMessage(msg);
    signaling.onClose = () => {
      if (this.settled || this.closedByUser) return;
      // Losing signaling after the peer connection is up is harmless — media flows directly and
      // no further handshake is needed — so only report it if we never got that far.
      if (!this.pc) this.onStateChange?.("error", "Lost the connection to the signaling service.");
    };
  }

  close(): void {
    this.closedByUser = true;
    this.clearAuthTimer();
    this.pc?.close();
    this.pc = null;
    this.signaling?.close();
    this.signaling = null;
  }

  sendClipboardText(text: string): void {
    this.pc?.sendClipboardText(text);
  }

  sendControl(msg: ControlMessage): void {
    this.pc?.sendControl(msg);
  }

  private async authorize(): Promise<void> {
    this.onStateChange?.("authorizing");
    this.startAuthTimer();

    const accessToken = await getAccessToken();
    if (!accessToken) {
      this.settled = true;
      this.clearAuthTimer();
      this.onStateChange?.("error", "Your sign-in expired. Sign in again and retry.");
      return;
    }
    const pinHash = this.pin ? await sha256Hex(this.pin) : undefined;
    this.signaling?.send({ t: "account-auth", accessToken, pinHash });
  }

  private startAuthTimer(): void {
    this.clearAuthTimer();
    this.authTimer = window.setTimeout(() => {
      if (this.settled || this.closedByUser || this.pc) return;
      this.settled = true;
      this.signaling?.close();
      this.onStateChange?.("error", "The signaling service didn’t answer in time. Check your internet connection and try again.");
    }, 20000);
  }

  private clearAuthTimer(): void {
    if (this.authTimer !== null) {
      window.clearTimeout(this.authTimer);
      this.authTimer = null;
    }
  }

  private async handleMessage(msg: SignalingMessage): Promise<void> {
    switch (msg.t) {
      case "auth-response":
        this.clearAuthTimer();
        if (msg.accept) {
          this.onStateChange?.("waiting-for-host");
        } else {
          this.settled = true;
          if (msg.reason === "host-offline") {
            this.onStateChange?.("offline", "That computer isn't online right now.");
          } else if (msg.reason === "no-access") {
            this.onStateChange?.(
              "denied",
              "Your account doesn't have access to this computer. Ask its owner to share it with your username, or for its connect PIN.",
            );
          } else if (msg.reason === "wrong-pin") {
            this.onStateChange?.("denied", "That PIN is incorrect.");
          } else if (msg.reason === "pin-locked") {
            this.onStateChange?.("denied", "Too many incorrect PIN attempts. Try again in a few minutes.");
          } else {
            this.onStateChange?.("denied", "Your sign-in couldn't be verified. Try signing out and back in.");
          }
        }
        break;
      case "offer":
        await this.handleOffer(msg.sdp);
        break;
      case "ice-candidate":
        await this.pc?.addRemoteIceCandidate(msg.candidate);
        break;
      case "error":
        this.settled = true;
        this.onStateChange?.("error", msg.message);
        break;
    }
  }

  private async handleOffer(offerSdp: string): Promise<void> {
    this.onStateChange?.("negotiating");
    this.clearAuthTimer();

    const pc = new ClientPeerConnection(await fetchIceServers(this.workerUrl));
    this.pc = pc;

    pc.onStateChange = (s) => {
      if (this.closedByUser) return;
      if (s === "connected") this.onStateChange?.("connected");
      // "disconnected" is often transient — a Wi-Fi handoff, a phone changing towers — and ICE
      // recovers on its own within a few seconds. Only "failed" is final.
      else if (s === "disconnected") this.onStateChange?.("reconnecting");
      else if (s === "failed") this.onStateChange?.("disconnected", "The connection dropped.");
    };
    pc.onRemoteStream = (stream) => this.onRemoteStream?.(stream);
    pc.onInputChannelOpen = () => this.onReady?.(pc);
    pc.onClipboardText = (text) => this.onClipboardText?.(text);
    pc.onControlMessage = (msg) => this.onControlMessage?.(msg);
    pc.onStats = (stats) => this.onStats?.(stats);
    pc.onLocalIceCandidate = (candidate) => {
      this.signaling?.send({ t: "ice-candidate", candidate: candidate.toJSON() });
    };

    const answerSdp = await pc.createAnswerFromOffer(offerSdp);
    this.signaling?.send({ t: "answer", sdp: answerSdp });
  }
}
