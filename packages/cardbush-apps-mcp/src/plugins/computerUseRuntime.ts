import { mkdir, stat } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import type { ComputerUsePluginConfig } from '../config.js';
import { computerUsePresentation } from './computerUsePresentation.js';
import { computerUseCaptureLayersScript } from './computerUseCaptureLayers.js';
import { computerUseAccessibilityScript } from './computerUseAccessibility.js';
import { ComputerUseFailure, computerUseFailure, type ComputerUseFailureInfo } from './computerUseErrors.js';
import { setTimeout as delay } from 'node:timers/promises';
import { computerUsePowerShellParameters, runComputerUsePowerShell } from './computerUsePowerShell.js';
import { computerUseVisualProgressScript, hasVisualProgress, type ProgressEvidence, type ProgressBounds } from './computerUseProgress.js';
import { prepareComputerUseNativeCode } from './computerUseNativeCode.js';
import { collectComputerUseTimings, type ComputerUseTimings } from './computerUseTimings.js';
import { computerUseImageScript, saveComputerUseImageScript } from './computerUseImage.js';
import { computerUseDisplaysScript, computerUseDisplayGuardScript } from './computerUseDisplays.js';

export interface ComputerUseArtifact {
  artifact_id: string;
  type: string;
  path: string;
  media_type: string;
  display: 'inline' | 'attachment' | 'hidden';
  metadata: Record<string, unknown>;
}

export interface ComputerUseResult {
  output: unknown;
  paths: string[];
  artifacts: ComputerUseArtifact[];
  error?: ComputerUseFailureInfo;
  timings?: ComputerUseTimings;
}

type ComputerUseWindowBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type ComputerUseObservedElement = {
  index: number;
  resultOffset: number;
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
  ownerHwnd?: number;
  focusedBounds?: ComputerUseWindowBounds;
  displaySignature?: string;
  windowDpi?: number;
  visualVerified?: boolean;
};

type ComputerUseSafetyState = {
  busy: boolean;
  touchedAt: number;
  actionsSinceObservation: number;
  lastActionFingerprint: string;
  repeatedActionCount: number;
  preflightFailures: number;
  unchangedActionCycles: number;
  observationsWithoutAction: number;
  mustObserveAfterYield: boolean;
  userYieldCount: number;
  expectedInputTick?: number;
  observation?: ComputerUseObservationBinding;
  observations: Map<string, { visual: string; evidence: ProgressEvidence }>;
  pending?: { target?: string; visual: string; evidence?: ProgressEvidence; region?: ProgressBounds };
  lastRegion?: { target: string; bounds: ProgressBounds };
  uncertainActionCycles: number;
  lastAttemptDispatched: boolean;
  review: 'none' | 'required' | 'ready' | 'used';
  terminal?: ComputerUseFailure;
};

const maxActionsWithoutObservation = 3;
const maxRepeatedActionAttempts = 2;
const maxPreflightFailures = 6;
const maxUserYields = 2;
const maxPassiveObservations = 6;
const maxUnverifiedActions = 4;
const safetyStateTtlMs = 20 * 60_000;
const observationStateTtlMs = 30_000;

class ComputerUseDesktopBusyError extends Error {}

/** Session-scoped coordination for physical desktop input. */
export class ComputerUseSafetyGuard {
  readonly #states = new Map<string, ComputerUseSafetyState>();
  #activeScope = '';
  #desktopGeneration = 0;

  recordApplicationControlBlock(scopeId: string, failure: ComputerUseFailure): void {
    const state = this.#state(scopeId);
    state.terminal = new ComputerUseFailure('application_control_blocked', failure.message,
      'not_dispatched', { ...failure.info.details, terminal: true });
    state.observation = undefined;
    state.pending = undefined;
    state.observations.clear();
    state.lastRegion = undefined;
  }

  begin(scopeId: string, input: Record<string, unknown>): () => void {
    if (!scopeId) return () => undefined;
    this.#cleanup();
    const state = this.#state(scopeId);
    if (this.#activeScope || state.busy) {
      throw new ComputerUseDesktopBusyError('Another Computer Use action is already using the desktop. Wait for it to finish, then observe before continuing.');
    }
    const action = String(input.action ?? '').trim();
    if (state.terminal) throw state.terminal;
    if (isObservationAction(action)) {
      if (state.observationsWithoutAction >= maxPassiveObservations) {
        this.#stop(state, 'observation_loop', 'Computer Use stopped a repeated observation loop. Return to the user instead of polling again.');
      }
    } else {
      if (state.userYieldCount >= maxUserYields) {
        this.#stop(state, 'repeated_takeover', 'Computer Use yielded to the user repeatedly and ended desktop control for this turn.');
      }
      if (state.mustObserveAfterYield) {
        throw new ComputerUseFailure('observation_required', 'Computer Use yielded to user input. Let the user finish, then observe the target once.');
      }
      if (state.actionsSinceObservation >= maxActionsWithoutObservation) {
        throw new ComputerUseFailure('observation_required', `Computer Use paused after ${maxActionsWithoutObservation} actions without observation. Observe the target before continuing.`);
      }
      const fingerprint = actionFingerprint(input);
      if (
        fingerprint === state.lastActionFingerprint &&
        state.repeatedActionCount >= maxRepeatedActionAttempts
      ) {
        if (state.lastAttemptDispatched) {
          this.#stop(state, 'repeated_action', 'Computer Use stopped a repeated action loop. The same action has already been dispatched twice without verified progress.');
        }
        throw new ComputerUseFailure('invalid_action', 'The same action failed preflight twice. Observe and choose a different corrective action; no input was dispatched.', 'not_dispatched', { reason: 'repeated_preflight' });
      }
      if (state.uncertainActionCycles >= maxRepeatedActionAttempts || state.review === 'used') {
        this.#stop(state, 'unverified_execution', 'Computer Use stopped because execution still has no verified progress. Report the blocker instead of replaying input.');
      }
      if (state.preflightFailures >= maxPreflightFailures) {
        this.#stop(state, 'preflight_limit', 'Computer Use stopped after repeated preflight rejections. Report the blocker and wait for a new user request.');
      }
      if (state.unchangedActionCycles >= maxUnverifiedActions && state.review !== 'ready') {
        state.review = 'required';
        state.observation = undefined;
        throw new ComputerUseFailure('progress_unverified', 'Progress could not be verified. Observe the same target once, inspect what actually happened, then choose one different corrective action.', 'not_dispatched', { target: state.pending?.target });
      }
      if (state.review === 'ready' && fingerprint === state.lastActionFingerprint) {
        throw new ComputerUseFailure('progress_unverified', 'The review permits a different corrective action, not a replay of the last input.', 'not_dispatched', { target: state.pending?.target });
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
    evidence: ProgressEvidence,
  ): void {
    if (!scopeId) return;
    const state = this.#state(scopeId);
    if (state.terminal) return;
    state.observationsWithoutAction += 1;
    state.observation = undefined;
    // Discovery, another window, and changing UIA filters are not evidence that
    // an input succeeded. Preserve the action's original comparison baseline.
    if (evidence.source !== 'window' || !evidence.target || evidence.consistent === false) return;
    const pending = state.pending;
    const sameTarget = pending?.target === evidence.target;
    const before = sameTarget ? pending?.evidence : undefined;
    const changed = Boolean(pending && (
      evidence.relatedTransition || (sameTarget && before && (
        hasVisualProgress(pending.visual, visualFingerprint, evidence.bounds, pending.region) ||
        (before.focusedFingerprint && evidence.focusedFingerprint && before.focusedFingerprint !== evidence.focusedFingerprint) ||
        (before.bounds && evidence.bounds && ['x', 'y', 'width', 'height'].some((key) => before.bounds![key as keyof ProgressBounds] !== evidence.bounds![key as keyof ProgressBounds])) ||
        (before.foreground === false && evidence.foreground === true)
      ))
    ));
    state.observations.set(evidence.target, { visual: visualFingerprint, evidence });
    if (state.observations.size > 16) state.observations.delete(state.observations.keys().next().value!);
    state.actionsSinceObservation = 0;
    state.mustObserveAfterYield = false;
    if (changed) {
      state.unchangedActionCycles = 0;
      state.uncertainActionCycles = 0;
      state.review = 'none';
      state.lastActionFingerprint = '';
      state.repeatedActionCount = 0;
      state.pending = undefined;
    } else if (state.review === 'required' && sameTarget && evidence.explicit) {
      state.review = 'ready';
    }
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
    observation?: ComputerUseObservationBinding,
  ): void {
    if (!scopeId) return;
    const state = this.#state(scopeId);
    const fingerprint = actionFingerprint(input);
    const target = observation ? `${observation.processId ?? 0}:${observation.hwnd}` : undefined;
    const baseline = target ? state.observations.get(target) : undefined;
    const region = observation ? actionRegion(input, observation, target === state.lastRegion?.target ? state.lastRegion?.bounds : undefined) : undefined;
    if (target && region) state.lastRegion = { target, bounds: region };
    state.pending = { target, visual: baseline?.visual ?? '', evidence: baseline?.evidence, region };
    state.actionsSinceObservation += 1;
    // Clipboard contents are verified independently. Setting them is not an
    // attempted visual transition, and must not spend the UI progress budget.
    if (input.action !== 'clipboard' || !successful) state.unchangedActionCycles += 1;
    if (!successful) state.uncertainActionCycles += 1;
    if (state.review === 'ready') state.review = 'used';
    state.observationsWithoutAction = 0;
    state.lastAttemptDispatched = true;
    state.repeatedActionCount = fingerprint === state.lastActionFingerprint
      ? state.repeatedActionCount + 1
      : 1;
    state.lastActionFingerprint = fingerprint;
    this.#desktopGeneration += 1;
    state.observation = undefined;
    if (successful) {
      state.userYieldCount = 0;
      state.preflightFailures = 0;
    }
    state.touchedAt = Date.now();
  }

  recordPreflightFailure(scopeId: string, input: Record<string, unknown>): void {
    if (!scopeId) return;
    const state = this.#state(scopeId);
    const fingerprint = actionFingerprint(input);
    state.preflightFailures += 1;
    state.lastAttemptDispatched = false;
    state.repeatedActionCount = fingerprint === state.lastActionFingerprint
      ? state.repeatedActionCount + 1
      : 1;
    state.lastActionFingerprint = fingerprint;
    // No target action was dispatched. Allow a fresh observation and a different
    // corrective action without inventing an unchanged desktop action cycle.
    // The separate rejection budget still bounds alternating invalid attempts.
    state.observationsWithoutAction = 0;
    state.observation = undefined;
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
      preflightFailures: 0,
      unchangedActionCycles: 0,
      observationsWithoutAction: 0,
      mustObserveAfterYield: false,
      userYieldCount: 0,
      observations: new Map(),
      uncertainActionCycles: 0,
      lastAttemptDispatched: false,
      review: 'none',
    };
    this.#states.set(scopeId, created);
    return created;
  }

  #stop(state: ComputerUseSafetyState, reason: string, message: string): never {
    state.terminal = new ComputerUseFailure('policy_blocked', message, 'not_dispatched', { reason, terminal: true });
    state.observation = undefined;
    state.pending = undefined;
    state.observations.clear();
    state.lastRegion = undefined;
    throw state.terminal;
  }

