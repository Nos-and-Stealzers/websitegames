import type { ClipboardMessage, ControlMessage, InputMessage } from "./messages";

// Signaling flows over a live WebSocket (see RemoteSession / SignalingClient), so this uses real
// trickle ICE — candidates sent and applied one at a time as they're discovered.

export type ConnectionState = "idle" | "negotiating" | "connected" | "disconnected" | "failed";

/** What the sideboard's Performance tab shows. Sampled from getStats() once a second. */
export interface SessionStats {
  fps: number;
  kbps: number;
  /** Round-trip time in ms on the selected candidate pair, or null before ICE settles. */
  rttMs: number | null;
  packetsLost: number;
  lossPct: number;
  width: number;
  height: number;
  codec: string;
  /** "relay" means the media is going through a TURN server rather than directly peer-to-peer. */
  transport: string;
  jitterMs: number;
  framesDropped: number;
}

export const EMPTY_STATS: SessionStats = {
  fps: 0,
  kbps: 0,
  rttMs: null,
  packetsLost: 0,
  lossPct: 0,
  width: 0,
  height: 0,
  codec: "—",
  transport: "—",
  jitterMs: 0,
  framesDropped: 0,
};

export class ClientPeerConnection {
  private pc: RTCPeerConnection;
  private inputChannel: RTCDataChannel | null = null;
  private clipboardChannel: RTCDataChannel | null = null;
  private controlChannel: RTCDataChannel | null = null;
  private statsTimer: number | null = null;
  private lastSample: { bytes: number; frames: number; at: number } | null = null;
  private queuedRemoteCandidates: RTCIceCandidateInit[] = [];
  private closed = false;

  onRemoteStream: ((stream: MediaStream) => void) | null = null;
  onInputChannelOpen: (() => void) | null = null;
  onStateChange: ((state: ConnectionState) => void) | null = null;
  onClipboardText: ((text: string) => void) | null = null;
  onControlMessage: ((msg: ControlMessage) => void) | null = null;
  onStats: ((stats: SessionStats) => void) | null = null;
  /** Fired for each locally-gathered ICE candidate — send it to the host immediately. */
  onLocalIceCandidate: ((candidate: RTCIceCandidate) => void) | null = null;

