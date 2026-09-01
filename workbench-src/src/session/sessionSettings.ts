import { get, set } from "idb-keyval";
import type { QualityPreset } from "../rtc/messages";
import type { PointerMode } from "../input/InputCapture";

// Per-computer session preferences. Deliberately local to the device rather than synced through
// Supabase: the right frame rate on a phone over cellular is not the right frame rate on a desktop
// over fibre, and syncing them would mean one device constantly undoing the other's choice.

export type ViewMode = "fit" | "actual" | "stretch";

export interface SessionSettings {
  viewMode: ViewMode;
  viewOnly: boolean;
  smoothScaling: boolean;
  autoFullscreen: boolean;
  pointerMode: PointerMode;
  preset: QualityPreset;
  fps: number;
  bitrateKbps: number;
  /** 100 = native resolution. Lower values re-encode at a smaller size before sending — cuts
   *  decode cost roughly with the square of the scale, which a bitrate/fps change alone can't
   *  touch. The fix for a weak/software H.264 decoder (a budget Chromebook's Intel GPU is the
   *  common case), not a bandwidth setting. */
  scalePercent: number;
  showStats: boolean;
  audioMuted: boolean;
}

export interface PresetSpec {
  id: Exclude<QualityPreset, "custom">;
  label: string;
  description: string;
  fps: number;
  bitrateKbps: number;
}

/** The three points on the fps/bitrate trade-off worth naming. "Custom" is whatever the sliders
 *  are set to and isn't listed here. */
export const PRESETS: PresetSpec[] = [
  {
    id: "smooth",
    label: "Smooth",
    description: "60 fps, softer image. Best for video, games and scrolling.",
    fps: 60,
    bitrateKbps: 12000,
  },
  {
    id: "balanced",
    label: "Balanced",
    description: "30 fps at a solid bitrate. The right default for most work.",
    fps: 30,
    bitrateKbps: 8000,
  },
  {
    id: "sharp",
    label: "Sharp",
    description: "15 fps, every bit spent on detail. Best for reading text on slow links.",
    fps: 15,
    bitrateKbps: 6000,
  },
];

const DEFAULTS: SessionSettings = {
  viewMode: "fit",
  viewOnly: false,
  smoothScaling: true,
  autoFullscreen: false,
  // Phones default to trackpad because a fingertip covers whatever it's aiming at; a mouse
  // doesn't, so pointer devices default to direct.
  pointerMode: matchesCoarsePointer() ? "trackpad" : "direct",
  preset: "balanced",
  fps: 30,
  bitrateKbps: 8000,
  scalePercent: 100,
  showStats: false,
  audioMuted: false,
};

function matchesCoarsePointer(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches === true;
}

const KEY_PREFIX = "poprd-session-settings-";

export async function getSessionSettings(hostId: string): Promise<SessionSettings> {
  try {
    const stored = await get<Partial<SessionSettings>>(KEY_PREFIX + hostId);
    return { ...DEFAULTS, ...stored };
  } catch {
    // Private browsing and some embedded webviews reject IndexedDB outright. Defaults are a fine
    // session; losing preferences is not a reason to refuse to connect.
    return { ...DEFAULTS };
  }
}

export async function saveSessionSettings(
  hostId: string,
  patch: Partial<SessionSettings>,
): Promise<SessionSettings> {
  const next = { ...(await getSessionSettings(hostId)), ...patch };
  try {
    await set(KEY_PREFIX + hostId, next);
  } catch {
    // As above — keep the in-memory value and carry on.
  }
  return next;
}