  #cleanup(): void {
    const cutoff = Date.now() - safetyStateTtlMs;
    for (const [scopeId, state] of this.#states) {
      // Expiring bulky idle observations must not revive a blocked turn. The
      // terminal entry is small (its image baselines were released by #stop).
      if (!state.busy && !state.terminal && state.touchedAt < cutoff) this.#states.delete(scopeId);
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
  const { value, timings } = await collectComputerUseTimings(() => executeComputerUseRequest(input, config, signal, scopeId));
  return { ...value, timings };
}

async function executeComputerUseRequest(
  input: Record<string, unknown>, config: ComputerUsePluginConfig, signal: AbortSignal | undefined, scopeId: string,
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
  catch (error) {
    // A rejected concurrent caller does not own the active operation's lease.
    if (!(error instanceof ComputerUseDesktopBusyError)) await computerUsePresentation.hold(scopeId).catch(() => undefined);
    throw computerUseFailure(error);
  }
  let presentationAction: Awaited<ReturnType<typeof computerUsePresentation.action>> | undefined;
  let actionMayHaveDispatched = false;
  let actionRecorded = false;
  let actionObservation: ComputerUseObservationBinding | undefined;
  let nativeAction: NativeActionContext | undefined;
  const requestSignal = signal;
  const releaseAction = async () => {
    await presentationAction?.release().catch(() => undefined);
    presentationAction = undefined;
  };
  const acknowledgeAction = async (output: Record<string, unknown>) => {
    if (actionRecorded) return;
    computerUseSafety.recordAction(scopeId, input, true, actionObservation);
    actionRecorded = true;
    computerUseSafety.recordInputTick(scopeId, output.last_input_tick);
    await releaseAction();
  };
  const prepareAction = (previous: ComputerUseObservationBinding): NativeActionContext => ({
    input, config, previous, acknowledge: acknowledgeAction,
  });
  const completeAction = async (output: Record<string, unknown>): Promise<ComputerUseResult> => {
    await acknowledgeAction(output);
    return observeAfterAction(input, config, scopeId, actionObservation!, output, requestSignal, nativeAction);
  };
  try {
    if (action === 'observe' || action === 'screenshot') {
      if (hasWindowSelector(input)) {
        const exactHwnd = optionalInteger(input.hwnd);
        const target = exactHwnd != null
          ? { hwnd: exactHwnd }
          : selectWindowTarget(
              await listWindows(signal) as Array<Record<string, unknown>>,
              input,
            );
        // Keep the desktop lease and cleanup until the capture actually settles.
        return await observeWindow(input, config, scopeId, target, signal);
      }
      const desktop = await readDesktopState(signal);
      const windows = desktop.windows as Array<Record<string, unknown>>;
      if (action === 'observe' && !input.display_id) {
        const discoveryFingerprint = windowListFingerprint(windows);
        computerUseSafety.recordObservation(
          scopeId,
          discoveryFingerprint,
          { source: 'discovery' },
        );
        return plain({
          windows,
          displays: desktop.displays,
          display_signature: desktop.display_signature,
          actionable: false,
          capture_performed: false,
          next_step: 'Choose exactly one window and observe its hwnd. For a screen overview use screenshot with an exact display_id. Display bounds and window input use physical pixels.',
        });
      }
      const capture = await captureDesktop(config.screenshotDirectory, signal, optionalString(input.display_id));
      computerUseSafety.recordObservation(scopeId, capture.visualFingerprint, { source: 'desktop' });
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
      actionMayHaveDispatched = true;
      const launch = record(json(await powershell(`${windowListScript}\n${openApplicationScript}`, {
        CARDBUSH_APP_TARGET: app,
      }, signal)));
      computerUseSafety.recordAction(scopeId, input);
      return plain({
        action, app, launch,
        actionable: false,
        next_step: 'Launch was dispatched, not verified ready. Observe an exact window_check candidate hwnd before input. If unconfirmed, discover windows; do not launch again blindly.',
      });
    }
    if (action === 'window') {
      const observation = computerUseSafety.claimObservation(scopeId, input);
      actionObservation = observation;
      nativeAction = prepareAction(observation);
      if (String(input.operation ?? '').trim().toLowerCase() === 'close' && !config.allowWindowClose) {
        throw new Error('Closing windows is disabled in Computer Use settings.');
      }
      await yieldForUserIfNeeded(config, computerUseSafety.expectedInputTick(scopeId), signal);
      presentationAction = await computerUsePresentation.action(scopeId, input, observation, signal);
      signal = presentationAction.signal;
      actionMayHaveDispatched = true;
      const output = await controlWindow(input, observation, signal, nativeAction);
      return await completeAction(output);
    }
    if (['click', 'invoke', 'set_value', 'type', 'clipboard', 'key', 'scroll', 'drag'].includes(action)) {
      const observation = computerUseSafety.claimObservation(scopeId, input);
      actionObservation = observation;
      nativeAction = prepareAction(observation);
      if (action === 'clipboard') await validateClipboardInput(input);
      const semanticAction = action === 'invoke' || action === 'set_value' ||
        (action === 'click' && optionalInteger(input.element_index) != null);
      if (semanticAction) validateAccessibilityAction(action, input, observation);
      presentationAction = await computerUsePresentation.action(scopeId, input, observation, signal);
      signal = presentationAction.signal;
      actionMayHaveDispatched = true;
      if (semanticAction) {
        const output = await runAccessibilityAction(
          action,
          input,
          observation,
          config,
          computerUseSafety.expectedInputTick(scopeId),
          signal,
          nativeAction,
        );
        return await completeAction(output);
      }
      const output = await runInput(
        action,
        input,
        observation,
        config,
        computerUseSafety.expectedInputTick(scopeId),
        signal,
        nativeAction,
      );
      return await completeAction(output);
    }
    throw new Error(`Unsupported computer_use action: ${action}`);
  } catch (error) {
    if (requestSignal?.aborted || isAbortError(error)) throw error;
    const interruption = computerUsePresentation.interruption(scopeId);
    const failure = computerUseFailure(
      interruption?.info.code === 'user_takeover' || interruption?.info.code === 'user_stopped' ? interruption : error,
      actionRecorded ? 'dispatched' : actionMayHaveDispatched ? 'unknown' : 'not_dispatched',
    );
    if (failure.info.code === 'application_control_blocked') computerUseSafety.recordApplicationControlBlock(scopeId, failure);
    if (failure.info.code === 'user_takeover') {
      computerUseSafety.recordUserYield(scopeId);
    } else if (!isObservationAction(action) && !actionRecorded) {
      // Once dispatched, failed input may have partially reached the desktop.
      // Presentation/state validation failures occur before target input starts.
      if (actionMayHaveDispatched) computerUseSafety.recordAction(scopeId, input, false, actionObservation);
      else computerUseSafety.recordPreflightFailure(scopeId, input);
    }
    await releaseAction();
    if (input.observe_after !== false && actionObservation && actionMayHaveDispatched &&
        (failure.info.code === 'window_changed' || failure.info.code === 'window_unavailable')) {
      // A click may have opened a dialog before its ACK arrived. Return evidence,
      // never replay the click. This consumes no human-takeover budget.
      const recovery = await observeAfterAction(input, config, scopeId, actionObservation,
        { action, execution: failure.info.execution }, requestSignal);
      return { ...recovery, error: failure.info };
    }
    if (failure.info.code === 'user_takeover') {
      await computerUsePresentation.pause(scopeId).catch(() => undefined);
    } else if (['user_stopped', 'control_unavailable', 'application_control_blocked'].includes(failure.info.code)) {
      await computerUsePresentation.finish(scopeId).catch(() => undefined);
    } else {
      await computerUsePresentation.hold(scopeId).catch(() => undefined);
    }
    throw failure;
  } finally {
    await presentationAction?.release().catch(() => undefined);
    if (requestSignal?.aborted) await computerUsePresentation.finish(scopeId).catch(() => undefined);
    // A killed capture cannot run its PowerShell finally block. Clear its mask
    // even after cancellation; native active/closing state controls visibility.
    await computerUsePresentation.restore().catch(() => undefined);
    release();
  }
}

const openApplicationScript = String.raw`
$requested = $script:CARDBUSH_APP_TARGET.Trim()
if (-not $requested) { throw 'Application target is empty.' }

function Get-CardBushLaunchWindows { @([CardBushWindowList]::Read()) }

function Complete-CardBushLaunch([string]$target, [string]$resolution, $processId, [string]$workingDirectory, $before, [bool]$beforeAvailable) {
  $candidates = @()
  $status = 'unconfirmed'
  $checkError = $null
  $watch = [Diagnostics.Stopwatch]::StartNew()
  $names = @([IO.Path]::GetFileNameWithoutExtension($requested))
  if ($resolution -ne 'start_app') { $names += [IO.Path]::GetFileNameWithoutExtension($target) }
  try {
    do {
      $candidates = @(Get-CardBushLaunchWindows | ForEach-Object {
        $item = $_
        $match = if ($null -ne $processId -and $item.process_id -eq $processId) { 'process_id' }
          elseif ($names -icontains $item.process_name) { 'process_name' } else { $null }
        if ($match) {
          $existed = if ($beforeAvailable) { @($before | Where-Object { $_.hwnd -eq $item.hwnd -and $_.process_id -eq $item.process_id }).Count -gt 0 } else { $null }
          [PSCustomObject]@{ hwnd=$item.hwnd; process_id=$item.process_id; process_name=$item.process_name; title=$item.title; match_basis=$match; existed_before_launch=$existed }
        }
      })
      if (@($candidates | Where-Object { $_.existed_before_launch -eq $false }).Count -gt 0) {
        $status = 'new_window_observed'
        break
      }
      if ($watch.ElapsedMilliseconds -ge 1500) { break }
      Start-Sleep -Milliseconds 100
    } while ($true)
    if ($status -eq 'unconfirmed' -and $beforeAvailable -and $candidates.Count -gt 0) { $status = 'existing_window_candidate' }
  } catch {
    $checkError = 'Window inspection was unavailable after launch. Discover windows before input or another launch.'
  }
  [PSCustomObject]@{
    requested = $requested
    target = $target
    resolution = $resolution
    process_id = $processId
    working_directory = $workingDirectory
    dispatched = $true
    window_check = [PSCustomObject]@{ status=$status; candidates=@($candidates); elapsed_ms=$watch.ElapsedMilliseconds; error=$checkError }
  } | ConvertTo-Json -Depth 5 -Compress
  exit 0
}

function Launch-CardBushApplication([string]$target, [string]$resolution) {
  $workingDirectory = (Get-Location).Path
  # Keep a resolved executable's own directory; shell shortcuts retain their launch semantics.
  if ([IO.Path]::GetExtension($target) -ieq '.exe') {
    $parent = [IO.Path]::GetDirectoryName($target)
    if ($parent -and (Test-Path -LiteralPath $parent -PathType Container)) { $workingDirectory = $parent }
  }
  $beforeAvailable = $true
  try { $before = @(Get-CardBushLaunchWindows) } catch { $before = @(); $beforeAvailable = $false }
  $process = Start-Process -FilePath $target -WorkingDirectory $workingDirectory -PassThru
  $processId = if ($null -ne $process) { $process.Id } else { $null }
  Complete-CardBushLaunch $target $resolution $processId $workingDirectory $before $beforeAvailable
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
  $workingDirectory = (Get-Location).Path
  $beforeAvailable = $true
  try { $before = @(Get-CardBushLaunchWindows) } catch { $before = @(); $beforeAvailable = $false }
  Start-Process -FilePath 'explorer.exe' -ArgumentList "shell:AppsFolder\$appId" -WorkingDirectory $workingDirectory
  Complete-CardBushLaunch $appId 'start_app' $null $workingDirectory $before $beforeAvailable
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

async function captureDesktop(configuredDirectory: string, signal?: AbortSignal, displayId = '') {
  const directory = configuredDirectory || process.env.CARDBUSH_OWNED_CAPTURE_ROOT || join(tmpdir(), 'cardbush-apps', 'captures');
  await mkdir(directory, { recursive: true });
  const path = join(directory, `capture-${Date.now()}-${randomUUID()}.png`);
  const script = String.raw`
${computerUseDisplaysScript}
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$displays = [CardBushDesktop]::Read()
$displaySignature = [CardBushDesktop]::Signature($displays)
if ($script:CARDBUSH_DISPLAY_ID) {
  $selected = @($displays | Where-Object { $_.id -ceq $script:CARDBUSH_DISPLAY_ID })
  if ($selected.Count -ne 1) { throw 'Display is no longer available. Observe connected displays again.' }
  $b = $selected[0].bounds
  $bounds = [Drawing.Rectangle]::new($b.x,$b.y,$b.width,$b.height)
}
if ([long]$bounds.Width*$bounds.Height -gt 64000000) { throw 'Desktop capture exceeds 64 megapixels. Select one display_id.' }
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
  $hiddenLayers = [CardBushCaptureLayers]::Hide([IntPtr]::Zero)
  try {
    if ($hiddenLayers.Length -gt 0) { [void][CardBushCaptureLayers]::DwmFlush() }
    $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bounds.Size)
  } finally { [CardBushCaptureLayers]::Restore($hiddenLayers) }
  [CardBushDesktop]::AssertUnchanged($displaySignature,[IntPtr]::Zero,0)
  $bitmap.Save($script:CARDBUSH_CAPTURE_PATH, [System.Drawing.Imaging.ImageFormat]::Png)
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
    [PSCustomObject]@{ path=$script:CARDBUSH_CAPTURE_PATH; x=$bounds.Left; y=$bounds.Top; width=$bounds.Width; height=$bounds.Height;
      displays=$displays; display_id=$script:CARDBUSH_DISPLAY_ID; display_signature=$displaySignature;
      image=@{origin=@{x=$bounds.Left;y=$bounds.Top};scale=1;width=$bounds.Width;height=$bounds.Height;coordinate_space='desktop'};
      visual_fingerprint=[Convert]::ToBase64String($fingerprint) } | ConvertTo-Json -Depth 6 -Compress
  } finally {
    $sampleGraphics.Dispose()
    $sample.Dispose()
  }
} finally {
  $graphics.Dispose()
  $bitmap.Dispose()
}`;
  const rawOutput = record(json(await powershell(
    `${computerUseCaptureLayersScript}\n${script}`,
    { CARDBUSH_CAPTURE_PATH: path, CARDBUSH_DISPLAY_ID: displayId },
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

type WindowCaptureOptions = {
  includeScreenshot?: boolean; followOwnedWindow?: boolean; expectedProcessId?: number; ownerHwnd?: number;
  elementQuery?: unknown; elementOffset?: number; region?: unknown; scale?: unknown; grid?: unknown;
};
type PreparedWindowCapture = { path: string; raw: Record<string, unknown> };
type NativeActionContext = {
  input: Record<string, unknown>; config: ComputerUsePluginConfig; previous: ComputerUseObservationBinding;
  acknowledge: (output: Record<string, unknown>) => Promise<void>;
  acknowledgement?: Record<string, unknown>; capture?: PreparedWindowCapture; observationError?: unknown;
};

function prepareWindowCapture(
  configuredDirectory: string, hwnd: number, includeAccessibility: boolean, maxElements: number, options: WindowCaptureOptions,
) {
  const directory = configuredDirectory || process.env.CARDBUSH_OWNED_CAPTURE_ROOT || join(tmpdir(), 'cardbush-apps', 'captures');
  const path = join(directory, `window-${hwnd}-${Date.now()}-${randomUUID()}.png`);
  return { path, parameters: {
    CARDBUSH_CAPTURE_PATH: path,
    CARDBUSH_WINDOW_HWND: String(hwnd),
    CARDBUSH_INCLUDE_ACCESSIBILITY: includeAccessibility ? '1' : '0',
    CARDBUSH_MAX_ELEMENTS: String(maxElements),
    CARDBUSH_ELEMENT_QUERY: JSON.stringify(options.elementQuery ?? {}),
    CARDBUSH_ELEMENT_OFFSET: String(options.elementOffset ?? 0),
    CARDBUSH_INCLUDE_SCREENSHOT: options.includeScreenshot === false ? '0' : '1',
    CARDBUSH_FOLLOW_OWNED_WINDOW: options.followOwnedWindow ? '1' : '0',
    CARDBUSH_EXPECTED_WINDOW_PID: String(options.expectedProcessId ?? 0),
    CARDBUSH_OBSERVED_OWNER_HWND: String(options.ownerHwnd ?? 0),
    CARDBUSH_IMAGE_OPTIONS: JSON.stringify({ region: options.region, scale: options.scale, grid: options.grid }),
  } };
}

async function captureWindowState(
  configuredDirectory: string,
  target: Record<string, unknown>,
  includeAccessibility: boolean,
  maxElements: number,
  signal?: AbortSignal,
  options: WindowCaptureOptions = {},
  prepared?: PreparedWindowCapture,
) {
  const hwnd = optionalInteger(target.hwnd);
  if (hwnd == null || hwnd <= 0) throw new Error('Target window does not have a valid hwnd.');
  const request = prepared ?? prepareWindowCapture(configuredDirectory, hwnd, includeAccessibility, maxElements, options);
  const path = request.path;
  const rawOutput = 'raw' in request ? request.raw : record(json(await powershell(windowObservationScript, request.parameters, signal)));
  const visualFingerprint = optionalString(rawOutput.visual_fingerprint);
  const bounds = windowBounds(rawOutput.bounds);
  const capturedWindow = recordOrEmpty(rawOutput.window);
  const capturedHwnd = optionalInteger(capturedWindow.hwnd);
  if (!capturedHwnd || (capturedHwnd !== hwnd && !options.followOwnedWindow)) {
    throw new Error('Target window identity changed during capture. Observe again.');
  }
  const window: Record<string, unknown> = { ...target, ...capturedWindow, hwnd: capturedHwnd };
  const elements = includeAccessibility
    ? observedElements(recordOrEmpty(rawOutput.accessibility).elements)
    : [];
  const foregroundHwnd = optionalInteger(rawOutput.foreground_hwnd) ?? 0;
  const isForeground = foregroundHwnd === capturedHwnd;
  const consistent = rawOutput.capture_consistent !== false;
  const accessibilityRecord = recordOrEmpty(rawOutput.accessibility);
  const focusedBounds = rawOutput.focused_bounds ? windowBounds(rawOutput.focused_bounds) : undefined;
  // Leave room for state, window identity and recovery information in the model
  // result. A long document's UIA values must not bury the one-use state token.
  const publicElements: ReturnType<typeof publicObservedElement>[] = [];
  let elementCharacters = 0;
  for (const element of elements) {
    const item = publicObservedElement(element);
    const size = JSON.stringify(item).length;
    if (elementCharacters + size > 10_000) break;
    publicElements.push(item);
    elementCharacters += size;
  }
  const nextOffset = publicElements.length < elements.length
    ? elements[publicElements.length]!.resultOffset
    : optionalInteger(accessibilityRecord.next_offset);
  const accessibility = includeAccessibility
    ? {
        available: accessibilityRecord.available === true,
        total_elements: optionalInteger(accessibilityRecord.total_elements) ?? elements.length,
        matched_elements: optionalInteger(accessibilityRecord.matched_elements) ?? elements.length,
        offset: options.elementOffset ?? 0,
        returned_elements: publicElements.length,
        truncated: nextOffset != null || accessibilityRecord.scan_truncated === true,
        ...(options.elementQuery ? { query: options.elementQuery } : {}),
        ...(nextOffset != null ? { next_offset: nextOffset, next_step: 'For a specific control use element_query (name, automation_id, control_type or focused). Otherwise continue with element_offset=next_offset. Each observation replaces state_id and element indexes.' } : {}),
        ...(accessibilityRecord.scan_truncated === true ? { scan_truncated: true, next_step: 'The UIA scan reached its 5000-element limit. Navigate the visible UI to narrow the tree; do not keep increasing max_elements.' } : {}),
        ...(optionalString(accessibilityRecord.error)
          ? { error: optionalString(accessibilityRecord.error) }
          : {}),
        elements: publicElements,
      }
    : undefined;
  const output = {
    ...(options.includeScreenshot === false ? {} : { path }),
    window,
    requested_hwnd: hwnd,
    target_relation: optionalString(rawOutput.target_relation) || 'target',
    foreground_window: rawOutput.foreground_window,
    bounds,
    displays: rawOutput.displays,
    display_signature: rawOutput.display_signature,
    display_id: rawOutput.display_id,
    window_dpi: rawOutput.window_dpi,
    ...(options.includeScreenshot === false ? {} : { image: rawOutput.image }),
    capture_method: optionalString(rawOutput.capture_method) || 'unknown',
    capture_quality: rawOutput.capture_quality,
    visual_evidence_verified: rawOutput.visual_evidence_verified !== false,
    foreground_hwnd: foregroundHwnd,
    is_foreground: isForeground,
    capture_consistent: consistent,
    actionable: consistent && isForeground && rawOutput.visual_evidence_verified !== false,
    window_action_available: consistent,
    ...(!consistent ? { next_step: 'Foreground changed during capture. Observe the intended target again before any action.' }
      : !isForeground ? { next_step: 'The target is in the background. Use window/activate with its state_id and hwnd, then inspect the returned observation. Observe alone never activates a window.' }
      : rawOutput.visual_evidence_verified === false ? { next_step: 'The window image is uniformly blank and could not be verified while visible. Uncover the target and observe again before coordinate input; UIA actions require observed elements.' } : {}),
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
      target_hwnd: capturedHwnd,
      image: rawOutput.image,
    },
  };
  const binding: Omit<ComputerUseObservationBinding, 'stateId' | 'generation' | 'createdAt'> = {
    hwnd: capturedHwnd,
    processId: optionalInteger(window.process_id),
    processName: optionalString(window.process_name),
    title: optionalString(window.title),
    bounds,
    elements: elements.slice(0, publicElements.length),
    ownerHwnd: optionalInteger(window.owner_hwnd),
    focusedBounds,
    displaySignature: optionalString(rawOutput.display_signature),
    windowDpi: optionalInteger(rawOutput.window_dpi),
    visualVerified: rawOutput.visual_evidence_verified !== false,
  };
  return {
    path,
    output,
    artifact,
    visualFingerprint,
    progressEvidence: {
      source: 'window', target: `${binding.processId ?? 0}:${binding.hwnd}`, bounds,
      focusedBounds, focusedFingerprint: optionalString(rawOutput.focused_fingerprint),
      foreground: isForeground, consistent,
    } satisfies ProgressEvidence,
    binding,
  };
}

async function observeWindow(
  input: Record<string, unknown>, config: ComputerUsePluginConfig, scopeId: string,
  target: Record<string, unknown>, signal?: AbortSignal, previous?: ComputerUseObservationBinding,
  prepared?: PreparedWindowCapture,
): Promise<ComputerUseResult> {
  const includeScreenshot = input.include_screenshot !== false;
  const capture = await captureWindowState(config.screenshotDirectory, target,
    input.include_text === true, optionalInteger(input.max_elements) ?? 80, signal, {
      includeScreenshot, followOwnedWindow: Boolean(previous),
      expectedProcessId: previous?.processId, ownerHwnd: previous?.ownerHwnd,
      elementQuery: input.element_query, elementOffset: optionalInteger(input.element_offset),
      region: input.region, scale: input.scale, grid: input.grid,
    }, prepared);
  if (!previous) selectWindowTarget([record(capture.output.window)], input);
  computerUseSafety.recordObservation(scopeId, capture.visualFingerprint, {
    ...capture.progressEvidence,
    explicit: !previous && input.action === 'observe',
    relatedTransition: Boolean(previous && ['owned_popup', 'owner_window'].includes(capture.output.target_relation)),
  });
  const interrupted = previous ? computerUsePresentation.interruption(scopeId) : undefined;
  const canBind = input.action !== 'screenshot' && capture.output.capture_consistent &&
    interrupted?.info.code !== 'user_takeover' && interrupted?.info.code !== 'user_stopped';
  let stateId: string | undefined;
  if (canBind) {
    await computerUsePresentation.observe(scopeId, capture.binding.hwnd);
    if (!computerUsePresentation.isPaused(scopeId)) stateId = computerUseSafety.bindObservation(scopeId, capture.binding);
  }
  const paused = computerUsePresentation.isPaused(scopeId);
  return {
    output: {
      ...(stateId ? { state_id: stateId, state_usage: 'one_action', state_ttl_ms: observationStateTtlMs } : {}),
      coordinate_space: 'window',
      ...capture.output,
      actionable: Boolean(stateId) && capture.output.actionable && !paused,
      window_action_available: Boolean(stateId) && !paused,
      ...(paused ? { control_state: 'user_takeover', next_step: 'Let the user finish, then observe once before further input.' } : {}),
      ...(interrupted?.info.code === 'user_stopped' ? { control_state: 'user_stopped', error: interrupted.info } : {}),
    },
    paths: includeScreenshot ? [capture.path] : [],
    artifacts: includeScreenshot ? [capture.artifact] : [],
  };
}

async function observeAfterAction(
  input: Record<string, unknown>, config: ComputerUsePluginConfig, scopeId: string,
  previous: ComputerUseObservationBinding, acknowledgement: Record<string, unknown>, signal?: AbortSignal,
  nativeAction?: NativeActionContext,
): Promise<ComputerUseResult> {
  const output = { ...acknowledgement, execution: acknowledgement.execution ?? 'dispatched' };
  if (input.observe_after === false) return plain({ ...output, next_step: 'Observe the target before further input.' });
  try {
    const interruption = computerUsePresentation.interruption(scopeId);
    if (interruption?.info.code === 'user_takeover' || interruption?.info.code === 'user_stopped') throw interruption;
    if (nativeAction?.observationError) throw nativeAction.observationError;
    if (!nativeAction?.capture) await delay(Math.max(0, Math.min(1000, optionalInteger(input.settle_ms) ?? 120)), undefined, { signal });
    const observed = await observeWindow({ ...input, action: 'observe', hwnd: previous.hwnd }, config, scopeId,
      { hwnd: previous.hwnd }, signal, previous, nativeAction?.capture);
    return { ...observed, output: { ...output, observation: observed.output } };
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) throw error;
    const failure = computerUseFailure(error);
    if (failure.info.code === 'application_control_blocked') computerUseSafety.recordApplicationControlBlock(scopeId, failure);
    if (failure.info.code === 'user_takeover') await computerUsePresentation.pause(scopeId).catch(() => undefined);
    else if (['user_stopped', 'control_unavailable', 'application_control_blocked'].includes(failure.info.code)) {
      await computerUsePresentation.finish(scopeId).catch(() => undefined);
    } else await computerUsePresentation.hold(scopeId).catch(() => undefined);
    // A failed refresh never changes a dispatched action into a retryable action.
    // No state token is issued, but the input acknowledgement is retained.
    return plain({ ...output, observation: { actionable: false, error: {
      ...failure.info, execution: output.execution,
      recovery: ['user_stopped', 'user_takeover', 'application_control_blocked'].includes(failure.info.code) ? failure.info.recovery
        : 'The input may already have taken effect. Observe before further input; do not replay the action to recover its observation.',
    } } });
  }
}

export const windowStateCaptureScript = String.raw`
${computerUseDisplaysScript}
${computerUseImageScript}
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
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint command);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr hwnd, StringBuilder value, int capacity);
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
  public static string WindowClass(IntPtr hwnd) { var value=new StringBuilder(256); GetClassName(hwnd,value,value.Capacity); return value.ToString(); }
  public static bool IsOwnedBy(IntPtr child, IntPtr owner) {
    if(owner==IntPtr.Zero || child==owner) return false;
    for(int depth=0;child!=IntPtr.Zero && depth<32;depth++) {
      child=GetWindow(child,4); if(child==owner) return true;
    }
    return false;
  }
}

