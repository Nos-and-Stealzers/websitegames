import { useState } from "react";
import type { ControlMessage, MonitorInfo } from "../rtc/messages";
import type { SessionSettings } from "./sessionSettings";
import { PRESETS } from "./sessionSettings";
import type { PointerMode } from "../input/InputCapture";
import type { SessionStats } from "../rtc/PeerConnection";
import { Icon } from "../ui/Icon";

type Tab = "display" | "input" | "performance";

/** The in-session control surface — Chrome Remote Desktop calls this the "gear" panel; here it's
 *  a permanent sideboard on desktop and a slide-up sheet on narrow screens (see .sideboard's
 *  responsive rules in App.css) since a phone has no room to dock a 300px panel beside the video
 *  without eating half the remote screen. */
export function Sideboard({
  settings,
  onSettingsChange,
  hostInfo,
  hostStats,
  stats,
  pointerMode,
  onPointerModeChange,
  onSendControl,
  onCtrlAltDel,
  onPrintScreen,
  onSendClipboard,
  keyboardActive,
  onToggleKeyboard,
  onOpenTextInput,
  gameMode,
  onToggleGameMode,
  onClose,
}: {
  settings: SessionSettings;
  onSettingsChange: <K extends keyof SessionSettings>(key: K, value: SessionSettings[K]) => void;
  hostInfo: Extract<ControlMessage, { t: "host-info" }> | null;
  hostStats: Extract<ControlMessage, { t: "host-stats" }> | null;
  stats: SessionStats;
  pointerMode: PointerMode;
  onPointerModeChange: (mode: PointerMode) => void;
  onSendControl: (msg: ControlMessage) => void;
  onCtrlAltDel: () => void;
  onPrintScreen: () => void;
  onSendClipboard: () => void;
  keyboardActive: boolean;
  onToggleKeyboard: () => void;
  onOpenTextInput: () => void;
  gameMode: boolean;
  onToggleGameMode: () => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("display");

  const applyPreset = (preset: (typeof PRESETS)[number]) => {
    onSettingsChange("preset", preset.id);
    onSettingsChange("fps", preset.fps);
    onSettingsChange("bitrateKbps", preset.bitrateKbps);
    onSendControl({
      t: "set-quality",
      fps: preset.fps,
      bitrateKbps: preset.bitrateKbps,
      preset: preset.id,
      scalePercent: settings.scalePercent,
    });
  };

  const applyCustom = (fps: number, bitrateKbps: number) => {
    onSettingsChange("preset", "custom");
    onSettingsChange("fps", fps);
    onSettingsChange("bitrateKbps", bitrateKbps);
    onSendControl({ t: "set-quality", fps, bitrateKbps, preset: "custom", scalePercent: settings.scalePercent });
  };

  const applyScale = (scalePercent: number) => {
    onSettingsChange("scalePercent", scalePercent);
    onSendControl({
      t: "set-quality",
      fps: settings.fps,
      bitrateKbps: settings.bitrateKbps,
      preset: settings.preset,
      scalePercent,
    });
  };

  const selectMonitor = (index: number) => {
    onSendControl({ t: "set-monitor", index });
  };

  return (
    <div className="sideboard">
      <div className="sideboard-header">
        <h3>Session settings</h3>
        <button className="icon-btn" onClick={onClose} aria-label="Close">
          <Icon name="x" size={16} />
        </button>
      </div>

      <div className="sideboard-tabs">
        <TabButton icon="sliders" label="Display" active={tab === "display"} onClick={() => setTab("display")} />
        <TabButton icon="keyboard" label="Input" active={tab === "input"} onClick={() => setTab("input")} />
        <TabButton icon="gauge" label="Stats" active={tab === "performance"} onClick={() => setTab("performance")} />
      </div>

      <div className="sideboard-content">
        {tab === "display" && (
          <>
            <Section title="Screen size">
              <SegmentedControl
                value={settings.viewMode}
                onChange={(v) => onSettingsChange("viewMode", v)}
                options={[
                  { value: "fit", label: "Fit" },
                  { value: "actual", label: "Actual" },
                  { value: "stretch", label: "Stretch" },
                ]}
              />
            </Section>

            {hostInfo && hostInfo.monitors.length > 1 && (
              <Section title="Monitor">
                <div className="monitor-list">
                  {hostInfo.monitors.map((m) => (
                    <MonitorButton
                      key={m.index}
                      monitor={m}
                      active={m.index === hostInfo.activeMonitor}
                      onClick={() => selectMonitor(m.index)}
                    />
                  ))}
                </div>
              </Section>
            )}

            <Section title="Quality">
              <div className="preset-list">
                {PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    className={`preset-card ${settings.preset === preset.id ? "preset-card-active" : ""}`}
                    onClick={() => applyPreset(preset)}
                  >
                    <span className="preset-card-label">{preset.label}</span>
                    <span className="preset-card-desc">{preset.description}</span>
                  </button>
                ))}
              </div>

              <div className="quality-sliders">
                <SliderRow
                  label="Frame rate"
                  value={settings.fps}
                  min={10}
                  max={60}
                  step={5}
                  unit=" fps"
                  onChange={(fps) => applyCustom(fps, settings.bitrateKbps)}
                />
                <SliderRow
                  label="Bitrate"
                  value={settings.bitrateKbps}
                  min={1000}
                  max={20000}
                  step={500}
                  unit=" kbps"
                  onChange={(bitrateKbps) => applyCustom(settings.fps, bitrateKbps)}
                />
              </div>
            </Section>

            <Section title="Resolution">
              <SegmentedControl
                value={String(settings.scalePercent)}
                onChange={(v) => applyScale(Number(v))}
                options={[
                  { value: "100", label: "Full" },
                  { value: "75", label: "75%" },
                  { value: "50", label: "Half" },
                ]}
              />
              <p className="sideboard-hint">
                Lower resolutions decode much more easily on weaker devices — a Chromebook or
                older phone struggling to keep up is what this is for, not a bandwidth setting.
              </p>
            </Section>

            <Section title="Rendering">
              <ToggleRow
                label="Smooth scaling"
                checked={settings.smoothScaling}
                onChange={(v) => onSettingsChange("smoothScaling", v)}
              />
              <ToggleRow
                label="Full screen on connect"
                checked={settings.autoFullscreen}
                onChange={(v) => onSettingsChange("autoFullscreen", v)}
              />
            </Section>

            <Section title="Audio">
              <ToggleRow
                label="Mute host audio"
                checked={settings.audioMuted}
                onChange={(v) => onSettingsChange("audioMuted", v)}
              />
            </Section>
          </>
        )}

        {tab === "input" && (
          <>
            <Section title="View only">
              <ToggleRow
                label="Block input to host"
                checked={settings.viewOnly}
                onChange={(v) => onSettingsChange("viewOnly", v)}
              />
            </Section>

            <Section title="Pointer" hidden={settings.viewOnly}>
              <SegmentedControl
                value={pointerMode}
                onChange={onPointerModeChange}
                options={[
                  { value: "direct", label: "Direct touch" },
                  { value: "trackpad", label: "Trackpad" },
                ]}
              />
              <p className="sideboard-hint">
                {pointerMode === "direct"
                  ? "Your finger is the cursor — best for tapping."
                  : "The screen acts like a trackpad — best for precision."}
              </p>
            </Section>

            <Section title="Game mode" hidden={settings.viewOnly}>
              <button
                className={`btn btn-secondary btn-block ${gameMode ? "btn-toggle-active" : ""}`}
                onClick={onToggleGameMode}
              >
                <Icon name="mouse" size={15} />
                {gameMode ? "Game mode on — click to exit" : "Turn on game mode"}
              </button>
              <p className="sideboard-hint">
                Locks and hides your cursor so the host sees raw mouse movement instead of a
                position — most games need this for looking/aiming to work at all. Press{" "}
                <strong>Esc</strong> to exit, or <strong>Ctrl+Alt+Shift+O</strong> to bring this
                panel back up without leaving game mode.
              </p>
            </Section>

            <Section title="Keyboard" hidden={settings.viewOnly}>
              <button
                className={`btn btn-secondary btn-block ${keyboardActive ? "btn-toggle-active" : ""}`}
                onClick={onToggleKeyboard}
              >
                <Icon name="keyboard" size={15} />
                {keyboardActive ? "Physical keyboard captured" : "Capture physical keyboard"}
              </button>
              <button className="btn btn-secondary btn-block" onClick={onOpenTextInput}>
                <Icon name="pencil" size={15} />
                Type with on-screen keyboard
              </button>
            </Section>

            <Section title="System keys" hidden={settings.viewOnly}>
              <div className="key-action-row">
                <button className="btn btn-secondary" onClick={onCtrlAltDel}>
                  Ctrl+Alt+Del
                </button>
                <button className="btn btn-secondary" onClick={onPrintScreen}>
                  Print Screen
                </button>
              </div>
            </Section>

            <Section title="Clipboard">
              <button className="btn btn-secondary btn-block" onClick={onSendClipboard}>
                <Icon name="clipboard" size={15} />
                Send clipboard to host
              </button>
            </Section>
          </>
        )}

        {tab === "performance" && (
          <PerformancePanel stats={stats} hostStats={hostStats} settings={settings} onSettingsChange={onSettingsChange} />
        )}
      </div>
    </div>
  );
}

