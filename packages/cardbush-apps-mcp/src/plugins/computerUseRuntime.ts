import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';

import type { ComputerUsePluginConfig } from '../config.js';
import { computerUsePresentation } from './computerUsePresentation.js';

export interface ComputerUseArtifact {
  artifact_id: string;
  type: string;
  path: string;
  media_type: string;
  display: 'inline' | 'attachment' | 'hidden';
  metadata: Record<string, unknown>;
}

const execFileAsync = promisify(execFile);

export interface ComputerUseResult {
  output: unknown;
  paths: string[];
  artifacts: ComputerUseArtifact[];
}

type ComputerUseWindowBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type ComputerUseObservedElement = {
  index: number;
  runtimeId: string;
  name: string;
  automationId: string;
  controlType: string;
  className: string;
  enabled: boolean;
  focused: boolean;
  offscreen: boolean;
  password: boolean;
  bounds?: ComputerUseWindowBounds;
  patterns: string[];
  value?: string;
  state?: string;
  readOnly?: boolean;
};

export type ComputerUseObservationBinding = {
  stateId: string;
  generation: number;
  createdAt: number;
  hwnd: number;
  processId?: number;
  processName: string;
  title: string;
  bounds: ComputerUseWindowBounds;
  elements: ComputerUseObservedElement[];
};

type ComputerUseSafetyState = {
  busy: boolean;
  touchedAt: number;
  actionsSinceObservation: number;
  lastActionFingerprint: string;
  repeatedActionCount: number;
  lastObservationFingerprint: string;
  unchangedActionCycles: number;
  actionSinceObservation: boolean;
  observationsWithoutAction: number;
  mustObserveAfterYield: boolean;
  userYieldCount: number;
  expectedInputTick?: number;
  observation?: ComputerUseObservationBinding;
  lastObservationSemanticFingerprint: string;
};

const maxActionsWithoutObservation = 3;
const maxRepeatedActionAttempts = 2;
const maxUserYields = 2;
const maxPassiveObservations = 3;
const safetyStateTtlMs = 20 * 60_000;
const observationStateTtlMs = 30_000;

/** Session-scoped coordination for physical desktop input. */
export class ComputerUseSafetyGuard {
  readonly #states = new Map<string, ComputerUseSafetyState>();
  #activeScope = '';
  #desktopGeneration = 0;

  begin(scopeId: string, input: Record<string, unknown>): () => void {
    if (!scopeId) return () => undefined;
    this.#cleanup();
    const state = this.#state(scopeId);
    if (this.#activeScope || state.busy) {
      throw new Error('Another Computer Use action is already using the desktop. Wait for it to finish, then observe before continuing.');
    }
    const action = String(input.action ?? '').trim();
    if (isObservationAction(action)) {
      if (state.observationsWithoutAction >= maxPassiveObservations) {
        throw new Error('Computer Use stopped a repeated observation loop. The desktop is not progressing; wait for a new user request or use another route.');
      }
    } else {
      if (state.mustObserveAfterYield) {
        throw new Error('Computer Use yielded to user input. Call observe before attempting another desktop action.');
      }
      if (state.userYieldCount >= maxUserYields) {
        throw new Error('Computer Use yielded to the user repeatedly and ended desktop control for this turn. Do not retry until a new user request.');
      }
      if (state.actionsSinceObservation >= maxActionsWithoutObservation) {
        throw new Error(`Computer Use paused after ${maxActionsWithoutObservation} actions without observation. Observe the desktop before continuing.`);
      }
      const fingerprint = actionFingerprint(input);
      if (
        fingerprint === state.lastActionFingerprint &&
        state.repeatedActionCount >= maxRepeatedActionAttempts
      ) {
        throw new Error('Computer Use stopped a repeated action loop. The same action did not produce a visible change; use another route or report the blocker.');
      }
      if (state.unchangedActionCycles >= maxRepeatedActionAttempts) {
        throw new Error('Computer Use stopped after two action cycles without visible progress. Use another route or report the blocker instead of retrying.');
      }
    }
    state.busy = true;
    this.#activeScope = scopeId;
    state.touchedAt = Date.now();
    return () => {
      state.busy = false;
      if (this.#activeScope === scopeId) this.#activeScope = '';
      state.touchedAt = Date.now();
    };
  }

  recordObservation(
    scopeId: string,
    visualFingerprint: string,
    semanticFingerprint = '',
  ): void {
    if (!scopeId) return;
    const state = this.#state(scopeId);
    const hadObservation = Boolean(state.lastObservationFingerprint);
    const visualChanged = hadObservation &&
      !sameVisualState(state.lastObservationFingerprint, visualFingerprint);
    const semanticChanged = Boolean(
      state.lastObservationSemanticFingerprint &&
      semanticFingerprint &&
      state.lastObservationSemanticFingerprint !== semanticFingerprint,
    );
    const changed = visualChanged || semanticChanged;
    if (hadObservation && state.actionSinceObservation) {
      state.unchangedActionCycles = changed ? 0 : state.unchangedActionCycles + 1;
    } else if (changed) {
      state.unchangedActionCycles = 0;
    }
    state.observationsWithoutAction = state.actionSinceObservation || changed
      ? 1
      : state.observationsWithoutAction + 1;
    state.actionsSinceObservation = 0;
    state.actionSinceObservation = false;
    state.mustObserveAfterYield = false;
    if (changed) {
      state.lastActionFingerprint = '';
      state.repeatedActionCount = 0;
    }
    state.lastObservationFingerprint = visualFingerprint;
    state.lastObservationSemanticFingerprint = semanticFingerprint;
    state.observation = undefined;
    state.touchedAt = Date.now();
  }

  bindObservation(
    scopeId: string,
    observation: Omit<ComputerUseObservationBinding, 'stateId' | 'generation' | 'createdAt'>,
  ): string {
    if (!scopeId) throw new Error('Target-specific observation requires a turn scope.');
    const stateId = `desktop_state_${randomUUID()}`;
    const state = this.#state(scopeId);
    state.observation = {
      ...observation,
      stateId,
      generation: this.#desktopGeneration,
      createdAt: Date.now(),
    };
    state.touchedAt = Date.now();
    return stateId;
  }

  claimObservation(
    scopeId: string,
    input: Record<string, unknown>,
  ): ComputerUseObservationBinding {
    const stateId = optionalString(input.state_id);
    const hwnd = optionalInteger(input.hwnd);
    const state = this.#state(scopeId);
    const observation = state.observation;
    if (!stateId || hwnd == null || !observation) {
      throw new Error('This desktop action requires a fresh target-specific observe call. Pass its one-use state_id and exact hwnd.');
    }
    if (stateId !== observation.stateId) {
      throw new Error('The desktop state_id is stale or belongs to another observation. Observe the exact target window again.');
    }
    if (hwnd !== observation.hwnd) {
      throw new Error(`The desktop state targets hwnd=${observation.hwnd}, not hwnd=${hwnd}. Observe the intended window again.`);
    }
    if (observation.generation !== this.#desktopGeneration) {
      state.observation = undefined;
      throw new Error('The desktop changed after this state was observed, possibly in another session. Observe the exact target window again.');
    }
    if (Date.now() - observation.createdAt > observationStateTtlMs) {
      state.observation = undefined;
      throw new Error('The desktop state_id expired before it was used. Observe the exact target window again.');
    }
    state.observation = undefined;
    state.touchedAt = Date.now();
    return observation;
  }

  recordAction(
    scopeId: string,
    input: Record<string, unknown>,
    successful = true,
  ): void {
    if (!scopeId) return;
    const state = this.#state(scopeId);
    const fingerprint = actionFingerprint(input);
    state.actionsSinceObservation += 1;
    state.actionSinceObservation = true;
    state.repeatedActionCount = fingerprint === state.lastActionFingerprint
      ? state.repeatedActionCount + 1
      : 1;
    state.lastActionFingerprint = fingerprint;
    this.#desktopGeneration += 1;
    state.observation = undefined;
    if (successful) state.userYieldCount = 0;
    state.touchedAt = Date.now();
  }

  recordUserYield(scopeId: string): void {
    if (!scopeId) return;
    const state = this.#state(scopeId);
    state.mustObserveAfterYield = true;
    state.userYieldCount += 1;
    this.#desktopGeneration += 1;
    state.observation = undefined;
    state.touchedAt = Date.now();
  }

  releaseObservation(scopeId: string): void {
    this.#state(scopeId).observation = undefined;
    this.#desktopGeneration += 1;
  }

  expectedInputTick(scopeId: string): number | undefined {
    return scopeId ? this.#state(scopeId).expectedInputTick : undefined;
  }

  recordInputTick(scopeId: string, value: unknown): void {
    if (!scopeId) return;
    const tick = Number(value);
    if (Number.isSafeInteger(tick) && tick >= 0) this.#state(scopeId).expectedInputTick = tick;
  }

  reset(): void {
    this.#states.clear();
    this.#activeScope = '';
    this.#desktopGeneration = 0;
  }

  #state(scopeId: string): ComputerUseSafetyState {
    const existing = this.#states.get(scopeId);
    if (existing) return existing;
    const created: ComputerUseSafetyState = {
      busy: false,
      touchedAt: Date.now(),
      actionsSinceObservation: 0,
      lastActionFingerprint: '',
      repeatedActionCount: 0,
      lastObservationFingerprint: '',
      unchangedActionCycles: 0,
      actionSinceObservation: false,
      observationsWithoutAction: 0,
      mustObserveAfterYield: false,
      userYieldCount: 0,
      lastObservationSemanticFingerprint: '',
    };
    this.#states.set(scopeId, created);
    return created;
  }