'@
[CardBushWindowCapture]::EnableDpiAwareness()
$h = [IntPtr]([Int64]$script:CARDBUSH_WINDOW_HWND)
$foreground = [CardBushWindowCapture]::GetForegroundWindow()
$relation = 'target'
$expectedPid = [uint32]$script:CARDBUSH_EXPECTED_WINDOW_PID
$requestedExists = [CardBushWindowCapture]::IsWindow($h)
if ($requestedExists -and $expectedPid -gt 0 -and [CardBushWindowCapture]::WindowProcessId($h) -ne $expectedPid) {
  throw 'The target window identity changed after observation. Observe the exact window again.'
}
if ($script:CARDBUSH_FOLLOW_OWNED_WINDOW -eq '1' -and $foreground -ne $h -and $expectedPid -gt 0 -and [CardBushWindowCapture]::WindowProcessId($foreground) -eq $expectedPid) {
  # Ownership plus the observed process identity is required. Same-process
  # siblings, unknown dialogs and another application's foreground are not trusted.
  if ($requestedExists -and [CardBushWindowCapture]::IsOwnedBy($foreground, $h)) {
    $h = $foreground; $relation = 'owned_popup'
  } elseif ($script:CARDBUSH_OBSERVED_OWNER_HWND -ne '0' -and $foreground.ToInt64() -eq [Int64]$script:CARDBUSH_OBSERVED_OWNER_HWND) {
    $h = $foreground; $relation = 'owner_window'
  }
}
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
$displays = [CardBushDesktop]::Read()
$displaySignature = [CardBushDesktop]::Signature($displays)
$windowDpi = [CardBushDesktop]::WindowDpi($h)
$displayId = [CardBushDesktop]::WindowDisplay($h)
if ([long]$width*$height -gt 64000000) { throw 'Window capture exceeds 64 megapixels. Resize the window and observe again.' }

