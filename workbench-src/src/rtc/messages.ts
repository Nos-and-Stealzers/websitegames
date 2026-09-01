// Local copy of the shared message contract — see /shared/types/messages.ts for the canonical
// definition, the trust model, and the cross-project sync note.

export type InputMessage =
  | { t: "mousemove"; x: number; y: number }
  | { t: "mousemovedelta"; dx: number; dy: number }
  | { t: "mousedown"; button: number }
  | { t: "mouseup"; button: number }
  | { t: "wheel"; dx: number; dy: number }
  | { t: "keydown"; code: string }
  | { t: "keyup"; code: string }
  | { t: "text"; text: string }
  | { t: "ctrl-alt-del" }
  | { t: "prtscr" };

export type ClipboardMessage = { t: "clipboard-text"; text: string };

export interface MonitorInfo {
  index: number;
  width: number;
  height: number;
  primary: boolean;
  label: string;
}

export type QualityPreset = "smooth" | "balanced" | "sharp" | "custom";

export type ControlMessage =
  | {
      t: "host-info";
      monitors: MonitorInfo[];
      activeMonitor: number;
      fps: number;
      bitrateKbps: number;
      preset: QualityPreset;
      hostName: string;
      appVersion: string;
    }
  | {
      t: "host-stats";
      capturedFps: number;
      encodedFps: number;
      encodeMs: number;
      droppedFrames: number;
    }
  | { t: "set-quality"; fps: number; bitrateKbps: number; preset: QualityPreset; scalePercent: number }
  | { t: "set-monitor"; index: number }
  | { t: "request-keyframe" }
  | { t: "display-changed"; width: number; height: number; monitor: number };

export type SignalingMessage =
  | { t: "account-auth"; accessToken: string; pinHash?: string }
  | { t: "auth-response"; accept: boolean; reason?: string; computer?: { hostId: string; name: string } }
  | { t: "client-authorized"; account: { id: string; username: string; displayName: string } }
  | { t: "error"; message: string }
  | { t: "offer"; sdp: string }
  | { t: "answer"; sdp: string }
  | { t: "ice-candidate"; candidate: RTCIceCandidateInit }
  | { t: "heartbeat" }
  | { t: "host-hello"; screenWidth: number; screenHeight: number; monitorCount: number; appVersion: string };