  #cleanup(): void {
    const cutoff = Date.now() - safetyStateTtlMs;
    for (const [scopeId, state] of this.#states) {
      if (!state.busy && state.touchedAt < cutoff) this.#states.delete(scopeId);
    }
  }
}

const computerUseSafety = new ComputerUseSafetyGuard();

export async function executeComputerUse(
  input: Record<string, unknown>,
  config: ComputerUsePluginConfig,
  signal?: AbortSignal,
  scopeId = 'unscoped',
): Promise<ComputerUseResult> {
  throwIfAborted(signal);
  ensureWindows();
  const action = String(input.action ?? '').trim();
  if (action === 'finish') {
    await computerUsePresentation.finish(scopeId);
    computerUseSafety.releaseObservation(scopeId);
    return plain({ action, released: true });
  }
  computerUsePresentation.assertAvailable(scopeId);
  let release: () => void;
  try { release = computerUseSafety.begin(scopeId, input); }
  catch (error) { await computerUsePresentation.finish(scopeId).catch(() => undefined); throw error; }
  let presentationAction: Awaited<ReturnType<typeof computerUsePresentation.action>> | undefined;
  const requestSignal = signal;
  try {
    if (action === 'observe' || action === 'screenshot') {
      await computerUsePresentation.suspend();
      if (hasWindowSelector(input)) {
        const exactHwnd = optionalInteger(input.hwnd);
        const target = exactHwnd != null
          ? { hwnd: exactHwnd }
          : selectWindowTarget(
              await listWindows(signal) as Array<Record<string, unknown>>,
              input,
            );
        const capture = await captureWindowState(
          config.screenshotDirectory,
          target,
          action === 'observe',
          optionalInteger(input.max_elements) ?? 160,
          signal,
        );
        selectWindowTarget([record(capture.output.window)], input);
        computerUseSafety.recordObservation(
          scopeId,
          capture.visualFingerprint,
          capture.semanticFingerprint,
        );
        const stateId = action === 'observe'
          ? computerUseSafety.bindObservation(scopeId, capture.binding)
          : undefined;
        if (stateId) await computerUsePresentation.observe(scopeId, capture.binding.hwnd);
        return {
          output: {
            ...capture.output,
            ...(stateId ? {
              state_id: stateId,
              state_usage: 'one_action',
              state_ttl_ms: observationStateTtlMs,
              coordinate_space: 'window',
            } : {}),
          },
          paths: [capture.path],
          artifacts: [capture.artifact],
        };
      }
      const windows = await listWindows(signal) as Array<Record<string, unknown>>;
      if (action === 'observe') {
        const discoveryFingerprint = windowListFingerprint(windows);
        computerUseSafety.recordObservation(
          scopeId,
          discoveryFingerprint,
          discoveryFingerprint,
        );
        return plain({
          windows,
          actionable: false,
          capture_performed: false,
          next_step: 'Choose exactly one window and call observe again with its hwnd to obtain state_id, a target-window screenshot, and accessibility elements.',
        });
      }
      const capture = await captureDesktop(config.screenshotDirectory, signal);
      computerUseSafety.recordObservation(scopeId, capture.visualFingerprint);
      return {
        output: {
          ...capture.output,
          windows,
          actionable: false,
        },
        paths: [capture.path],
        artifacts: [capture.artifact],
      };
    }
    if (action === 'open_app') {
      if (!config.allowOpenApp) throw new Error('Opening applications is disabled in Computer Use settings.');
      await yieldForUserIfNeeded(config, computerUseSafety.expectedInputTick(scopeId), signal);
      const app = requiredString(input.app, 'app');
      const launch = record(json(await powershell(openApplicationScript, {
        CARDBUSH_APP_TARGET: app,
      }, signal)));
      computerUseSafety.recordAction(scopeId, input);
      return plain({ action, app, launch });
    }
    if (action === 'window') {
      const observation = computerUseSafety.claimObservation(scopeId, input);
      if (String(input.operation ?? '').trim().toLowerCase() === 'close' && !config.allowWindowClose) {
        throw new Error('Closing windows is disabled in Computer Use settings.');
      }
      await yieldForUserIfNeeded(config, computerUseSafety.expectedInputTick(scopeId), signal);
      presentationAction = await computerUsePresentation.action(scopeId, input, observation, signal);
      signal = presentationAction.signal;
      const output = await controlWindow(input, observation, signal);
      computerUseSafety.recordAction(scopeId, input);
      return plain(output);
    }
    if (['click', 'invoke', 'set_value', 'type', 'key', 'scroll', 'drag'].includes(action)) {
      const observation = computerUseSafety.claimObservation(scopeId, input);
      presentationAction = await computerUsePresentation.action(scopeId, input, observation, signal);
      signal = presentationAction.signal;
      if (
        action === 'invoke' ||
        action === 'set_value' ||
        (action === 'click' && optionalInteger(input.element_index) != null)
      ) {
        const output = await runAccessibilityAction(
          action,
          input,
          observation,
          config,
          computerUseSafety.expectedInputTick(scopeId),
          signal,
        );
        computerUseSafety.recordAction(scopeId, input);
        return plain(output);
      }
      const output = await runInput(
        action,
        input,
        observation,
        config,
        computerUseSafety.expectedInputTick(scopeId),
        signal,
      );
      computerUseSafety.recordAction(scopeId, input);
      computerUseSafety.recordInputTick(scopeId, output.last_input_tick);
      return plain(output);
    }
    throw new Error(`Unsupported computer_use action: ${action}`);
  } catch (error) {
    if (error instanceof ComputerUseUserActiveError || computerUsePresentation.isPaused(scopeId)) {
      computerUseSafety.recordUserYield(scopeId);
    } else if (!isObservationAction(action) && !isAbortError(error)) {
      // Failed input can still have partially reached the desktop. Counting the
      // attempt prevents an agent from retrying the same failure forever.
      computerUseSafety.recordAction(scopeId, input, false);
    }
    if (error instanceof ComputerUseUserActiveError || computerUsePresentation.isPaused(scopeId)) {
      await computerUsePresentation.pause(scopeId).catch(() => undefined);
    } else {
      await computerUsePresentation.finish(scopeId).catch(() => undefined);
    }
    throw error;
  } finally {
    await presentationAction?.release().catch(() => undefined);
    if (requestSignal?.aborted) await computerUsePresentation.finish(scopeId).catch(() => undefined);
    else await computerUsePresentation.restore().catch(() => undefined);
    release();
  }
}

const openApplicationScript = String.raw`
$requested = $env:CARDBUSH_APP_TARGET.Trim()
if (-not $requested) { throw 'Application target is empty.' }

function Launch-CardBushApplication([string]$target, [string]$resolution) {
  $process = Start-Process -FilePath $target -PassThru
  [PSCustomObject]@{
    requested = $requested
    target = $target
    resolution = $resolution
    process_id = if ($null -ne $process) { $process.Id } else { $null }
  } | ConvertTo-Json -Compress
  exit 0
}

if (Test-Path -LiteralPath $requested -PathType Leaf) {
  Launch-CardBushApplication (Resolve-Path -LiteralPath $requested).Path 'path'
}

$commandNames = @($requested)
if (-not [IO.Path]::GetExtension($requested)) { $commandNames += "$requested.exe" }
foreach ($name in $commandNames) {
  $command = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -ne $command) { Launch-CardBushApplication $command.Source 'command' }
}

$requestedBase = [IO.Path]::GetFileNameWithoutExtension($requested)
$appPathRoots = @(
  'Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\App Paths',
  'Registry::HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\App Paths',
  'Registry::HKEY_LOCAL_MACHINE\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths'
)
foreach ($root in $appPathRoots) {
  $entry = Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue | Where-Object {
    [string]::Equals([IO.Path]::GetFileNameWithoutExtension($_.PSChildName), $requestedBase, [StringComparison]::OrdinalIgnoreCase)
  } | Select-Object -First 1
  if ($null -ne $entry) {
    $target = $entry.GetValue('')
    if ($target -and (Test-Path -LiteralPath $target -PathType Leaf)) {
      Launch-CardBushApplication $target 'app_path'
    }
  }
}

$startAppMatches = @(Get-StartApps -ErrorAction SilentlyContinue | Where-Object {
  [string]::Equals($_.Name, $requested, [StringComparison]::OrdinalIgnoreCase) -or
  [string]::Equals($_.Name, $requestedBase, [StringComparison]::OrdinalIgnoreCase)
})
if ($startAppMatches.Count -eq 1) {
  $appId = $startAppMatches[0].AppID
  Start-Process -FilePath 'explorer.exe' -ArgumentList "shell:AppsFolder\$appId"
  [PSCustomObject]@{ requested=$requested; target=$appId; resolution='start_app'; process_id=$null } | ConvertTo-Json -Compress
  exit 0
}

$startMenuRoots = @(
  [Environment]::GetFolderPath('StartMenu'),
  [Environment]::GetFolderPath('CommonStartMenu')
) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Container) }
$shortcuts = @($startMenuRoots | ForEach-Object {
  Get-ChildItem -LiteralPath $_ -Filter '*.lnk' -File -Recurse -ErrorAction SilentlyContinue
})
$exactShortcuts = @($shortcuts | Where-Object {
  [string]::Equals($_.BaseName, $requested, [StringComparison]::OrdinalIgnoreCase) -or
  [string]::Equals($_.BaseName, $requestedBase, [StringComparison]::OrdinalIgnoreCase)
})
if ($exactShortcuts.Count -eq 1) {
  Launch-CardBushApplication $exactShortcuts[0].FullName 'start_menu'
}

throw "Application '$requested' was not found as a path, executable, registered app, or Start menu shortcut."
`;