  constructor(iceServers: RTCIceServer[]) {
    this.pc = new RTCPeerConnection({ iceServers, bundlePolicy: "max-bundle" });

    this.pc.ontrack = (event) => {
      const [stream] = event.streams;
      if (stream) this.onRemoteStream?.(stream);
    };

    this.pc.ondatachannel = (event) => {
      const channel = event.channel;
      if (channel.label === "input") {
        this.inputChannel = channel;
        channel.onopen = () => this.onInputChannelOpen?.();
      } else if (channel.label === "clipboard") {
        this.clipboardChannel = channel;
        channel.onmessage = (e) => {
          const msg = tryParse<ClipboardMessage>(e.data);
          if (msg?.t === "clipboard-text") this.onClipboardText?.(msg.text);
        };
      } else if (channel.label === "control") {
        this.controlChannel = channel;
        channel.onmessage = (e) => {
          const msg = tryParse<ControlMessage>(e.data);
          if (msg) this.onControlMessage?.(msg);
        };
      }
    };

    this.pc.onicecandidate = (event) => {
      if (event.candidate) this.onLocalIceCandidate?.(event.candidate);
    };

    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      const mapped: ConnectionState =
        s === "connected"
          ? "connected"
          : s === "disconnected" || s === "closed"
            ? "disconnected"
            : s === "failed"
              ? "failed"
              : "negotiating";
      if (mapped === "connected") this.startStatsLoop();
      this.onStateChange?.(mapped);
    };
  }

  /** Sets the host's offer as remote description and produces an answer. Returns as soon as the
   *  answer is created — ICE candidates trickle in afterward via onLocalIceCandidate. */
  async createAnswerFromOffer(offerSdp: string): Promise<string> {
    this.onStateChange?.("negotiating");
    await this.pc.setRemoteDescription({ type: "offer", sdp: sanitizeSdp(offerSdp) });
    await this.flushQueuedRemoteCandidates();

    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);

    const local = this.pc.localDescription;
    if (!local) throw new Error("Local description missing after setLocalDescription");
    return local.sdp;
  }

  async addRemoteIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.pc.remoteDescription) {
      this.queuedRemoteCandidates.push(candidate);
      return;
    }

    try {
      await this.pc.addIceCandidate(candidate);
    } catch {
      // A candidate that arrives before setRemoteDescription, or one for a bundled transport the
      // browser has already discarded, throws here. Neither is fatal — the rest of the candidate
      // pairs still establish the connection — so this must not tear the session down.
      this.queuedRemoteCandidates.push(candidate);
    }
  }

  private async flushQueuedRemoteCandidates(): Promise<void> {
    if (!this.pc.remoteDescription) return;

    const pending = this.queuedRemoteCandidates.splice(0, this.queuedRemoteCandidates.length);
    for (const candidate of pending) {
      try {
        await this.pc.addIceCandidate(candidate);
      } catch {
        this.queuedRemoteCandidates.push(candidate);
      }
    }
  }

  sendInput(msg: InputMessage): void {
    if (this.inputChannel?.readyState === "open") this.inputChannel.send(JSON.stringify(msg));
  }

  sendClipboardText(text: string): void {
    if (this.clipboardChannel?.readyState === "open") {
      this.clipboardChannel.send(JSON.stringify({ t: "clipboard-text", text } satisfies ClipboardMessage));
    }
  }

  sendControl(msg: ControlMessage): void {
    if (this.controlChannel?.readyState === "open") this.controlChannel.send(JSON.stringify(msg));
  }

  /** Samples getStats() once a second and turns the raw report into the handful of numbers the
   *  sideboard actually shows. Rates (fps, kbps) are differences between consecutive samples —
   *  the report's own counters are cumulative totals since the connection opened. */
  private startStatsLoop(): void {
    if (this.statsTimer !== null) return;
    this.statsTimer = window.setInterval(() => {
      void this.sampleStats();
    }, 1000);
  }

  private async sampleStats(): Promise<void> {
    if (this.closed || !this.onStats) return;

    let report: RTCStatsReport;
    try {
      report = await this.pc.getStats();
    } catch {
      return;
    }

    const stats: SessionStats = { ...EMPTY_STATS };
    let inbound: Record<string, unknown> | null = null;
    let selectedPairId: string | null = null;
    const byId = new Map<string, Record<string, unknown>>();

    report.forEach((entry) => {
      const record = entry as unknown as Record<string, unknown>;
      byId.set(String(record.id), record);
      if (record.type === "inbound-rtp" && record.kind === "video") inbound = record;
      if (record.type === "transport" && typeof record.selectedCandidatePairId === "string") {
        selectedPairId = record.selectedCandidatePairId;
      }
      // Firefox reports no `transport.selectedCandidatePairId`; it flags the pair itself instead.
      if (record.type === "candidate-pair" && record.selected === true) selectedPairId = String(record.id);
      if (record.type === "candidate-pair" && record.state === "succeeded" && record.nominated === true) {
        selectedPairId ??= String(record.id);
      }
    });

    if (inbound) {
      const row = inbound as Record<string, unknown>;
      const bytes = Number(row.bytesReceived ?? 0);
      const frames = Number(row.framesDecoded ?? 0);
      const now = performance.now();

      if (this.lastSample) {
        const seconds = (now - this.lastSample.at) / 1000;
        if (seconds > 0.2) {
          stats.kbps = Math.max(0, Math.round(((bytes - this.lastSample.bytes) * 8) / 1000 / seconds));
          stats.fps = Math.max(0, Math.round((frames - this.lastSample.frames) / seconds));
        }
      }
      this.lastSample = { bytes, frames, at: now };

      stats.width = Number(row.frameWidth ?? 0);
      stats.height = Number(row.frameHeight ?? 0);
      stats.packetsLost = Number(row.packetsLost ?? 0);
      stats.jitterMs = Math.round(Number(row.jitter ?? 0) * 1000);
      stats.framesDropped = Number(row.framesDropped ?? 0);

      const received = Number(row.packetsReceived ?? 0);
      const total = received + stats.packetsLost;
      stats.lossPct = total > 0 ? Math.round((stats.packetsLost / total) * 1000) / 10 : 0;

      const codec = byId.get(String(row.codecId ?? ""));
      if (codec && typeof codec.mimeType === "string") stats.codec = codec.mimeType.replace("video/", "");
    }

    if (selectedPairId) {
      const pair = byId.get(selectedPairId);
      if (pair) {
        const rtt = Number(pair.currentRoundTripTime ?? NaN);
        if (Number.isFinite(rtt)) stats.rttMs = Math.round(rtt * 1000);
        const local = byId.get(String(pair.localCandidateId ?? ""));
        const remote = byId.get(String(pair.remoteCandidateId ?? ""));
        const localType = String(local?.candidateType ?? "");
        const remoteType = String(remote?.candidateType ?? "");
        stats.transport =
          localType === "relay" || remoteType === "relay"
            ? "relayed (TURN)"
            : localType === "host" && remoteType === "host"
              ? "direct (local)"
              : "direct (P2P)";
      }
    }

    this.onStats(stats);
  }

  close(): void {
    this.closed = true;
    this.queuedRemoteCandidates = [];
    if (this.statsTimer !== null) {
      window.clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    this.inputChannel?.close();
    this.clipboardChannel?.close();
    this.controlChannel?.close();
    this.pc.close();
  }
}

function tryParse<T>(data: unknown): T | null {
  try {
    return JSON.parse(String(data)) as T;
  } catch {
    return null;
  }
}

/** Turns a transmitted SDP blob into the exact shape RFC 4566 expects: CRLF line endings, no
 *  blank lines. Cheap insurance against any transport that mangles line endings. */
function sanitizeSdp(raw: string): string {
  return (
    raw
      .split(/\r\n|\r|\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join("\r\n") + "\r\n"
  );
}