$captureTimer = [Diagnostics.Stopwatch]::StartNew()
$bitmap = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$captureMethod = 'print_window'
try {
  $hdc = $graphics.GetHdc()
  try {
    # Keep control visible during process startup, encoding and accessibility.
    # Mask only our own child surfaces around the actual native capture.
    $hiddenLayers = [CardBushCaptureLayers]::Hide($h)
    try { $captured = [CardBushWindowCapture]::PrintWindow($h, $hdc, 2) }
    finally { [CardBushCaptureLayers]::Restore($hiddenLayers) }
  }
  finally { $graphics.ReleaseHdc($hdc) }
  $uniform = [CardBushDesktop]::Uniform($bitmap)
  $visualVerified = $captured -and -not $uniform
  if (-not $captured -or $uniform) {
    $hiddenLayers = [CardBushCaptureLayers]::Hide($h)
    try {
      $visibleCapture = [CardBushDesktop]::CaptureVisible($h,$bitmap,$rect.Left,$rect.Top,$width,$height)
    } finally { [CardBushCaptureLayers]::Restore($hiddenLayers) }
    if ($visibleCapture) { $captureMethod='visible_window'; $visualVerified=$true; $uniform=[CardBushDesktop]::Uniform($bitmap) }
    elseif (-not $captured) { throw 'Target window capture failed. Verified visible capture is unavailable; no target observation was issued.' }
  }
  $captureQuality = if ($uniform) { 'uniform' } else { 'nonuniform' }
  if ($script:CARDBUSH_INCLUDE_SCREENSHOT -ne '0') {
    ${saveComputerUseImageScript}
  }
  $fingerprint = [CardBushVisualProgress]::Read($bitmap)
} finally {
  $graphics.Dispose()
  $bitmap.Dispose()
  if ($null -ne $script:CardBushTimings) { $script:CardBushTimings.screenshot_ms += $captureTimer.ElapsedMilliseconds }
}