async function captureDesktop(configuredDirectory: string, signal?: AbortSignal) {
  const directory = configuredDirectory || join(tmpdir(), 'cardbush-apps', 'captures');
  await mkdir(directory, { recursive: true });
  const path = join(directory, `capture-${Date.now()}-${randomUUID()}.png`);
  const script = String.raw`
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CardBushDesktopDpi {
  [DllImport("user32.dll", EntryPoint="SetProcessDpiAwarenessContext")] private static extern bool SetDpiContext(IntPtr value);
  [DllImport("user32.dll", EntryPoint="SetProcessDPIAware")] private static extern bool SetDpiAware();
  public static void Enable(){try{if(SetDpiContext(new IntPtr(-4)))return;}catch(EntryPointNotFoundException){}try{SetDpiAware();}catch(EntryPointNotFoundException){}}
}
'@
[CardBushDesktopDpi]::Enable()
  $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
  $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bounds.Size)
  $bitmap.Save($env:CARDBUSH_CAPTURE_PATH, [System.Drawing.Imaging.ImageFormat]::Png)
  $sample = New-Object System.Drawing.Bitmap 16, 16
  $sampleGraphics = [System.Drawing.Graphics]::FromImage($sample)
  try {
    $sampleGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::Low
    $sampleGraphics.DrawImage($bitmap, 0, 0, 16, 16)
    $fingerprint = New-Object byte[] 256
    for ($y = 0; $y -lt 16; $y++) {
      for ($x = 0; $x -lt 16; $x++) {
        $pixel = $sample.GetPixel($x, $y)
        $fingerprint[$y * 16 + $x] = [byte][Math]::Round(($pixel.R * 0.299) + ($pixel.G * 0.587) + ($pixel.B * 0.114))
      }
    }
    [PSCustomObject]@{ path=$env:CARDBUSH_CAPTURE_PATH; x=$bounds.Left; y=$bounds.Top; width=$bounds.Width; height=$bounds.Height; visual_fingerprint=[Convert]::ToBase64String($fingerprint) } | ConvertTo-Json -Compress
  } finally {
    $sampleGraphics.Dispose()
    $sample.Dispose()
  }
} finally {
  $graphics.Dispose()
  $bitmap.Dispose()
}`;
  const rawOutput = record(json(await powershell(
    script,
    { CARDBUSH_CAPTURE_PATH: path },
    signal,
  )));
  const visualFingerprint = optionalString(rawOutput.visual_fingerprint);
  const output = { ...rawOutput };
  delete output.visual_fingerprint;
  const artifact: ComputerUseArtifact = {
    artifact_id: `artifact_${randomUUID()}`,
    type: 'image',
    path,
    media_type: 'image/png',
    display: 'inline',
    metadata: { model_input: true, read_only: true, source: 'cardbush_apps' },
  };
  return { path, output, artifact, visualFingerprint };
}

async function captureWindowState(
  configuredDirectory: string,
  target: Record<string, unknown>,
  includeAccessibility: boolean,
  maxElements: number,
  signal?: AbortSignal,
) {
  const hwnd = optionalInteger(target.hwnd);
  if (hwnd == null || hwnd <= 0) throw new Error('Target window does not have a valid hwnd.');
  const directory = configuredDirectory || join(tmpdir(), 'cardbush-apps', 'captures');
  await mkdir(directory, { recursive: true });
  const path = join(directory, `window-${hwnd}-${Date.now()}-${randomUUID()}.png`);
  const rawOutput = record(json(await powershell(windowStateCaptureScript, {
    CARDBUSH_CAPTURE_PATH: path,
    CARDBUSH_WINDOW_HWND: String(hwnd),
    CARDBUSH_INCLUDE_ACCESSIBILITY: includeAccessibility ? '1' : '0',
    CARDBUSH_MAX_ELEMENTS: String(maxElements),
  }, signal)));
  const visualFingerprint = optionalString(rawOutput.visual_fingerprint);
  const bounds = windowBounds(rawOutput.bounds);
  const capturedWindow = recordOrEmpty(rawOutput.window);
  if (optionalInteger(capturedWindow.hwnd) !== hwnd) {
    throw new Error('Target window identity changed during capture. Observe again.');
  }
  const window: Record<string, unknown> = { ...target, ...capturedWindow, hwnd };
  const elements = includeAccessibility
    ? observedElements(recordOrEmpty(rawOutput.accessibility).elements)
    : [];
  const semanticFingerprint = accessibilityFingerprint(elements);
  const accessibilityRecord = recordOrEmpty(rawOutput.accessibility);
  const accessibility = includeAccessibility
    ? {
        available: accessibilityRecord.available === true,
        total_elements: optionalInteger(accessibilityRecord.total_elements) ?? elements.length,
        returned_elements: elements.length,
        truncated: accessibilityRecord.truncated === true,
        ...(optionalString(accessibilityRecord.error)
          ? { error: optionalString(accessibilityRecord.error) }
          : {}),
        elements: elements.map(publicObservedElement),
      }
    : undefined;
  const output = {
    path,
    window,
    bounds,
    capture_method: optionalString(rawOutput.capture_method) || 'unknown',
    foreground_hwnd: optionalInteger(rawOutput.foreground_hwnd) ?? 0,
    actionable: includeAccessibility,
    ...(accessibility ? { accessibility } : {}),
  };
  const artifact: ComputerUseArtifact = {
    artifact_id: `artifact_${randomUUID()}`,
    type: 'image',
    path,
    media_type: 'image/png',
    display: 'inline',
    metadata: {
      model_input: true,
      read_only: true,
      source: 'cardbush_apps',
      target_hwnd: hwnd,
    },
  };
  const binding: Omit<ComputerUseObservationBinding, 'stateId' | 'generation' | 'createdAt'> = {
    hwnd,
    processId: optionalInteger(window.process_id),
    processName: optionalString(window.process_name),
    title: optionalString(window.title),
    bounds,
    elements,
  };
  return {
    path,
    output,
    artifact,
    visualFingerprint,
    semanticFingerprint,
    binding,
  };
}