function PerformancePanel({
  stats,
  hostStats,
  settings,
  onSettingsChange,
}: {
  stats: SessionStats;
  hostStats: Extract<ControlMessage, { t: "host-stats" }> | null;
  settings: SessionSettings;
  onSettingsChange: <K extends keyof SessionSettings>(key: K, value: SessionSettings[K]) => void;
}) {
  return (
    <>
      <Section title="Live stats">
        <div className="stat-grid">
          <StatTile label="Frame rate" value={`${stats.fps}`} unit="fps" />
          <StatTile label="Bitrate" value={`${(stats.kbps / 1000).toFixed(1)}`} unit="Mbps" />
          <StatTile label="Round trip" value={stats.rttMs !== null ? `${stats.rttMs}` : "—"} unit="ms" />
          <StatTile label="Packet loss" value={`${stats.lossPct}`} unit="%" warn={stats.lossPct > 2} />
          <StatTile label="Resolution" value={stats.width && stats.height ? `${stats.width}×${stats.height}` : "—"} unit="" />
          <StatTile label="Codec" value={stats.codec} unit="" />
        </div>
        <p className={`transport-line ${stats.transport.startsWith("relayed") ? "transport-line-warn" : ""}`}>
          <Icon name="wifi" size={14} />
          {stats.transport}
        </p>
      </Section>
      {hostStats && (
        <Section title="Host side">
          <div className="stat-grid">
            <StatTile label="Captured" value={`${hostStats.capturedFps}`} unit="fps" />
            <StatTile label="Encoded" value={`${hostStats.encodedFps}`} unit="fps" />
            <StatTile label="Encode time" value={`${hostStats.encodeMs}`} unit="ms" warn={hostStats.encodeMs > 15} />
            <StatTile label="Dropped" value={`${hostStats.droppedFrames}`} unit="" warn={hostStats.droppedFrames > 0} />
          </div>
          <p className="sideboard-hint">
            "Captured" is how often the host's screen actually changed. If that's low but you
            expect steady on-screen motion, something on the host is the bottleneck, not the
            network. High encode time points at the encoder/CPU; a low captured rate with 0ms
            encode time just means the screen was genuinely idle.
          </p>
        </Section>
      )}
      <Section title="Overlay">
        <ToggleRow
          label="Show stats over video"
          checked={settings.showStats}
          onChange={(v) => onSettingsChange("showStats", v)}
        />
      </Section>
    </>
  );
}