$uiaTimer = [Diagnostics.Stopwatch]::StartNew()
${computerUseAccessibilityScript}
if ($null -ne $script:CardBushTimings) { $script:CardBushTimings.uia_ms += $uiaTimer.ElapsedMilliseconds }

$afterRect = New-Object CardBushWindowCapture+RECT
if (-not [CardBushWindowCapture]::IsWindow($h) -or [CardBushWindowCapture]::WindowProcessId($h) -ne $processId) {
  throw 'The target window identity changed during capture. Observe again.'
}
if (-not [CardBushWindowCapture]::GetWindowRect($h, [ref]$afterRect) -or $afterRect.Left -ne $rect.Left -or $afterRect.Top -ne $rect.Top -or $afterRect.Right -ne $rect.Right -or $afterRect.Bottom -ne $rect.Bottom) {
  throw 'The target window bounds changed during capture. Observe again.'
}
$finalForeground = [CardBushWindowCapture]::GetForegroundWindow()
[CardBushDesktop]::AssertUnchanged($displaySignature,$h,$windowDpi)
$foregroundRelation = 'unrelated'
if ($finalForeground -eq $h) { $foregroundRelation = 'target' }
elseif ([CardBushWindowCapture]::IsOwnedBy($finalForeground, $h)) { $foregroundRelation = 'owned_popup' }
elseif ([CardBushWindowCapture]::IsOwnedBy($h, $finalForeground)) { $foregroundRelation = 'owner_window' }

[PSCustomObject]@{
  path = $script:CARDBUSH_CAPTURE_PATH
  image = $imageMapping
  window = [PSCustomObject]@{ process_id=$processId; hwnd=$h.ToInt64(); title=$windowTitle; process_name=$processName; owner_hwnd=[CardBushWindowCapture]::GetWindow($h,4).ToInt64(); class_name=[CardBushWindowCapture]::WindowClass($h) }
  target_relation = $relation
  foreground_window = [PSCustomObject]@{ hwnd=$finalForeground.ToInt64(); process_id=[CardBushWindowCapture]::WindowProcessId($finalForeground); owner_hwnd=[CardBushWindowCapture]::GetWindow($finalForeground,4).ToInt64(); relation=$foregroundRelation }
  bounds = [PSCustomObject]@{ x=$rect.Left; y=$rect.Top; width=$width; height=$height }
  capture_method = $captureMethod
  capture_quality = $captureQuality
  visual_evidence_verified = [bool]$visualVerified
  displays = $displays
  display_id = $displayId
  display_signature = $displaySignature
  window_dpi = $windowDpi
  foreground_hwnd = $finalForeground.ToInt64()
  capture_consistent = $foreground -eq $finalForeground
  visual_fingerprint = [Convert]::ToBase64String($fingerprint)
  focused_fingerprint = $focusedFingerprint
  focused_bounds = $focusedBounds
  accessibility = [PSCustomObject]@{
    available = $accessibilityAvailable
    total_elements = $totalElements
    matched_elements = $matchedElements
    scan_truncated = $scanTruncated
    next_offset = $nextOffset
    error = $accessibilityError
    elements = $elements.ToArray()
  }
} | ConvertTo-Json -Depth 8 -Compress`;

const windowObservationScript = `${computerUseCaptureLayersScript}\n${computerUseVisualProgressScript}\n${windowStateCaptureScript}`;

const windowListScript = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public static class CardBushWindowList {
  delegate bool EnumProc(IntPtr hwnd,IntPtr parameter);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback,IntPtr parameter);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd,StringBuilder text,int capacity);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd,uint command);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd,StringBuilder text,int capacity);
  public class Item { public long hwnd,owner_hwnd; public bool is_foreground; public uint process_id; public string title,process_name,class_name; }
  public static Item[] Read(){
    var items=new List<Item>();
    EnumWindows((hwnd,p)=>{
      if(!IsWindowVisible(hwnd))return true;
      var title=new StringBuilder(4096);GetWindowText(hwnd,title,title.Capacity);
      IntPtr owner=GetWindow(hwnd,4); bool foreground=GetForegroundWindow()==hwnd;
      if((title.Length==0 && owner==IntPtr.Zero && !foreground) || title.ToString()=="Program Manager")return true;
      uint pid;GetWindowThreadProcessId(hwnd,out pid);string name="";
      try{name=Process.GetProcessById((int)pid).ProcessName;}catch{}
      var className=new StringBuilder(256);GetClassName(hwnd,className,className.Capacity);
      items.Add(new Item{hwnd=hwnd.ToInt64(),process_id=pid,title=title.ToString(),process_name=name,owner_hwnd=owner.ToInt64(),is_foreground=foreground,class_name=className.ToString()});
      return true;
    },IntPtr.Zero);
    return items.ToArray();
  }
}
'@
`;

async function listWindows(signal?: AbortSignal): Promise<unknown[]> {
  return (await readDesktopState(signal)).windows;
}

async function readDesktopState(signal?: AbortSignal): Promise<{ windows: unknown[]; displays: unknown[]; display_signature: string }> {
  return json(await powershell(`${computerUseDisplaysScript}\n${windowListScript}
$displays=[CardBushDesktop]::Read()
$windows=@([CardBushWindowList]::Read() | ForEach-Object { $_ | Add-Member -NotePropertyName display_id -NotePropertyValue ([CardBushDesktop]::WindowDisplay([IntPtr]$_.hwnd)) -PassThru })
@{windows=$windows;displays=$displays;display_signature=[CardBushDesktop]::Signature($displays)} | ConvertTo-Json -Depth 6 -Compress`, {}, signal)) as { windows: unknown[]; displays: unknown[]; display_signature: string };
}