const windowStateCaptureScript = String.raw`
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class CardBushWindowCapture {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr hwnd, StringBuilder value, int capacity);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
  [DllImport("user32.dll", EntryPoint="SetProcessDpiAwarenessContext")] private static extern bool SetDpiContext(IntPtr value);
  [DllImport("user32.dll", EntryPoint="SetProcessDPIAware")] private static extern bool SetDpiAware();
  public static void EnableDpiAwareness() {
    try { if (SetDpiContext(new IntPtr(-4))) return; } catch (EntryPointNotFoundException) {}
    try { SetDpiAware(); } catch (EntryPointNotFoundException) {}
  }
  public static string WindowTitle(IntPtr hwnd) { var value = new StringBuilder(2048); GetWindowText(hwnd, value, value.Capacity); return value.ToString(); }
  public static uint WindowProcessId(IntPtr hwnd) { uint processId; GetWindowThreadProcessId(hwnd, out processId); return processId; }
}
'@
[CardBushWindowCapture]::EnableDpiAwareness()
$h = [IntPtr]([Int64]$env:CARDBUSH_WINDOW_HWND)
if (-not [CardBushWindowCapture]::IsWindow($h)) { throw 'The target window is no longer available. Observe again.' }
$rect = New-Object CardBushWindowCapture+RECT
if (-not [CardBushWindowCapture]::GetWindowRect($h, [ref]$rect)) { throw 'Unable to read the target window bounds.' }
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
if ($width -le 0 -or $height -le 0) { throw 'The target window has empty bounds. Restore it and observe again.' }
$processId = [int][CardBushWindowCapture]::WindowProcessId($h)
$processName = ''
try { $processName = [Diagnostics.Process]::GetProcessById($processId).ProcessName } catch {}
$windowTitle = [CardBushWindowCapture]::WindowTitle($h)

$bitmap = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$captureMethod = 'print_window'
try {
  $hdc = $graphics.GetHdc()
  try { $captured = [CardBushWindowCapture]::PrintWindow($h, $hdc, 2) }
  finally { $graphics.ReleaseHdc($hdc) }
  if (-not $captured) {
    $graphics.Clear([System.Drawing.Color]::Black)
    $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, [System.Drawing.Size]::new($width, $height))
    $captureMethod = 'screen_fallback'
  }
  $bitmap.Save($env:CARDBUSH_CAPTURE_PATH, [System.Drawing.Imaging.ImageFormat]::Png)
  $sample = New-Object System.Drawing.Bitmap 32, 32
  $sampleGraphics = [System.Drawing.Graphics]::FromImage($sample)
  try {
    $sampleGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::Low
    $sampleGraphics.DrawImage($bitmap, 0, 0, 32, 32)
    $fingerprint = New-Object byte[] 1024
    for ($sampleY = 0; $sampleY -lt 32; $sampleY++) {
      for ($sampleX = 0; $sampleX -lt 32; $sampleX++) {
        $pixel = $sample.GetPixel($sampleX, $sampleY)
        $fingerprint[$sampleY * 32 + $sampleX] = [byte][Math]::Round(($pixel.R * 0.299) + ($pixel.G * 0.587) + ($pixel.B * 0.114))
      }
    }
  } finally {
    $sampleGraphics.Dispose()
    $sample.Dispose()
  }
} finally {
  $graphics.Dispose()
  $bitmap.Dispose()
}

$accessibilityAvailable = $false
$accessibilityError = $null
$totalElements = 0
$truncated = $false
$elements = [System.Collections.Generic.List[object]]::new()
if ($env:CARDBUSH_INCLUDE_ACCESSIBILITY -eq '1') {
  try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($h)
    if ($null -eq $root) { throw 'UI Automation could not bind to the target window.' }
    $all = $root.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.Condition]::TrueCondition
    )
    $totalElements = $all.Count
    $maxElements = [Math]::Max(20, [Math]::Min(300, [int]$env:CARDBUSH_MAX_ELEMENTS))
    for ($sourceIndex = 0; $sourceIndex -lt $all.Count -and $elements.Count -lt $maxElements; $sourceIndex++) {
      try {
        $element = $all.Item($sourceIndex)
        $current = $element.Current
        if (-not $current.IsControlElement) { continue }
        $runtimeId = @($element.GetRuntimeId()) -join '.'
        if (-not $runtimeId) { continue }
        $elementRect = $current.BoundingRectangle
        $elementBounds = $null
        if (
          -not [double]::IsNaN($elementRect.X) -and
          -not [double]::IsInfinity($elementRect.X) -and
          $elementRect.Width -gt 0 -and
          $elementRect.Height -gt 0
        ) {
          $elementBounds = [PSCustomObject]@{
            x = [Math]::Round($elementRect.X - $rect.Left)
            y = [Math]::Round($elementRect.Y - $rect.Top)
            width = [Math]::Round($elementRect.Width)
            height = [Math]::Round($elementRect.Height)
          }
        }
        $patterns = @($element.GetSupportedPatterns() | ForEach-Object {
          $_.ProgrammaticName -replace 'PatternIdentifiers\.Pattern$', ''
        } | Where-Object {
          $_ -in @('Invoke', 'Toggle', 'SelectionItem', 'ExpandCollapse', 'Value', 'RangeValue', 'Text', 'Scroll', 'LegacyIAccessible')
        })
        $name = [string]$current.Name
        $automationId = [string]$current.AutomationId
        if ($current.IsOffscreen -and -not $current.HasKeyboardFocus) { continue }
        if (-not $name -and -not $automationId -and $patterns.Count -eq 0) { continue }
        $isPassword = [bool]$current.IsPassword
        $currentValue = $null
        $semanticState = $null
        $valueReadOnly = $null
        $patternObject = $null
        if (-not $isPassword -and $element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$patternObject)) {
          $valuePattern = [System.Windows.Automation.ValuePattern]$patternObject
          $currentValue = [string]$valuePattern.Current.Value
          $valueReadOnly = [bool]$valuePattern.Current.IsReadOnly
        } elseif (-not $isPassword -and $element.TryGetCurrentPattern([System.Windows.Automation.RangeValuePattern]::Pattern, [ref]$patternObject)) {
          $rangePattern = [System.Windows.Automation.RangeValuePattern]$patternObject
          $currentValue = [string]$rangePattern.Current.Value
          $valueReadOnly = [bool]$rangePattern.Current.IsReadOnly
        }
        $patternObject = $null
        if ($element.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$patternObject)) {
          $semanticState = [string]([System.Windows.Automation.TogglePattern]$patternObject).Current.ToggleState
        } elseif ($element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$patternObject)) {
          $semanticState = if (([System.Windows.Automation.SelectionItemPattern]$patternObject).Current.IsSelected) { 'selected' } else { 'not_selected' }
        } elseif ($element.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$patternObject)) {
          $semanticState = [string]([System.Windows.Automation.ExpandCollapsePattern]$patternObject).Current.ExpandCollapseState
        }
        $elements.Add([PSCustomObject]@{
          index = $elements.Count
          runtime_id = $runtimeId
          name = $name
          automation_id = $automationId
          control_type = (([string]$current.ControlType.ProgrammaticName) -replace '^ControlType\.', '')
          class_name = [string]$current.ClassName
          enabled = [bool]$current.IsEnabled
          focused = [bool]$current.HasKeyboardFocus
          offscreen = [bool]$current.IsOffscreen
          password = $isPassword
          bounds = $elementBounds
          patterns = $patterns
          value = $currentValue
          state = $semanticState
          read_only = $valueReadOnly
        })
      } catch {
        continue
      }
    }
    $truncated = $sourceIndex -lt $all.Count
    $accessibilityAvailable = $true
  } catch {
    $accessibilityError = $_.Exception.Message
  }
}

[PSCustomObject]@{
  path = $env:CARDBUSH_CAPTURE_PATH
  window = [PSCustomObject]@{ process_id=$processId; hwnd=$h.ToInt64(); title=$windowTitle; process_name=$processName }
  bounds = [PSCustomObject]@{ x=$rect.Left; y=$rect.Top; width=$width; height=$height }
  capture_method = $captureMethod
  foreground_hwnd = [CardBushWindowCapture]::GetForegroundWindow().ToInt64()
  visual_fingerprint = [Convert]::ToBase64String($fingerprint)
  accessibility = [PSCustomObject]@{
    available = $accessibilityAvailable
    total_elements = $totalElements
    truncated = $truncated
    error = $accessibilityError
    elements = $elements.ToArray()
  }
} | ConvertTo-Json -Depth 8 -Compress`;

async function listWindows(signal?: AbortSignal): Promise<unknown[]> {
  const output = await powershell(String.raw`
$items = Get-Process -ErrorAction SilentlyContinue | Where-Object {
  $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -and $_.MainWindowTitle -ne 'Program Manager'
} | ForEach-Object {
  [PSCustomObject]@{ process_id=$_.Id; hwnd=$_.MainWindowHandle.ToInt64(); title=$_.MainWindowTitle; process_name=$_.ProcessName }
}
@($items) | ConvertTo-Json -Compress`, {}, signal);
  if (!output.trim()) return [];
  const value = json(output);
  return Array.isArray(value) ? value : [value];
}

async function controlWindow(
  input: Record<string, unknown>,
  observation: ComputerUseObservationBinding,
  signal?: AbortSignal,
) {
  const operation = String(input.operation ?? 'activate').trim().toLowerCase();
  const normalized = operation === 'activate' ? 'focus' : operation;
  if (!['focus', 'minimize', 'maximize', 'restore', 'close', 'move', 'resize'].includes(normalized)) {
    throw new Error(`Unsupported window operation: ${operation}`);
  }
  const windows = await listWindows(signal) as Array<Record<string, unknown>>;
  const target = selectWindowTarget(windows, input);
  if (optionalInteger(target.hwnd) !== observation.hwnd) {
    throw new Error('The selected window no longer matches the observed target. Observe again.');
  }
  const bounds = {
    x: optionalInteger(input.x),
    y: optionalInteger(input.y),
    width: optionalInteger(input.width),
    height: optionalInteger(input.height),
  };
  if (normalized === 'move' && (bounds.x == null || bounds.y == null)) throw new Error('move requires x and y.');
  if (normalized === 'resize' && (bounds.width == null || bounds.height == null)) throw new Error('resize requires width and height.');
  await powershell(windowControlScript, {
    CARDBUSH_WINDOW_HWND: String(target.hwnd),
    CARDBUSH_WINDOW_OPERATION: normalized,
    CARDBUSH_WINDOW_X: String(bounds.x ?? 0),
    CARDBUSH_WINDOW_Y: String(bounds.y ?? 0),
    CARDBUSH_WINDOW_WIDTH: String(bounds.width ?? 0),
    CARDBUSH_WINDOW_HEIGHT: String(bounds.height ?? 0),
    CARDBUSH_EXPECTED_WINDOW_X: String(observation.bounds.x),
    CARDBUSH_EXPECTED_WINDOW_Y: String(observation.bounds.y),
    CARDBUSH_EXPECTED_WINDOW_WIDTH: String(observation.bounds.width),
    CARDBUSH_EXPECTED_WINDOW_HEIGHT: String(observation.bounds.height),
  }, signal);
  return { action: 'window', operation: normalized, target };
}