function TabButton({ icon, label, active, onClick }: { icon: "sliders" | "keyboard" | "gauge"; label: string; active: boolean; onClick: () => void }) {
  return (
    <button className={`sideboard-tab ${active ? "sideboard-tab-active" : ""}`} onClick={onClick}>
      <Icon name={icon} size={16} />
      {label}
    </button>
  );
}

function Section({ title, hidden, children }: { title: string; hidden?: boolean; children: React.ReactNode }) {
  if (hidden) return null;
  return (
    <section className="sideboard-section">
      <h4>{title}</h4>
      {children}
    </section>
  );
}

function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="segmented">
      {options.map((opt) => (
        <button
          key={opt.value}
          className={`segmented-btn ${value === opt.value ? "segmented-btn-active" : ""}`}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  const id = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "toggle-setting";
  return (
    <label className="settings-row settings-row-toggle" htmlFor={id}>
      <span className="settings-label">{label}</span>
      <input
        id={id}
        name={id}
        type="checkbox"
        className="switch"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  onChange: (v: number) => void;
}) {
  const id = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "slider-setting";
  return (
    <div className="slider-row">
      <div className="slider-row-head">
        <span>{label}</span>
        <span className="slider-value">
          {value}
          {unit}
        </span>
      </div>
      <input
        id={id}
        name={id}
        type="range"
        className="slider"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

function MonitorButton({ monitor, active, onClick }: { monitor: MonitorInfo; active: boolean; onClick: () => void }) {
  return (
    <button className={`monitor-btn ${active ? "monitor-btn-active" : ""}`} onClick={onClick}>
      <span className="monitor-btn-icon">
        <Icon name="monitor" size={16} />
      </span>
      <span className="monitor-btn-label">
        {monitor.label}
        <span className="monitor-btn-res">
          {monitor.width}×{monitor.height}
          {monitor.primary ? " · Primary" : ""}
        </span>
      </span>
    </button>
  );
}

function StatTile({ label, value, unit, warn }: { label: string; value: string; unit: string; warn?: boolean }) {
  return (
    <div className={`stat-tile ${warn ? "stat-tile-warn" : ""}`}>
      <span className="stat-tile-label">{label}</span>
      <span className="stat-tile-value">
        {value}
        {unit && <span className="stat-tile-unit">{unit}</span>}
      </span>
    </div>
  );
}