async function controlWindow(
  input: Record<string, unknown>,
  observation: ComputerUseObservationBinding,
  signal?: AbortSignal,
  nativeAction?: NativeActionContext,
) {
  const operation = String(input.operation ?? 'activate').trim().toLowerCase();
  const normalized = operation === 'activate' ? 'focus' : operation;
  if (!['focus', 'minimize', 'maximize', 'restore', 'close', 'move', 'resize'].includes(normalized)) {
    throw new Error(`Unsupported window operation: ${operation}`);
  }
  // MainWindowHandle enumeration may omit an observed secondary window.
  // Use the bound identity and revalidate HWND/PID/bounds in the native action.
  const target = selectWindowTarget([{
    hwnd: observation.hwnd,
    process_id: observation.processId,
    process_name: observation.processName,
    title: observation.title,
  }], input);
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
  await runNativeAction(`${windowControlScript}\n[PSCustomObject]@{action='window';operation=$op} | ConvertTo-Json -Compress`, {
    CARDBUSH_WINDOW_HWND: String(target.hwnd),
    CARDBUSH_WINDOW_OPERATION: normalized,
    CARDBUSH_EXPECTED_WINDOW_PID: String(observation.processId ?? 0),
    CARDBUSH_WINDOW_X: String(bounds.x ?? 0),
    CARDBUSH_WINDOW_Y: String(bounds.y ?? 0),
    CARDBUSH_WINDOW_WIDTH: String(bounds.width ?? 0),
    CARDBUSH_WINDOW_HEIGHT: String(bounds.height ?? 0),
    CARDBUSH_EXPECTED_WINDOW_X: String(observation.bounds.x),
    CARDBUSH_EXPECTED_WINDOW_Y: String(observation.bounds.y),
    CARDBUSH_EXPECTED_WINDOW_WIDTH: String(observation.bounds.width),
    CARDBUSH_EXPECTED_WINDOW_HEIGHT: String(observation.bounds.height),
  }, signal, 15_000, nativeAction);
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

export function supportedAccessibilityActions(element: Pick<ComputerUseObservedElement, 'patterns' | 'enabled' | 'offscreen' | 'password' | 'readOnly'>): string[] {
  if (!element.enabled || element.offscreen) return [];
  const actions: string[] = [];
  if (element.patterns.some((pattern) => ['Invoke', 'Toggle', 'SelectionItem', 'ExpandCollapse'].includes(pattern))) {
    actions.push('click', 'invoke');
  }
  if (!element.password && !element.readOnly && element.patterns.some((pattern) => ['Value', 'RangeValue'].includes(pattern))) {
    actions.push('set_value');
  }
  return actions;
}

export function validateAccessibilityAction(
  action: string,
  input: Record<string, unknown>,
  observation: ComputerUseObservationBinding,
): ComputerUseObservedElement {
  const elementIndex = optionalInteger(input.element_index);
  if (elementIndex == null) throw new Error(`${action} requires element_index.`);
  const element = observation.elements.find((candidate) => candidate.index === elementIndex);
  if (!element) throw new Error(`Accessibility element_index=${elementIndex} is not part of this observation. Observe the target window again.`);
  if (action === 'set_value' && element.password) throw new Error('Computer Use refuses to set password fields through UI Automation. Ask the user to take over.');
  if (action === 'set_value' && element.readOnly) throw new Error('The observed accessibility value is read-only. Observe again and choose a writable element.');
  if (!supportedAccessibilityActions(element).includes(action)) {
    throw new Error(`Element ${elementIndex} does not support ${action} (patterns: ${element.patterns.join(', ') || 'none'}). Observe again; use supported_actions to choose a semantic action or a window-relative coordinate to focus the control. set_value replaces the entire value.`);
  }
  return element;
}

async function runAccessibilityAction(
  action: string,
  input: Record<string, unknown>,
  observation: ComputerUseObservationBinding,
  config: ComputerUsePluginConfig,
  expectedInputTick: number | undefined,
  signal?: AbortSignal,
  nativeAction?: NativeActionContext,
): Promise<Record<string, unknown>> {
  const element = validateAccessibilityAction(action, input, observation);
  const elementIndex = element.index;
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
    observed_process_id: observation.processId,
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
  const result = await runNativeAction(accessibilityActionScript, {
    CARDBUSH_UIA_ACTION_BASE64: payload,
    CARDBUSH_YIELD_TO_USER: config.yieldToUser ? '1' : '0',
    CARDBUSH_EXPECTED_INPUT_TICK: String(expectedInputTick ?? 0),
  }, signal, 15_000, nativeAction);
  if (result.yielded_to_user === true) throw new ComputerUseUserActiveError();
  return result;
}

const accessibilityActionScript = String.raw`
$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($script:CARDBUSH_UIA_ACTION_BASE64))
$p = $json | ConvertFrom-Json
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CardBushUiaWindow {
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  public static void CheckTarget(IntPtr hwnd, uint expectedPid) {
    uint pid; GetWindowThreadProcessId(hwnd, out pid);
    if (!IsWindow(hwnd) || expectedPid == 0 || pid != expectedPid || GetForegroundWindow() != hwnd)
      throw new InvalidOperationException("Target window identity or foreground changed. Observe again.");
  }
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
  [DllImport("user32.dll", EntryPoint="SetProcessDpiAwarenessContext")] private static extern bool SetDpiContext(IntPtr value);
  [DllImport("user32.dll", EntryPoint="SetProcessDPIAware")] private static extern bool SetDpiAware();
  public static void EnableDpiAwareness(){try{if(SetDpiContext(new IntPtr(-4)))return;}catch(EntryPointNotFoundException){}try{SetDpiAware();}catch(EntryPointNotFoundException){}}
  public static uint LastInputTick(){LASTINPUTINFO info=new LASTINPUTINFO{cbSize=(uint)Marshal.SizeOf(typeof(LASTINPUTINFO))};if(!GetLastInputInfo(ref info))return 0;return info.dwTime;}
  public static uint IdleMilliseconds(){unchecked{return (uint)Environment.TickCount-LastInputTick();}}
}
'@
[CardBushUiaWindow]::EnableDpiAwareness()
$yieldToUser = $script:CARDBUSH_YIELD_TO_USER -eq '1'
$expectedInputTick = [uint32]$script:CARDBUSH_EXPECTED_INPUT_TICK
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
$inputTimer = [Diagnostics.Stopwatch]::StartNew()
[CardBushUiaWindow]::CheckTarget($h, [uint32]$p.observed_process_id)
${computerUseDisplayGuardScript}
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

if ($null -ne $script:CardBushTimings) { $script:CardBushTimings.input_ms += $inputTimer.ElapsedMilliseconds }
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
  nativeAction?: NativeActionContext,
): Promise<Record<string, unknown>> {
  if (observation.visualVerified === false) throw new ComputerUseFailure('observation_failed', 'Window pixels were not verified. Uncover the target and observe again before sending coordinate or keyboard input.');
  const payload = Buffer.from(JSON.stringify({
    action,
    ...input,
    hwnd: observation.hwnd,
    observed_bounds: observation.bounds,
    observed_process_id: observation.processId,
    coordinate_space: 'window',
  }), 'utf8').toString('base64');
  const result = await runNativeAction(
    computerInputScript,
    {
      CARDBUSH_INPUT_BASE64: payload,
      CARDBUSH_YIELD_TO_USER: config.yieldToUser ? '1' : '0',
      CARDBUSH_RESTORE_POINTER: config.restorePointer ? '1' : '0',
      CARDBUSH_EXPECTED_INPUT_TICK: String(expectedInputTick ?? 0),
    },
    signal,
    action === 'type' ? 15_000 + String(input.text ?? '').length * 50 : 15_000,
    nativeAction,
  );
  if (result.yielded_to_user === true) throw new ComputerUseUserActiveError();
  return result;
}

export async function validateClipboardInput(input: Record<string, unknown>): Promise<void> {
  if ((input.text != null) === (input.files != null)) throw new ComputerUseFailure('invalid_action', 'clipboard requires exactly one of text or files.');
  if (input.text != null) {
    if (typeof input.text !== 'string' || input.text.length > 8192 || input.text.includes('\0')) throw new ComputerUseFailure('invalid_action', 'Clipboard text must be at most 8192 characters without NUL.');
    return;
  }
  if (!Array.isArray(input.files) || input.files.length < 1 || input.files.length > 64) throw new ComputerUseFailure('invalid_action', 'Clipboard requires 1 to 64 existing files.');
  for (const path of input.files) {
    if (typeof path !== 'string' || !win32.isAbsolute(path) ||
        !/^(?:[a-z]:[\\/]|\\\\[^\\/]+\\[^\\/]+\\)/i.test(path) || path.includes('\0') || /^\\\\[?.]\\/.test(path)) {
      throw new ComputerUseFailure('invalid_action', 'Clipboard files require absolute Windows file paths, not device paths.');
    }
    if (!(await stat(path).catch(() => undefined))?.isFile()) throw new ComputerUseFailure('invalid_action', `Clipboard file is unavailable or not a file: ${path}`);
  }
}

async function runNativeAction(
  script: string, parameters: Record<string, string>, signal: AbortSignal | undefined, timeoutMs: number, context?: NativeActionContext,
): Promise<Record<string, unknown>> {
  parameters = { ...parameters, CARDBUSH_DISPLAY_SIGNATURE: context?.previous.displaySignature ?? '',
    CARDBUSH_DISPLAY_HWND: String(context?.previous.hwnd ?? 0), CARDBUSH_WINDOW_DPI: String(context?.previous.windowDpi ?? 0) };
  script = `${computerUseDisplaysScript}\n${computerUseDisplayGuardScript}\n${script}`;
  if (!context || context.input.observe_after === false) return record(json(await powershell(script, parameters, signal, timeoutMs)));
  const { input, previous, config } = context;
  const request = prepareWindowCapture(config.screenshotDirectory, previous.hwnd,
    input.include_text === true, optionalInteger(input.max_elements) ?? 80, {
      includeScreenshot: input.include_screenshot !== false, followOwnedWindow: true,
      expectedProcessId: previous.processId, ownerHwnd: previous.ownerHwnd,
      elementQuery: input.element_query, elementOffset: optionalInteger(input.element_offset),
      region: input.region, scale: input.scale, grid: input.grid,
    });
  const settle = Math.max(0, Math.min(1000, optionalInteger(input.settle_ms) ?? 120));
  // Only one action is dispatched. Its ACK reaches Node before capture starts:
  // Node records it and releases the active input lease, then permits observation.
  // Failure/cancellation after the ACK never turns into a replay of that action.
  const combined = `
$cardbushAckJson = (& {
${script}
}) -join [Environment]::NewLine
$cardbushAck = $cardbushAckJson | ConvertFrom-Json
if ($cardbushAck.yielded_to_user) { $cardbushAckJson; return }
[Console]::Out.WriteLine('CARDBUSH_ACTION_COMPLETED:' + $cardbushAckJson)
[Console]::Out.Flush()
if ([Console]::In.ReadLine() -ne 'observe') { throw 'The action was acknowledged but observation was cancelled.' }
try {
  $cardbushSettle = [Diagnostics.Stopwatch]::StartNew()
  if (${settle} -gt 0) { Start-Sleep -Milliseconds ${settle} }
  $script:CardBushTimings.settle_ms += $cardbushSettle.ElapsedMilliseconds
  $cardbushCaptureJson = (& {
${computerUsePowerShellParameters(request.parameters)}
${windowObservationScript}
  }) -join [Environment]::NewLine
  [PSCustomObject]@{ acknowledgement=$cardbushAck; capture=($cardbushCaptureJson | ConvertFrom-Json) } | ConvertTo-Json -Depth 12 -Compress
} catch {
  [PSCustomObject]@{ acknowledgement=$cardbushAck; observation_error=$_.Exception.Message } | ConvertTo-Json -Depth 6 -Compress
}`;
  try {
    const result = record(json(await powershell(combined, parameters, signal, timeoutMs + 15_000, async acknowledgement => {
      context.acknowledgement = acknowledgement;
      await context.acknowledge(acknowledgement);
    })));
    if (result.yielded_to_user) return result;
    if (result.capture) context.capture = { path: request.path, raw: record(result.capture) };
    else context.observationError = new ComputerUseFailure('observation_failed', optionalString(result.observation_error) || 'The action completed without an observation.', 'dispatched');
    return record(result.acknowledgement);
  } catch (error) {
    if (!context.acknowledgement || signal?.aborted) throw error;
    context.observationError = error;
    return context.acknowledgement;
  }
}

const windowControlScript = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CardBushWindowControl {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int h2, uint f);
  [DllImport("user32.dll", EntryPoint="SetProcessDpiAwarenessContext")] private static extern bool SetDpiContext(IntPtr value);
  [DllImport("user32.dll", EntryPoint="SetProcessDPIAware")] private static extern bool SetDpiAware();
  public static void EnableDpiAwareness(){try{if(SetDpiContext(new IntPtr(-4)))return;}catch(EntryPointNotFoundException){}try{SetDpiAware();}catch(EntryPointNotFoundException){}}
}
'@
[CardBushWindowControl]::EnableDpiAwareness()
$h = [IntPtr]([Int64]$script:CARDBUSH_WINDOW_HWND)
$op = $script:CARDBUSH_WINDOW_OPERATION
[uint32]$actualPid = 0
[void][CardBushWindowControl]::GetWindowThreadProcessId($h, [ref]$actualPid)
$expectedPid = [uint32]$script:CARDBUSH_EXPECTED_WINDOW_PID
if ($actualPid -eq 0 -or ($expectedPid -gt 0 -and $actualPid -ne $expectedPid)) { throw 'The target window identity changed after observation. Observe the exact window again.' }
$rect = New-Object CardBushWindowControl+RECT
if (-not [CardBushWindowControl]::GetWindowRect($h, [ref]$rect)) { throw 'The target window is no longer available. Observe again.' }
$expectedX = [int]$script:CARDBUSH_EXPECTED_WINDOW_X
$expectedY = [int]$script:CARDBUSH_EXPECTED_WINDOW_Y
$expectedWidth = [int]$script:CARDBUSH_EXPECTED_WINDOW_WIDTH
$expectedHeight = [int]$script:CARDBUSH_EXPECTED_WINDOW_HEIGHT
if (
  [Math]::Abs($rect.Left - $expectedX) -gt 2 -or
  [Math]::Abs($rect.Top - $expectedY) -gt 2 -or
  [Math]::Abs(($rect.Right - $rect.Left) - $expectedWidth) -gt 2 -or
  [Math]::Abs(($rect.Bottom - $rect.Top) - $expectedHeight) -gt 2
) { throw 'The target window bounds changed after observation. Observe again.' }
$inputTimer = [Diagnostics.Stopwatch]::StartNew()
${computerUseDisplayGuardScript}
switch ($op) {
  'focus' {
    [void][CardBushWindowControl]::ShowWindow($h,9)
    [void][CardBushWindowControl]::SetForegroundWindow($h)
    $focusWait = [Diagnostics.Stopwatch]::StartNew()
    while ([CardBushWindowControl]::GetForegroundWindow() -ne $h -and $focusWait.ElapsedMilliseconds -lt 250) { Start-Sleep -Milliseconds 25 }
    if ([CardBushWindowControl]::GetForegroundWindow() -ne $h) { throw 'Windows did not activate the target window. Do not send input or repeat activation blindly; report the blocker and ask the user to bring the target forward.' }
  }
  'minimize' { [void][CardBushWindowControl]::ShowWindow($h,6) }
  'maximize' { [void][CardBushWindowControl]::ShowWindow($h,3) }
  'restore' { [void][CardBushWindowControl]::ShowWindow($h,9) }
  'close' { [void][CardBushWindowControl]::PostMessage($h,0x0010,[IntPtr]::Zero,[IntPtr]::Zero) }
  'move' { [void][CardBushWindowControl]::SetWindowPos($h,[IntPtr]::Zero,[int]$script:CARDBUSH_WINDOW_X,[int]$script:CARDBUSH_WINDOW_Y,$rect.Right-$rect.Left,$rect.Bottom-$rect.Top,0x0014) }
  'resize' { [void][CardBushWindowControl]::SetWindowPos($h,[IntPtr]::Zero,$rect.Left,$rect.Top,[int]$script:CARDBUSH_WINDOW_WIDTH,[int]$script:CARDBUSH_WINDOW_HEIGHT,0x0014) }
}
if ($null -ne $script:CardBushTimings) { $script:CardBushTimings.input_ms += $inputTimer.ElapsedMilliseconds }
`;

const computerInputScript = String.raw`
$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($script:CARDBUSH_INPUT_BASE64))
$p = $json | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class CardBushInput {
  [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
  [DllImport("user32.dll",SetLastError=true)] static extern bool OpenClipboard(IntPtr window);
  [DllImport("user32.dll")] static extern bool CloseClipboard();
  [DllImport("user32.dll",SetLastError=true)] static extern bool EmptyClipboard();
  [DllImport("user32.dll",SetLastError=true)] static extern IntPtr SetClipboardData(uint format,IntPtr data);
  [DllImport("user32.dll")] static extern IntPtr GetClipboardData(uint format);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern uint RegisterClipboardFormat(string name);
  [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateWindowEx(uint ex,string cls,string title,uint style,int x,int y,int width,int height,IntPtr parent,IntPtr menu,IntPtr instance,IntPtr param);
  [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr window);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr GlobalAlloc(uint flags,UIntPtr bytes);
  [DllImport("kernel32.dll")] static extern IntPtr GlobalLock(IntPtr memory);
  [DllImport("kernel32.dll")] static extern bool GlobalUnlock(IntPtr memory);
  [DllImport("kernel32.dll")] static extern IntPtr GlobalFree(IntPtr memory);
  [DllImport("kernel32.dll")] static extern UIntPtr GlobalSize(IntPtr memory);
  static IntPtr ClipboardMemory(byte[] data) {
    IntPtr memory=GlobalAlloc(0x42,new UIntPtr((uint)data.Length));
    if(memory==IntPtr.Zero)throw new InvalidOperationException("Unable to allocate clipboard data.");
    IntPtr pointer=GlobalLock(memory);
    if(pointer==IntPtr.Zero){GlobalFree(memory);throw new InvalidOperationException("Unable to lock clipboard data.");}
    try{Marshal.Copy(data,0,pointer,data.Length);}finally{GlobalUnlock(memory);}
    return memory;
  }
  static void WriteClipboard(uint format,byte[] bytes,bool files) {
    IntPtr memory=ClipboardMemory(bytes),effect=IntPtr.Zero,owner=IntPtr.Zero;bool opened=false;
    try {
      uint effectFormat=0;
      if(files){effectFormat=RegisterClipboardFormat("Preferred DropEffect");if(effectFormat==0)throw new InvalidOperationException("Unable to register copy format.");effect=ClipboardMemory(BitConverter.GetBytes(1));}
      owner=CreateWindowEx(0,"STATIC","CardBushClipboard",0,0,0,0,0,new IntPtr(-3),IntPtr.Zero,IntPtr.Zero,IntPtr.Zero);
      if(owner==IntPtr.Zero)throw new InvalidOperationException("Unable to create a temporary clipboard owner.");
      for(int attempt=0;attempt<4;attempt++){CheckTarget();if(OpenClipboard(owner)){opened=true;break;}Thread.Sleep(30);}
      if(!opened)throw new InvalidOperationException("Clipboard is busy. No clipboard data was changed.");
      CheckTarget();
      if(!EmptyClipboard())throw new InvalidOperationException("Unable to clear clipboard before copying.");
      if(SetClipboardData(format,memory)==IntPtr.Zero)throw new InvalidOperationException("Unable to copy clipboard data.");
      memory=IntPtr.Zero; // Ownership transfers to Windows only on success.
      if(files){if(SetClipboardData(effectFormat,effect)==IntPtr.Zero)throw new InvalidOperationException("Unable to set file copy mode.");effect=IntPtr.Zero;}
      IntPtr stored=GetClipboardData(format);
      if(stored==IntPtr.Zero || GlobalSize(stored).ToUInt64()<(ulong)bytes.Length)throw new InvalidOperationException("Clipboard verification failed. No paste was sent.");
      IntPtr pointer=GlobalLock(stored);
      if(pointer==IntPtr.Zero)throw new InvalidOperationException("Clipboard verification could not read the copied data.");
      try{for(int i=0;i<bytes.Length;i++)if(Marshal.ReadByte(pointer,i)!=bytes[i])throw new InvalidOperationException("Clipboard contents changed before verification. No paste was sent.");}
      finally{GlobalUnlock(stored);}
    } finally {
      if(opened)CloseClipboard();
      if(owner!=IntPtr.Zero)DestroyWindow(owner);
      if(memory!=IntPtr.Zero)GlobalFree(memory);
      if(effect!=IntPtr.Zero)GlobalFree(effect);
    }
  }
  public static void ClipboardText(string text) {
    if(text==null || text.IndexOf('\0')>=0)throw new ArgumentException("Clipboard text contains NUL.");
    WriteClipboard(13,System.Text.Encoding.Unicode.GetBytes(text+"\0"),false);
  }
  public static void ClipboardFiles(string[] paths) {
    if(paths==null || paths.Length==0)throw new ArgumentException("Clipboard file list is empty.");
    foreach(string path in paths) {
      if(!System.IO.Path.IsPathRooted(path) || !System.IO.File.Exists(path))
        throw new ArgumentException("Clipboard requires existing absolute file paths.");
    }
    byte[] names=System.Text.Encoding.Unicode.GetBytes(String.Join("\0",paths)+"\0\0");
    byte[] bytes=new byte[20+names.Length];BitConverter.GetBytes(20).CopyTo(bytes,0);BitConverter.GetBytes(1).CopyTo(bytes,16);names.CopyTo(bytes,20);
    WriteClipboard(15,bytes,true);
  }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion data; }
  [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public KEYBDINPUT keyboard; [FieldOffset(0)] public MOUSEINPUT mouse; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int x, y; public uint data, flags, time; public UIntPtr extraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort virtualKey; public ushort scanCode; public uint flags; public uint time; public UIntPtr extraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x; public int y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("winmm.dll")] static extern uint timeBeginPeriod(uint period);
  [DllImport("winmm.dll")] static extern uint timeEndPeriod(uint period);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,int d,UIntPtr e);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
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
  public static IntPtr ExpectedWindow;
  public static uint ExpectedProcessId;
  public static RECT ExpectedBounds;
  public static uint ExpectedDpi;
  public static void CheckTarget(){
    uint pid; GetWindowThreadProcessId(ExpectedWindow,out pid);
    if(GetForegroundWindow()!=ExpectedWindow || pid==0 || (ExpectedProcessId!=0 && pid!=ExpectedProcessId))
      throw new InvalidOperationException("The target window or foreground changed during input. Input stopped; observe again before resuming.");
    RECT rect;
    if(ExpectedDpi>0 && (GetDpiForWindow(ExpectedWindow)!=ExpectedDpi || !GetWindowRect(ExpectedWindow,out rect) ||
      rect.Left!=ExpectedBounds.Left || rect.Top!=ExpectedBounds.Top || rect.Right!=ExpectedBounds.Right || rect.Bottom!=ExpectedBounds.Bottom))
      throw new InvalidOperationException("Window bounds changed or DPI changed during input. Input stopped; observe again.");
  }
  public static void Key(byte k,bool d){
    if(d)CheckTarget();
    uint extended=(k>=33 && k<=40)||k==45||k==46||k==91?1u:0u;
    INPUT item=new INPUT{type=1,data=new InputUnion{keyboard=new KEYBDINPUT{virtualKey=k,flags=extended|(d?0u:2u),extraInfo=InputTag}}};
    if(SendInput(1,new INPUT[]{item},Marshal.SizeOf(typeof(INPUT)))!=1)throw new InvalidOperationException("Keyboard input failed.");
  }
  public static void Text(string text){
    timeBeginPeriod(1);
    try{for(int index=0;index<text.Length;index++){
      CheckTarget();
      bool enter=text[index]=='\r'||text[index]=='\n';
      int length=enter?(text[index]=='\r'&&index+1<text.Length&&text[index+1]=='\n'?2:1)
        :(char.IsHighSurrogate(text[index])&&index+1<text.Length&&char.IsLowSurrogate(text[index+1])?2:1);
      INPUT[] inputs=new INPUT[enter?2:length*2];
      if(enter){
        inputs[0]=new INPUT{type=1,data=new InputUnion{keyboard=new KEYBDINPUT{virtualKey=13,extraInfo=InputTag}}};
        inputs[1]=new INPUT{type=1,data=new InputUnion{keyboard=new KEYBDINPUT{virtualKey=13,flags=2,extraInfo=InputTag}}};
      }else for(int part=0;part<length;part++){
        ushort character=text[index+part];
        inputs[part*2]=new INPUT{type=1,data=new InputUnion{keyboard=new KEYBDINPUT{scanCode=character,flags=4,extraInfo=InputTag}}};
        inputs[part*2+1]=new INPUT{type=1,data=new InputUnion{keyboard=new KEYBDINPUT{scanCode=character,flags=6,extraInfo=InputTag}}};
      }
      if(SendInput((uint)inputs.Length,inputs,Marshal.SizeOf(typeof(INPUT)))!=inputs.Length) throw new InvalidOperationException("Unicode keyboard input failed.");
      index+=length-1;
      // Let the target process input and any resulting focus change before
      // queueing another character. A dispatch ACK is not application success.
      Thread.Sleep(40);
      CheckTarget();
    }}finally{timeEndPeriod(1);}
  }
  public static void MovePointer(int x,int y){
    int left=GetSystemMetrics(76),top=GetSystemMetrics(77),width=GetSystemMetrics(78),height=GetSystemMetrics(79);
    if(width<=0 || height<=0 || x<left || y<top || x>=left+width || y>=top+height)
      throw new InvalidOperationException("Pointer target is outside the interactive desktop.");
    // Pixel centers on the virtual desktop, including monitors with negative
    // origins. Tag movement as well as buttons so our hook cannot call it human.
    int nx=(int)(((long)(x-left)*65536+32768)/width),ny=(int)(((long)(y-top)*65536+32768)/height);
    INPUT item=new INPUT{type=0,data=new InputUnion{mouse=new MOUSEINPUT{x=nx,y=ny,flags=0xC001,extraInfo=InputTag}}};
    if(SendInput(1,new INPUT[]{item},Marshal.SizeOf(typeof(INPUT)))!=1)
      throw new InvalidOperationException("Pointer input failed.");
  }
  public static void Drag(int x,int y,int tx,int ty,int steps,int duration){CheckTarget();MovePointer(x,y);mouse_event(2,0,0,0,InputTag);try{for(int i=1;i<=steps;i++){CheckTarget();int nx=x+(tx-x)*i/steps,ny=y+(ty-y)*i/steps;if(RootWindowAt(nx,ny)!=ExpectedWindow.ToInt64())throw new InvalidOperationException("The drag path is covered by another window. Input stopped.");MovePointer(nx,ny);if(duration>0)Thread.Sleep(duration/steps);}}finally{mouse_event(4,0,0,0,InputTag);}}
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
$yieldToUser = $script:CARDBUSH_YIELD_TO_USER -eq '1'
$restorePointer = $script:CARDBUSH_RESTORE_POINTER -eq '1'
$expectedInputTick = [uint32]$script:CARDBUSH_EXPECTED_INPUT_TICK
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
[CardBushInput]::ExpectedWindow = [IntPtr]$expectedHwnd
[CardBushInput]::ExpectedProcessId = if ($null -ne $p.observed_process_id) { [uint32]$p.observed_process_id } else { 0 }
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
$inputTimer = [Diagnostics.Stopwatch]::StartNew()
try {
  ${computerUseDisplayGuardScript}
  [CardBushInput]::ExpectedBounds=$currentBounds
  [CardBushInput]::ExpectedDpi=[uint32]$script:CARDBUSH_WINDOW_DPI
  [CardBushInput]::CheckTarget()
  switch ($p.action) {
    'click' { $expectedPointerX=$screenX;$expectedPointerY=$screenY;$b=if($p.button -eq 'right'){@(8,16)}elseif($p.button -eq 'middle'){@(32,64)}else{@(2,4)};$clicks=if($null -ne $p.clicks){[int]$p.clicks}else{1};[CardBushInput]::MovePointer($screenX,$screenY);1..$clicks|%{[CardBushInput]::mouse_event($b[0],0,0,0,[CardBushInput]::InputTag);[CardBushInput]::mouse_event($b[1],0,0,0,[CardBushInput]::InputTag)} }
    'scroll' { $expectedPointerX=$screenX;$expectedPointerY=$screenY;[CardBushInput]::MovePointer($screenX,$screenY);[CardBushInput]::mouse_event(2048,0,0,([int]$p.delta)*120,[CardBushInput]::InputTag) }
    'drag' { $expectedPointerX=$screenToX;$expectedPointerY=$screenToY;$steps=if($null -ne $p.steps){[int]$p.steps}else{20};$duration=if($null -ne $p.duration_ms){[int]$p.duration_ms}else{400};[CardBushInput]::Drag($screenX,$screenY,$screenToX,$screenToY,$steps,$duration) }
    'type' { [CardBushInput]::Text([string]$p.text) }
    'clipboard' { if ($null -ne $p.files) { [CardBushInput]::ClipboardFiles([string[]]$p.files) } else { [CardBushInput]::ClipboardText([string]$p.text) } }
    'key' { $keys=@($p.keys);if($keys.Count -eq 0 -or $null -eq $keys[0]){$keys=@($p.key)};$codes=@($keys|%{KeyCode ([string]$_)});$pressed=[System.Collections.Generic.List[byte]]::new();try{foreach($code in $codes){[CardBushInput]::Key($code,$true);$pressed.Add($code)}}finally{for($index=$pressed.Count-1;$index -ge 0;$index--){[CardBushInput]::Key($pressed[$index],$false)}} }
  }
} finally {
  if ($null -ne $script:CardBushTimings) { $script:CardBushTimings.input_ms += $inputTimer.ElapsedMilliseconds }
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
$result=[ordered]@{action=$p.action; input_mode='send_input'; coordinate_space=$p.coordinate_space; yielded_to_user=$false; input_wait_ms=$wait.ElapsedMilliseconds; pointer_restored=$pointerRestored; pointer_restore_skipped_for_user=$pointerRestoreSkippedForUser; foreground_hwnd=[CardBushInput]::ForegroundWindow(); last_input_tick=[CardBushInput]::LastInputTick()}
if($p.action -eq 'clipboard') { $result.input_mode='clipboard'; $result.format=if($null -ne $p.files){'files'}else{'text'}; $result.verified=$true; $result.pasted=$false; $result.clipboard_sequence=[CardBushInput]::GetClipboardSequenceNumber(); if($null -ne $p.files){$result.file_count=@($p.files).Count}else{$result.text_length=([string]$p.text).Length} }
[PSCustomObject]$result | ConvertTo-Json -Compress`;

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
$expectedInputTick = [uint32]$script:CARDBUSH_EXPECTED_INPUT_TICK
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

class ComputerUseUserActiveError extends ComputerUseFailure {
  constructor() {
    super('user_takeover', 'Computer Use yielded because the user is actively using the mouse or keyboard. Wait for the user to finish, then call observe before continuing.');
    this.name = 'ComputerUseUserActiveError';
  }
}

async function powershell(
  script: string,
  parameters: Record<string, string> = {},
  signal?: AbortSignal,
  timeoutMs = 15_000,
  afterAction?: (acknowledgement: Record<string, unknown>) => Promise<void>,
): Promise<string> {
  throwIfAborted(signal);
  try {
    const prepared = await prepareComputerUseNativeCode(script);
    throwIfAborted(signal);
    return await runComputerUsePowerShell(prepared, {
      timeoutMs,
      signal,
      cwd: powerShellWorkingDirectory(),
      env: process.env,
      parameters,
      afterAction,
    });
  } catch (error) {
    throwIfAborted(signal);
    if (isAbortError(error)) throw error;
    throw computerUseFailure(error);
  }
}

export async function precompileComputerUseNativeCode(directory?: string): Promise<void> {
  for (const script of [windowObservationScript, computerInputScript, accessibilityActionScript, windowControlScript, windowListScript, desktopIdleScript]) {
    await prepareComputerUseNativeCode(script, directory);
  }
}

function powerShellWorkingDirectory(): string {
  let current = '';
  try { current = process.cwd(); } catch { /* The service's original directory may have been removed. */ }
  for (const candidate of [current, tmpdir(), process.env.SystemRoot]) {
    if (!candidate) continue;
    try { if (statSync(candidate).isDirectory()) return candidate; } catch { /* Try the next existing directory. */ }
  }
  throw new Error('Computer Use could not find an existing working directory for PowerShell.');
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
    Object.entries(input).filter(([key]) => !['state_id', 'observe_after', 'include_text', 'include_screenshot', 'max_elements', 'element_query', 'element_offset', 'settle_ms', 'region', 'scale', 'grid'].includes(key)),
  );
  return JSON.stringify(canonicalValue(stableInput));
}