export function selectWindowTarget(
  windows: Array<Record<string, unknown>>,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const hwnd = optionalInteger(input.hwnd);
  const titlePattern = optionalString(input.title_pattern).toLowerCase();
  const app = normalizeProcessName(optionalString(input.app));
  if (hwnd == null && !titlePattern && !app) {
    throw new Error('Window action requires app, title_pattern, or hwnd.');
  }

  const matches = windows.filter((window) => {
    if (hwnd != null && Number(window.hwnd) !== hwnd) return false;
    if (
      app &&
      normalizeProcessName(String(window.process_name ?? '')) !== app
    ) {
      return false;
    }
    if (
      titlePattern &&
      !String(window.title ?? '').toLowerCase().includes(titlePattern)
    ) {
      return false;
    }
    return true;
  });
  if (matches.length === 1) return matches[0];

  const selector = [
    hwnd != null ? `hwnd=${hwnd}` : '',
    app ? `app="${app}"` : '',
    titlePattern ? `title_pattern="${titlePattern}"` : '',
  ].filter(Boolean).join(', ');
  if (matches.length === 0) {
    throw new Error(`Window was not found for ${selector}. Call action="observe" to list available windows.`);
  }
  const candidates = matches
    .slice(0, 6)
    .map(windowDescription)
    .join('; ');
  throw new Error(
    `Window selector ${selector} matched ${matches.length} windows: ${candidates}. Retry with hwnd.`,
  );
}

function normalizeProcessName(value: string) {
  const executable = value
    .replace(/^['"]|['"]$/g, '')
    .split(/[\\/]/)
    .at(-1)
    ?.trim()
    .toLowerCase() ?? '';
  const name = executable.replace(/\.exe$/i, '');
  const aliases: Record<string, string> = {
    'google chrome': 'chrome',
    'microsoft edge': 'msedge',
    'visual studio code': 'code',
  };
  return aliases[name] ?? name;
}

function windowDescription(window: Record<string, unknown>) {
  const title = String(window.title ?? '').replace(/\s+/g, ' ').trim();
  return `hwnd=${Number(window.hwnd) || 0} process=${String(window.process_name ?? '')} title="${title}"`;
}

async function runAccessibilityAction(
  action: string,
  input: Record<string, unknown>,
  observation: ComputerUseObservationBinding,
  config: ComputerUsePluginConfig,
  expectedInputTick: number | undefined,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const elementIndex = optionalInteger(input.element_index);
  if (elementIndex == null) throw new Error(`${action} requires element_index.`);
  const element = observation.elements.find((candidate) => candidate.index === elementIndex);
  if (!element) {
    throw new Error(`Accessibility element_index=${elementIndex} is not part of state_id=${observation.stateId}. Observe the target window again.`);
  }
  if (action === 'set_value' && element.password) {
    throw new Error('Computer Use refuses to set password fields through UI Automation. Ask the user to take over.');
  }
  if (action === 'set_value' && element.readOnly) {
    throw new Error('The observed accessibility value is read-only. Observe again and choose a writable element.');
  }
  const value = input.value == null ? '' : String(input.value);
  const absoluteBounds = element.bounds
    ? {
        x: observation.bounds.x + element.bounds.x,
        y: observation.bounds.y + element.bounds.y,
        width: element.bounds.width,
        height: element.bounds.height,
      }
    : null;
  const payload = Buffer.from(JSON.stringify({
    action,
    hwnd: observation.hwnd,
    element_index: elementIndex,
    element_runtime_id: element.runtimeId,
    element_name: element.name,
    element_automation_id: element.automationId,
    element_control_type: element.controlType,
    element_bounds: absoluteBounds,
    has_observed_value: element.value !== undefined,
    observed_value: element.value ?? '',
    has_observed_state: element.state !== undefined,
    observed_state: element.state ?? '',
    value,
  }), 'utf8').toString('base64');
  const result = record(json(await powershell(accessibilityActionScript, {
    CARDBUSH_UIA_ACTION_BASE64: payload,
    CARDBUSH_YIELD_TO_USER: config.yieldToUser ? '1' : '0',
    CARDBUSH_EXPECTED_INPUT_TICK: String(expectedInputTick ?? 0),
  }, signal)));
  if (result.yielded_to_user === true) throw new ComputerUseUserActiveError();
  return result;
}

const accessibilityActionScript = String.raw`
$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:CARDBUSH_UIA_ACTION_BASE64))
$p = $json | ConvertFrom-Json
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CardBushUiaWindow {
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
  [DllImport("user32.dll", EntryPoint="SetProcessDpiAwarenessContext")] private static extern bool SetDpiContext(IntPtr value);
  [DllImport("user32.dll", EntryPoint="SetProcessDPIAware")] private static extern bool SetDpiAware();
  public static void EnableDpiAwareness(){try{if(SetDpiContext(new IntPtr(-4)))return;}catch(EntryPointNotFoundException){}try{SetDpiAware();}catch(EntryPointNotFoundException){}}
  public static uint LastInputTick(){LASTINPUTINFO info=new LASTINPUTINFO{cbSize=(uint)Marshal.SizeOf(typeof(LASTINPUTINFO))};if(!GetLastInputInfo(ref info))return 0;return info.dwTime;}
  public static uint IdleMilliseconds(){unchecked{return (uint)Environment.TickCount-LastInputTick();}}
}
'@
[CardBushUiaWindow]::EnableDpiAwareness()
$yieldToUser = $env:CARDBUSH_YIELD_TO_USER -eq '1'
$expectedInputTick = [uint32]$env:CARDBUSH_EXPECTED_INPUT_TICK
$wait = [Diagnostics.Stopwatch]::StartNew()
$ready = -not $yieldToUser
while (-not $ready -and $wait.ElapsedMilliseconds -lt 2400) {
  $lastInputTick = [CardBushUiaWindow]::LastInputTick()
  $ready = (($expectedInputTick -ne 0) -and ($lastInputTick -eq $expectedInputTick)) -or ([CardBushUiaWindow]::IdleMilliseconds() -ge 700)
  if (-not $ready) { Start-Sleep -Milliseconds 60 }
}
if (-not $ready) {
  [PSCustomObject]@{ action=$p.action; yielded_to_user=$true; input_wait_ms=$wait.ElapsedMilliseconds } | ConvertTo-Json -Compress
  exit 0
}
$h = [IntPtr]([Int64]$p.hwnd)
if (-not [CardBushUiaWindow]::IsWindow($h)) { throw 'The target window is no longer available. Observe again.' }
$root = [System.Windows.Automation.AutomationElement]::FromHandle($h)
if ($null -eq $root) { throw 'UI Automation could not bind to the target window. Observe again.' }
$all = $root.FindAll(
  [System.Windows.Automation.TreeScope]::Descendants,
  [System.Windows.Automation.Condition]::TrueCondition
)
$target = $null
for ($index = 0; $index -lt $all.Count; $index++) {
  try {
    $candidate = $all.Item($index)
    if ((@($candidate.GetRuntimeId()) -join '.') -eq [string]$p.element_runtime_id) {
      $target = $candidate
      break
    }
  } catch {
    continue
  }
}
if ($null -eq $target) { throw 'The accessibility element is stale. Observe the target window again.' }
$current = $target.Current
if (-not $current.IsEnabled) { throw 'The accessibility element is disabled.' }
if ($current.IsOffscreen) { throw 'The accessibility element moved offscreen. Observe the target window again.' }
if ($p.action -eq 'set_value' -and $current.IsPassword) { throw 'Computer Use refuses to set password fields through UI Automation.' }
$currentControlType = (([string]$current.ControlType.ProgrammaticName) -replace '^ControlType\.', '')
if (
  [string]$current.Name -ne [string]$p.element_name -or
  [string]$current.AutomationId -ne [string]$p.element_automation_id -or
  $currentControlType -ne [string]$p.element_control_type
) { throw 'The accessibility element identity changed after observation. Observe the target window again.' }
if ($null -ne $p.element_bounds) {
  $currentBounds = $current.BoundingRectangle
  if (
    [double]::IsNaN($currentBounds.X) -or
    [Math]::Abs($currentBounds.X - [double]$p.element_bounds.x) -gt 3 -or
    [Math]::Abs($currentBounds.Y - [double]$p.element_bounds.y) -gt 3 -or
    [Math]::Abs($currentBounds.Width - [double]$p.element_bounds.width) -gt 3 -or
    [Math]::Abs($currentBounds.Height - [double]$p.element_bounds.height) -gt 3
  ) { throw 'The accessibility element bounds changed after observation. Observe the target window again.' }
}
if ([bool]$p.has_observed_value) {
  $observedPattern = $null
  $currentValueAvailable = $false
  $currentValue = ''
  if (-not $current.IsPassword -and $target.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$observedPattern)) {
    $currentValue = [string]([System.Windows.Automation.ValuePattern]$observedPattern).Current.Value
    $currentValueAvailable = $true
  } elseif (-not $current.IsPassword -and $target.TryGetCurrentPattern([System.Windows.Automation.RangeValuePattern]::Pattern, [ref]$observedPattern)) {
    $currentValue = [string]([System.Windows.Automation.RangeValuePattern]$observedPattern).Current.Value
    $currentValueAvailable = $true
  }
  if (-not $currentValueAvailable -or $currentValue -ne [string]$p.observed_value) {
    throw 'The accessibility value changed after observation. Observe again instead of overwriting newer input.'
  }
}
if ([bool]$p.has_observed_state) {
  $observedPattern = $null
  $currentState = $null
  if ($target.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$observedPattern)) {
    $currentState = [string]([System.Windows.Automation.TogglePattern]$observedPattern).Current.ToggleState
  } elseif ($target.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$observedPattern)) {
    $currentState = if (([System.Windows.Automation.SelectionItemPattern]$observedPattern).Current.IsSelected) { 'selected' } else { 'not_selected' }
  } elseif ($target.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$observedPattern)) {
    $currentState = [string]([System.Windows.Automation.ExpandCollapsePattern]$observedPattern).Current.ExpandCollapseState
  }
  if ($null -eq $currentState -or $currentState -ne [string]$p.observed_state) {
    throw 'The accessibility control state changed after observation. Observe the target window again.'
  }
}

$usedPattern = $null
if ($p.action -eq 'set_value') {
  $pattern = $null
  if ($target.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
    $valuePattern = [System.Windows.Automation.ValuePattern]$pattern
    if ($valuePattern.Current.IsReadOnly) { throw 'The accessibility value is read-only.' }
    $valuePattern.SetValue([string]$p.value)
    $usedPattern = 'Value'
  } elseif ($target.TryGetCurrentPattern([System.Windows.Automation.RangeValuePattern]::Pattern, [ref]$pattern)) {
    $number = 0.0
    if (-not [double]::TryParse([string]$p.value, [ref]$number)) { throw 'The range value must be numeric.' }
    ([System.Windows.Automation.RangeValuePattern]$pattern).SetValue($number)
    $usedPattern = 'RangeValue'
  } else {
    throw 'This element does not expose a writable Value or RangeValue pattern. Observe again and use a coordinate fallback if necessary.'
  }
} else {
  $pattern = $null
  if ($target.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
    ([System.Windows.Automation.InvokePattern]$pattern).Invoke()
    $usedPattern = 'Invoke'
  } elseif ($target.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pattern)) {
    ([System.Windows.Automation.TogglePattern]$pattern).Toggle()
    $usedPattern = 'Toggle'
  } elseif ($target.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) {
    ([System.Windows.Automation.SelectionItemPattern]$pattern).Select()
    $usedPattern = 'SelectionItem'
  } elseif ($target.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$pattern)) {
    $expandPattern = [System.Windows.Automation.ExpandCollapsePattern]$pattern
    if ($expandPattern.Current.ExpandCollapseState -eq [System.Windows.Automation.ExpandCollapseState]::Collapsed) {
      $expandPattern.Expand()
      $usedPattern = 'Expand'
    } else {
      $expandPattern.Collapse()
      $usedPattern = 'Collapse'
    }
  } else {
    throw 'This element has no semantic action. Observe again and use a window-relative coordinate fallback if necessary.'
  }
}

[PSCustomObject]@{
  action = $p.action
  input_mode = 'ui_automation'
  hwnd = [Int64]$p.hwnd
  element_index = [int]$p.element_index
  pattern = $usedPattern
  yielded_to_user = $false
  input_wait_ms = $wait.ElapsedMilliseconds
} | ConvertTo-Json -Compress`;

async function runInput(
  action: string,
  input: Record<string, unknown>,
  observation: ComputerUseObservationBinding,
  config: ComputerUsePluginConfig,
  expectedInputTick: number | undefined,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const payload = Buffer.from(JSON.stringify({
    action,
    ...input,
    hwnd: observation.hwnd,
    observed_bounds: observation.bounds,
    coordinate_space: 'window',
  }), 'utf8').toString('base64');
  const output = await powershell(
    computerInputScript,
    {
      CARDBUSH_INPUT_BASE64: payload,
      CARDBUSH_YIELD_TO_USER: config.yieldToUser ? '1' : '0',
      CARDBUSH_RESTORE_POINTER: config.restorePointer ? '1' : '0',
      CARDBUSH_EXPECTED_INPUT_TICK: String(expectedInputTick ?? 0),
    },
    signal,
  );
  const result = output.trim() ? record(json(output)) : { action };
  if (result.yielded_to_user === true) throw new ComputerUseUserActiveError();
  return result;
}

const windowControlScript = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CardBushWindowControl {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int h2, uint f);
  [DllImport("user32.dll", EntryPoint="SetProcessDpiAwarenessContext")] private static extern bool SetDpiContext(IntPtr value);
  [DllImport("user32.dll", EntryPoint="SetProcessDPIAware")] private static extern bool SetDpiAware();
  public static void EnableDpiAwareness(){try{if(SetDpiContext(new IntPtr(-4)))return;}catch(EntryPointNotFoundException){}try{SetDpiAware();}catch(EntryPointNotFoundException){}}
}
'@
[CardBushWindowControl]::EnableDpiAwareness()
$h = [IntPtr]([Int64]$env:CARDBUSH_WINDOW_HWND)
$op = $env:CARDBUSH_WINDOW_OPERATION
$rect = New-Object CardBushWindowControl+RECT
if (-not [CardBushWindowControl]::GetWindowRect($h, [ref]$rect)) { throw 'The target window is no longer available. Observe again.' }
$expectedX = [int]$env:CARDBUSH_EXPECTED_WINDOW_X
$expectedY = [int]$env:CARDBUSH_EXPECTED_WINDOW_Y
$expectedWidth = [int]$env:CARDBUSH_EXPECTED_WINDOW_WIDTH
$expectedHeight = [int]$env:CARDBUSH_EXPECTED_WINDOW_HEIGHT
if (
  [Math]::Abs($rect.Left - $expectedX) -gt 2 -or
  [Math]::Abs($rect.Top - $expectedY) -gt 2 -or
  [Math]::Abs(($rect.Right - $rect.Left) - $expectedWidth) -gt 2 -or
  [Math]::Abs(($rect.Bottom - $rect.Top) - $expectedHeight) -gt 2
) { throw 'The target window bounds changed after observation. Observe again.' }
switch ($op) {
  'focus' { [void][CardBushWindowControl]::ShowWindow($h,9); [void][CardBushWindowControl]::SetForegroundWindow($h) }
  'minimize' { [void][CardBushWindowControl]::ShowWindow($h,6) }
  'maximize' { [void][CardBushWindowControl]::ShowWindow($h,3) }
  'restore' { [void][CardBushWindowControl]::ShowWindow($h,9) }
  'close' { [void][CardBushWindowControl]::PostMessage($h,0x0010,[IntPtr]::Zero,[IntPtr]::Zero) }
  'move' { [void][CardBushWindowControl]::SetWindowPos($h,[IntPtr]::Zero,[int]$env:CARDBUSH_WINDOW_X,[int]$env:CARDBUSH_WINDOW_Y,$rect.Right-$rect.Left,$rect.Bottom-$rect.Top,0x0014) }
  'resize' { [void][CardBushWindowControl]::SetWindowPos($h,[IntPtr]::Zero,$rect.Left,$rect.Top,[int]$env:CARDBUSH_WINDOW_WIDTH,[int]$env:CARDBUSH_WINDOW_HEIGHT,0x0014) }
}`;

const computerInputScript = String.raw`
$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:CARDBUSH_INPUT_BASE64))
$p = $json | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class CardBushInput {
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion data; }
  [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public KEYBDINPUT keyboard; [FieldOffset(0)] public MOUSEINPUT mouse; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int x, y; public uint data, flags, time; public UIntPtr extraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort virtualKey; public ushort scanCode; public uint flags; public uint time; public UIntPtr extraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x; public int y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,int d,UIntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte k,byte s,uint f,UIntPtr e);
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll", EntryPoint="SetProcessDpiAwarenessContext")] private static extern bool SetDpiContext(IntPtr value);
  [DllImport("user32.dll", EntryPoint="SetProcessDPIAware")] private static extern bool SetDpiAware();
  public static void EnableDpiAwareness(){try{if(SetDpiContext(new IntPtr(-4)))return;}catch(EntryPointNotFoundException){}try{SetDpiAware();}catch(EntryPointNotFoundException){}}
  public static uint LastInputTick(){LASTINPUTINFO info=new LASTINPUTINFO{cbSize=(uint)Marshal.SizeOf(typeof(LASTINPUTINFO))};if(!GetLastInputInfo(ref info))return 0;return info.dwTime;}
  public static uint IdleMilliseconds(){unchecked{return (uint)Environment.TickCount-LastInputTick();}}
  public static long ForegroundWindow(){return GetForegroundWindow().ToInt64();}
  public static long RootWindowAt(int x,int y){POINT point=new POINT{x=x,y=y};IntPtr found=WindowFromPoint(point);if(found==IntPtr.Zero)return 0;IntPtr root=GetAncestor(found,2);return (root==IntPtr.Zero?found:root).ToInt64();}
  public static readonly UIntPtr InputTag=new UIntPtr(0x43425553);
  public static void Key(byte k,bool d){keybd_event(k,0,d?0u:2u,InputTag);}
  public static void Text(string text){
    foreach(char character in text){
      INPUT down=new INPUT{type=1,data=new InputUnion{keyboard=new KEYBDINPUT{scanCode=character,flags=4,extraInfo=InputTag}}};
      INPUT up=new INPUT{type=1,data=new InputUnion{keyboard=new KEYBDINPUT{scanCode=character,flags=6,extraInfo=InputTag}}};
      INPUT[] inputs=new INPUT[]{down,up};
      if(SendInput(2,inputs,Marshal.SizeOf(typeof(INPUT)))!=2) throw new InvalidOperationException("Unicode keyboard input failed.");
    }
  }
  public static void MovePointer(int x,int y){if(!SetCursorPos(x,y))throw new InvalidOperationException("Pointer target is outside the interactive desktop.");}
  public static void Drag(int x,int y,int tx,int ty,int steps,int duration){MovePointer(x,y);mouse_event(2,0,0,0,InputTag);try{for(int i=1;i<=steps;i++){MovePointer(x+(tx-x)*i/steps,y+(ty-y)*i/steps);if(duration>0)Thread.Sleep(duration/steps);}}finally{mouse_event(4,0,0,0,InputTag);}}
}
'@
[CardBushInput]::EnableDpiAwareness()
function KeyCode([string]$key) {
  $named = @{backspace=8;tab=9;enter=13;shift=16;ctrl=17;control=17;alt=18;escape=27;esc=27;space=32;pageup=33;pagedown=34;end=35;home=36;left=37;up=38;right=39;down=40;delete=46;win=91}
  $lower = $key.ToLowerInvariant()
  if ($named.ContainsKey($lower)) { return [byte]$named[$lower] }
  if ($lower -match '^[a-z0-9]$') { return [byte][char]$lower.ToUpperInvariant() }
  if ($lower -match '^f([1-9]|1[0-2])$') { return [byte](111 + [int]$Matches[1]) }
  throw "Unsupported key: $key"
}
$yieldToUser = $env:CARDBUSH_YIELD_TO_USER -eq '1'
$restorePointer = $env:CARDBUSH_RESTORE_POINTER -eq '1'
$expectedInputTick = [uint32]$env:CARDBUSH_EXPECTED_INPUT_TICK
$wait = [Diagnostics.Stopwatch]::StartNew()
$ready = -not $yieldToUser
while (-not $ready -and $wait.ElapsedMilliseconds -lt 2400) {
  $lastInputTick = [CardBushInput]::LastInputTick()
  $ready = (($expectedInputTick -ne 0) -and ($lastInputTick -eq $expectedInputTick)) -or ([CardBushInput]::IdleMilliseconds() -ge 700)
  if (-not $ready) { Start-Sleep -Milliseconds 60 }
}
if (-not $ready) {
  [PSCustomObject]@{ action=$p.action; yielded_to_user=$true; input_wait_ms=$wait.ElapsedMilliseconds } | ConvertTo-Json -Compress
  exit 0
}