function actionRegion(input: Record<string, unknown>, observation: ComputerUseObservationBinding, previous?: ProgressBounds): ProgressBounds | undefined {
  const element = observation.elements.find((item) => item.index === input.element_index);
  if (element?.bounds) return element.bounds;
  if (input.action === 'type' || input.action === 'key') return observation.focusedBounds ?? previous;
  const x = optionalInteger(input.x), y = optionalInteger(input.y);
  if (x == null || y == null || input.action === 'window') return undefined;
  const left = Math.max(0, x - 160), top = Math.max(0, y - 60);
  return { x: left, y: top, width: Math.min(320, observation.bounds.width - left), height: Math.min(120, observation.bounds.height - top) };
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
      resultOffset: optionalInteger(source.result_offset) ?? fallbackIndex,
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
    ...(element.automationId ? { automation_id: element.automationId } : {}),
    control_type: element.controlType,
    ...(element.className ? { class_name: element.className } : {}),
    enabled: element.enabled,
    ...(element.focused ? { focused: true } : {}),
    ...(element.offscreen ? { offscreen: true } : {}),
    ...(element.password ? { password: true } : {}),
    ...(element.bounds ? { bounds: element.bounds } : {}),
    patterns: element.patterns,
    supported_actions: supportedAccessibilityActions(element),
    ...(element.value !== undefined ? { value: element.value } : {}),
    ...(element.state !== undefined ? { state: element.state } : {}),
    ...(element.readOnly !== undefined ? { read_only: element.readOnly } : {}),
  };
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