$pointer = New-Object CardBushInput+POINT
[void][CardBushInput]::GetCursorPos([ref]$pointer)
$expectedHwnd = if ($null -ne $p.hwnd) { [Int64]$p.hwnd } else { 0 }
if ($expectedHwnd -gt 0) {
  $observedBounds = $p.observed_bounds
  $currentBounds = New-Object CardBushInput+RECT
  if (-not [CardBushInput]::GetWindowRect([IntPtr]$expectedHwnd, [ref]$currentBounds)) {
    throw "Target window hwnd=$expectedHwnd is no longer available. Observe again."
  }
  if (
    $null -eq $observedBounds -or
    [Math]::Abs($currentBounds.Left - [int]$observedBounds.x) -gt 2 -or
    [Math]::Abs($currentBounds.Top - [int]$observedBounds.y) -gt 2 -or
    [Math]::Abs(($currentBounds.Right - $currentBounds.Left) - [int]$observedBounds.width) -gt 2 -or
    [Math]::Abs(($currentBounds.Bottom - $currentBounds.Top) - [int]$observedBounds.height) -gt 2
  ) {
    throw "Target window bounds changed after observation. Observe hwnd=$expectedHwnd again."
  }
  function Window-X([int]$value) {
    if ($value -lt 0 -or $value -ge [int]$observedBounds.width) { throw "Window-relative x=$value is outside the observed window." }
    return $currentBounds.Left + $value
  }
  function Window-Y([int]$value) {
    if ($value -lt 0 -or $value -ge [int]$observedBounds.height) { throw "Window-relative y=$value is outside the observed window." }
    return $currentBounds.Top + $value
  }
  $screenX = if ($null -ne $p.x) { Window-X ([int]$p.x) } else { 0 }
  $screenY = if ($null -ne $p.y) { Window-Y ([int]$p.y) } else { 0 }
  $screenToX = if ($null -ne $p.to_x) { Window-X ([int]$p.to_x) } else { 0 }
  $screenToY = if ($null -ne $p.to_y) { Window-Y ([int]$p.to_y) } else { 0 }
  if ($p.action -eq 'click' -or $p.action -eq 'drag') {
    $actualHwnd = [CardBushInput]::RootWindowAt($screenX, $screenY)
  } elseif ($p.action -eq 'scroll') {
    $actualHwnd = [CardBushInput]::RootWindowAt($screenX, $screenY)
  } else {
    $actualHwnd = [CardBushInput]::ForegroundWindow()
  }
  if ($actualHwnd -ne $expectedHwnd) {
    throw "Target window changed (expected hwnd=$expectedHwnd, actual hwnd=$actualHwnd). Observe again before sending input."
  }
}

$pointerRestored = $false
$pointerRestoreSkippedForUser = $false
$mouseAction = $p.action -eq 'click' -or $p.action -eq 'drag' -or $p.action -eq 'scroll'
$expectedPointerX = $pointer.x
$expectedPointerY = $pointer.y
try {
  switch ($p.action) {
    'click' { $expectedPointerX=$screenX;$expectedPointerY=$screenY;$b=if($p.button -eq 'right'){@(8,16)}elseif($p.button -eq 'middle'){@(32,64)}else{@(2,4)};$clicks=if($null -ne $p.clicks){[int]$p.clicks}else{1};[CardBushInput]::MovePointer($screenX,$screenY);1..$clicks|%{[CardBushInput]::mouse_event($b[0],0,0,0,[CardBushInput]::InputTag);[CardBushInput]::mouse_event($b[1],0,0,0,[CardBushInput]::InputTag)} }
    'scroll' { $expectedPointerX=$screenX;$expectedPointerY=$screenY;[CardBushInput]::MovePointer($screenX,$screenY);[CardBushInput]::mouse_event(2048,0,0,([int]$p.delta)*120,[CardBushInput]::InputTag) }
    'drag' { $expectedPointerX=$screenToX;$expectedPointerY=$screenToY;$steps=if($null -ne $p.steps){[int]$p.steps}else{20};$duration=if($null -ne $p.duration_ms){[int]$p.duration_ms}else{400};[CardBushInput]::Drag($screenX,$screenY,$screenToX,$screenToY,$steps,$duration) }
    'type' { [CardBushInput]::Text([string]$p.text) }
    'key' { $keys=@($p.keys);if($keys.Count -eq 0 -or $null -eq $keys[0]){$keys=@($p.key)};$codes=@($keys|%{KeyCode ([string]$_)});$codes|%{[CardBushInput]::Key($_,$true)};[array]::Reverse($codes);$codes|%{[CardBushInput]::Key($_,$false)} }
  }
} finally {
  if ($restorePointer -and $mouseAction) {
    $afterActionPointer = New-Object CardBushInput+POINT
    [void][CardBushInput]::GetCursorPos([ref]$afterActionPointer)
    if ($afterActionPointer.x -eq $expectedPointerX -and $afterActionPointer.y -eq $expectedPointerY) {
      [CardBushInput]::MovePointer($pointer.x, $pointer.y)
      $pointerRestored = $true
    } else {
      $pointerRestoreSkippedForUser = $true
    }
  }
}
[PSCustomObject]@{action=$p.action; input_mode='send_input'; coordinate_space=$p.coordinate_space; yielded_to_user=$false; input_wait_ms=$wait.ElapsedMilliseconds; pointer_restored=$pointerRestored; pointer_restore_skipped_for_user=$pointerRestoreSkippedForUser; foreground_hwnd=[CardBushInput]::ForegroundWindow(); last_input_tick=[CardBushInput]::LastInputTick()} | ConvertTo-Json -Compress`;

const desktopIdleScript = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CardBushUserIdle {
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
  public static uint LastInputTick(){LASTINPUTINFO info=new LASTINPUTINFO{cbSize=(uint)Marshal.SizeOf(typeof(LASTINPUTINFO))};if(!GetLastInputInfo(ref info))return 0;return info.dwTime;}
  public static uint IdleMilliseconds(){unchecked{return (uint)Environment.TickCount-LastInputTick();}}
}
'@
$expectedInputTick = [uint32]$env:CARDBUSH_EXPECTED_INPUT_TICK
$wait = [Diagnostics.Stopwatch]::StartNew()
$ready = $false
while (-not $ready -and $wait.ElapsedMilliseconds -lt 2400) {
  $lastInputTick = [CardBushUserIdle]::LastInputTick()
  $ready = (($expectedInputTick -ne 0) -and ($lastInputTick -eq $expectedInputTick)) -or ([CardBushUserIdle]::IdleMilliseconds() -ge 700)
  if (-not $ready) { Start-Sleep -Milliseconds 60 }
}
[PSCustomObject]@{ ready=$ready; input_wait_ms=$wait.ElapsedMilliseconds } | ConvertTo-Json -Compress`;

async function yieldForUserIfNeeded(
  config: ComputerUsePluginConfig,
  expectedInputTick: number | undefined,
  signal?: AbortSignal,
): Promise<void> {
  if (!config.yieldToUser) return;
  const result = record(json(await powershell(desktopIdleScript, {
    CARDBUSH_EXPECTED_INPUT_TICK: String(expectedInputTick ?? 0),
  }, signal)));
  if (result.ready !== true) throw new ComputerUseUserActiveError();
}

class ComputerUseUserActiveError extends Error {
  constructor() {
    super('Computer Use yielded because the user is actively using the mouse or keyboard. Wait for the user to finish, then call observe before continuing.');
    this.name = 'ComputerUseUserActiveError';
  }
}

async function powershell(
  script: string,
  extraEnv: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  const utf8Script = [
    "$ErrorActionPreference = 'Stop'",
    '$cardbushUtf8 = [System.Text.UTF8Encoding]::new($false)',
    '[Console]::InputEncoding = $cardbushUtf8',
    '[Console]::OutputEncoding = $cardbushUtf8',
    '$OutputEncoding = $cardbushUtf8',
    script,
  ].join('\n');
  const encodedCommand = Buffer.from(utf8Script, 'utf16le').toString('base64');
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    encodedCommand,
  ], {
    windowsHide: true,
    timeout: 15_000,
    signal,
    maxBuffer: 8 * 1024 * 1024,
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  });
  return stdout;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error('Computer Use was cancelled.');
  error.name = 'AbortError';
  throw error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isObservationAction(action: string): boolean {
  return action === 'observe' || action === 'screenshot';
}

function actionFingerprint(input: Record<string, unknown>): string {
  const stableInput = Object.fromEntries(
    Object.entries(input).filter(([key]) => key !== 'state_id'),
  );
  return JSON.stringify(canonicalValue(stableInput));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)]),
  );
}

function sameVisualState(left: string, right: string): boolean {
  if (!left || !right) return false;
  try {
    const leftBytes = Buffer.from(left, 'base64');
    const rightBytes = Buffer.from(right, 'base64');
    if (leftBytes.length === 0 || leftBytes.length !== rightBytes.length) return left === right;
    let totalDifference = 0;
    for (let index = 0; index < leftBytes.length; index += 1) {
      totalDifference += Math.abs(leftBytes[index] - rightBytes[index]);
    }
    return totalDifference / leftBytes.length <= 6;
  } catch {
    return left === right;
  }
}

function hasWindowSelector(input: Record<string, unknown>): boolean {
  return optionalInteger(input.hwnd) != null ||
    Boolean(optionalString(input.app)) ||
    Boolean(optionalString(input.title_pattern));
}

function windowBounds(value: unknown): ComputerUseWindowBounds {
  const bounds = recordOrEmpty(value);
  const x = optionalInteger(bounds.x);
  const y = optionalInteger(bounds.y);
  const width = optionalInteger(bounds.width);
  const height = optionalInteger(bounds.height);
  if (x == null || y == null || width == null || height == null || width <= 0 || height <= 0) {
    throw new Error('Target window capture returned invalid bounds.');
  }
  return { x, y, width, height };
}

function observedElements(value: unknown): ComputerUseObservedElement[] {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  return values.flatMap((item, fallbackIndex) => {
    const source = recordOrEmpty(item);
    const runtimeId = optionalString(source.runtime_id);
    if (!runtimeId) return [];
    const boundsSource = recordOrEmpty(source.bounds);
    const width = optionalInteger(boundsSource.width);
    const height = optionalInteger(boundsSource.height);
    const bounds = width != null && height != null && width > 0 && height > 0
      ? {
          x: optionalInteger(boundsSource.x) ?? 0,
          y: optionalInteger(boundsSource.y) ?? 0,
          width,
          height,
        }
      : undefined;
    return [{
      index: optionalInteger(source.index) ?? fallbackIndex,
      runtimeId,
      name: optionalString(source.name).slice(0, 240),
      automationId: optionalString(source.automation_id).slice(0, 160),
      controlType: optionalString(source.control_type).slice(0, 80),
      className: optionalString(source.class_name).slice(0, 120),
      enabled: source.enabled === true,
      focused: source.focused === true,
      offscreen: source.offscreen === true,
      password: source.password === true,
      ...(bounds ? { bounds } : {}),
      patterns: stringArray(source.patterns).map((pattern) => pattern.slice(0, 80)).slice(0, 20),
      ...(source.password === true ? {} : optionalField('value', source.value, 800)),
      ...optionalField('state', source.state, 80),
      ...(typeof source.read_only === 'boolean' ? { readOnly: source.read_only } : {}),
    }];
  });
}

function publicObservedElement(element: ComputerUseObservedElement) {
  return {
    index: element.index,
    name: element.name,
    automation_id: element.automationId,
    control_type: element.controlType,
    class_name: element.className,
    enabled: element.enabled,
    focused: element.focused,
    offscreen: element.offscreen,
    password: element.password,
    ...(element.bounds ? { bounds: element.bounds } : {}),
    patterns: element.patterns,
    ...(element.value !== undefined ? { value: element.value } : {}),
    ...(element.state !== undefined ? { state: element.state } : {}),
    ...(element.readOnly !== undefined ? { read_only: element.readOnly } : {}),
  };
}

function accessibilityFingerprint(elements: ComputerUseObservedElement[]): string {
  if (elements.length === 0) return '';
  const semanticState = elements.map((element) => ({
    runtimeId: element.runtimeId,
    name: element.name,
    automationId: element.automationId,
    controlType: element.controlType,
    enabled: element.enabled,
    focused: element.focused,
    offscreen: element.offscreen,
    password: element.password,
    bounds: element.bounds,
    patterns: element.patterns,
    value: element.value,
    state: element.state,
    readOnly: element.readOnly,
  }));
  return createHash('sha256').update(JSON.stringify(semanticState)).digest('base64url');
}

function windowListFingerprint(windows: Array<Record<string, unknown>>): string {
  const identity = windows
    .map((window) => ({
      hwnd: optionalInteger(window.hwnd) ?? 0,
      processId: optionalInteger(window.process_id) ?? 0,
      processName: optionalString(window.process_name),
      title: optionalString(window.title),
    }))
    .sort((left, right) => left.hwnd - right.hwnd);
  return createHash('sha256').update(JSON.stringify(identity)).digest('base64');
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return typeof value === 'string' && value ? [value] : [];
}

function optionalField(
  key: 'value' | 'state',
  value: unknown,
  limit: number,
): Partial<Pick<ComputerUseObservedElement, 'value' | 'state'>> {
  if (typeof value !== 'string') return {};
  return { [key]: value.slice(0, limit) };
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function plain(output: unknown): ComputerUseResult {
  return { output, paths: [], artifacts: [] };
}

function json(value: string): unknown {
  return JSON.parse(value.trim());
}

function requiredString(value: unknown, label: string): string {
  const result = typeof value === 'string' ? value.trim() : '';
  if (!result) throw new Error(`${label} is required.`);
  return result;
}

function optionalString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function optionalInteger(value: unknown): number | undefined {
  if (value == null || value === '') return undefined;
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error('Expected a safe integer.');
  return result;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a structured desktop result.');
  }
  return value as Record<string, unknown>;
}

function ensureWindows(): void {
  if (process.platform !== 'win32') throw new Error('computer_use currently requires Windows.');
}
