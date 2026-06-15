import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bot,
  Check,
  LoaderCircle,
  MessageSquare,
  PanelRightClose,
  PanelRightOpen,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Sparkles,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { AppLanguage } from '../../types';
import {
  buildCardlingSceneSteps,
  initialSceneSelectedNodeId,
  nodePurposeSpeech,
  sceneFeedbackId,
  type CardlingScene,
  type CardlingSceneFeedback,
} from './scene';
import {
  appendSceneRuntimeEvent,
  buildSceneSrcDoc,
  formatSceneActionRunPrompt,
  formatSceneFeedbackRunPrompt,
  formatSceneKabuChatPrompt,
  initialSceneHealth,
  initialSceneRuntimeState,
  mergeSceneRuntimeState,
  normalizeSceneHealth,
  normalizeSceneRuntimeState,
  sceneCardlingStyle,
  sceneEventContinuesTurn,
  sceneEventDelivery,
  sceneEventError,
  sceneFloatingCardlingStyle,
  sceneHealthKey,
  sceneKabuDialogStyle,
  sceneOpenTargetFromPayload,
  sceneRuntimeEventTypes,
  sendSceneUserEvent,
  type SceneAnchorRect,
  type SceneEventStatus,
  type SceneHealthReport,
  type SceneRuntimeEventType,
  type SceneRuntimeState,
} from './runtime';
export function CardlingSceneHost({
  scene,
  language,
  initialAutoPlay,
  llmRunning,
  activeTurnId,
  onSendFeedbackToLlm,
  onClose,
}: {
  scene: CardlingScene;
  language: AppLanguage;
  initialAutoPlay: boolean;
  llmRunning: boolean;
  activeTurnId: string;
  onSendFeedbackToLlm: (text: string) => Promise<void>;
  onClose: () => void;
}) {
  const sceneHostRef = useRef<HTMLElement | null>(null);
  const sceneInspectorRef = useRef<HTMLElement | null>(null);
  const sceneNodeListRef = useRef<HTMLDivElement | null>(null);
  const sceneFeedbackRef = useRef<HTMLDivElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [anchorRect, setAnchorRect] = useState<SceneAnchorRect | null>(null);
  const [comment, setComment] = useState('');
  const [feedbackQueue, setFeedbackQueue] = useState<CardlingSceneFeedback[]>([]);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [eventStatus, setEventStatus] = useState<SceneEventStatus>('idle');
  const [sceneState, setSceneState] = useState<SceneRuntimeState>(() =>
    initialSceneRuntimeState(scene),
  );
  const [sceneHealth, setSceneHealth] = useState<SceneHealthReport>(() =>
    initialSceneHealth(scene),
  );
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [freeTalkMode, setFreeTalkMode] = useState(false);
  const [kabuDialogOpen, setKabuDialogOpen] = useState(false);
  const [kabuDraft, setKabuDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [decisionSubmitting, setDecisionSubmitting] = useState<
    'confirm' | 'cancel' | ''
  >('');
  const lastSceneHealthKeyRef = useRef('');
  const srcDoc = useMemo(() => buildSceneSrcDoc(scene), [scene]);
  const sceneSteps = useMemo(
    () => buildCardlingSceneSteps(scene, language),
    [language, scene],
  );
  const [selectedNodeId, setSelectedNodeId] = useState(() =>
    initialSceneSelectedNodeId(scene, sceneSteps),
  );
  const [activeStepIndex, setActiveStepIndex] = useState(0);
  const [typedSpeech, setTypedSpeech] = useState('');
  const [playbackRunning, setPlaybackRunning] = useState(initialAutoPlay);
  const activeStep =
    sceneSteps[Math.min(activeStepIndex, Math.max(0, sceneSteps.length - 1))];
  const activeStepNodeId = activeStep?.nodeId?.trim() ?? '';
  const activeSpeech = freeTalkMode
    ? language === 'zh'
      ? '自由对话已开启。你可以直接测试这个 HTML 页面，点击不会切换反馈节点；点我可以聊整个场景。'
      : 'Free chat is on. You can test this HTML page directly; clicks will not retarget feedback nodes. Click me to discuss the whole scene.'
    : activeStep?.speech || scene.cardling.speech;
  const displayedSpeech = typedSpeech || (playbackRunning ? '' : activeSpeech);
  const embedded = scene.cardling.mode === 'embedded';
  const anchoredNodeId =
    activeStep != null
      ? activeStepNodeId || selectedNodeId
      : selectedNodeId ||
        anchorRect?.nodeId ||
        scene.cardling.anchor?.nodeId ||
        scene.nodes[0]?.nodeId ||
        '';
  const currentNodeId = freeTalkMode ? '' : anchoredNodeId;
  const cardlingAnchorRect =
    freeTalkMode || (activeStep != null && !activeStepNodeId) ? null : anchorRect;
  const expectedAction = scene.expectedUserAction?.type?.trim() ?? '';
  const showDecisionActions =
    scene.expectedUserAction?.required ||
    expectedAction === 'confirm' ||
    expectedAction === 'decision' ||
    expectedAction === 'approval';
  const activeTurnMatchesScene =
    !activeTurnId.trim() ||
    !scene.turnId?.trim() ||
    activeTurnId.trim() === scene.turnId.trim();
  const sceneLlmRunning = llmRunning && activeTurnMatchesScene;
  const sceneWorkActive =
    sceneLlmRunning || eventStatus === 'sending' || eventStatus === 'continuing';

  useEffect(() => {
    const host = sceneHostRef.current;
    const inspector = sceneInspectorRef.current;
    if (!host || !inspector) {
      return undefined;
    }
    let frame = 0;
    const report = () => {
      if (frame) {
        window.cancelAnimationFrame(frame);
      }
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const feedback = sceneFeedbackRef.current;
        const nodeList = sceneNodeListRef.current;
        const actions = feedback?.querySelector('.scene-feedback-actions');
        const hostRect = host.getBoundingClientRect();
        const inspectorRect = inspector.getBoundingClientRect();
        const actionsRect =
          actions instanceof HTMLElement ? actions.getBoundingClientRect() : null;
        const actionClipped =
          actionsRect != null && actionsRect.bottom > inspectorRect.bottom + 1;
        const inspectorNeedsScroll =
          inspector.scrollHeight > inspector.clientHeight + 1;
        const hostNeedsScroll =
          host.scrollHeight > host.clientHeight + 1 ||
          host.scrollWidth > host.clientWidth + 1;
        if (!actionClipped && !inspectorNeedsScroll && !hostNeedsScroll) {
          return;
        }
        console.debug('[cardbush:scene-layout]', {
          sceneId: scene.sceneId,
          window: {
            width: window.innerWidth,
            height: window.innerHeight,
          },
          host: {
            width: Math.round(hostRect.width),
            height: Math.round(hostRect.height),
            clientWidth: host.clientWidth,
            clientHeight: host.clientHeight,
            scrollWidth: host.scrollWidth,
            scrollHeight: host.scrollHeight,
          },
          inspector: {
            top: Math.round(inspectorRect.top),
            bottom: Math.round(inspectorRect.bottom),
            clientHeight: inspector.clientHeight,
            scrollHeight: inspector.scrollHeight,
            scrollTop: inspector.scrollTop,
          },
          nodeList: nodeList
            ? {
                clientHeight: nodeList.clientHeight,
                scrollHeight: nodeList.scrollHeight,
              }
            : null,
          feedback: feedback
            ? {
                clientHeight: feedback.clientHeight,
                scrollHeight: feedback.scrollHeight,
              }
            : null,
          actionsBottom: actionsRect ? Math.round(actionsRect.bottom) : null,
          actionClipped,
        });
      });
    };
    const observer = new ResizeObserver(report);
    observer.observe(host);
    observer.observe(inspector);
    if (sceneNodeListRef.current) {
      observer.observe(sceneNodeListRef.current);
    }
    if (sceneFeedbackRef.current) {
      observer.observe(sceneFeedbackRef.current);
    }
    window.addEventListener('resize', report);
    report();
    return () => {
      if (frame) {
        window.cancelAnimationFrame(frame);
      }
      observer.disconnect();
      window.removeEventListener('resize', report);
    };
  }, [
    error,
    eventStatus,
    feedbackQueue.length,
    scene.sceneId,
    showDecisionActions,
    notice,
  ]);

  const sceneNodeById = useMemo(() => {
    return new Map(scene.nodes.map((node) => [node.nodeId, node]));
  }, [scene.nodes]);
  const sceneNavigationItems = useMemo(() => {
    const addedNodeIds = new Set<string>();
    const items = sceneSteps.map((step, index) => {
      const node = step.nodeId ? sceneNodeById.get(step.nodeId) : undefined;
      if (step.nodeId) {
        addedNodeIds.add(step.nodeId);
      }
      return {
        key: step.nodeId ? `node:${step.nodeId}` : `step:${step.id}`,
        nodeId: step.nodeId ?? '',
        stepId: step.id,
        stepIndex: index,
        label:
          step.title ||
          node?.label ||
          (step.nodeId
            ? step.nodeId
            : language === 'zh'
              ? '整体设计概述'
              : 'Design overview'),
        purpose:
          step.nodeId
            ? node?.purpose || step.speech
            : step.speech || (language === 'zh' ? '整体说明' : 'Overview'),
        overview: !step.nodeId,
      };
    });
    for (const node of scene.nodes) {
      if (addedNodeIds.has(node.nodeId)) {
        continue;
      }
      items.push({
        key: `node:${node.nodeId}`,
        nodeId: node.nodeId,
        stepId: '',
        stepIndex: -1,
        label: node.label || node.nodeId,
        purpose: node.purpose || '',
        overview: false,
      });
    }
    return items;
  }, [language, scene.nodes, sceneNodeById, sceneSteps]);
  const currentFeedbackTargetKey =
    freeTalkMode
      ? 'free_chat'
      : currentNodeId
        ? `node:${currentNodeId}`
        : `step:${activeStep?.id ?? 'overview'}`;
  const currentFeedbackStepId = freeTalkMode
    ? 'free_chat'
    : activeStep?.id ?? 'overview';
  const feedbackCountByTarget = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of feedbackQueue) {
      const key = item.nodeId ? `node:${item.nodeId}` : `step:${item.stepId ?? 'overview'}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [feedbackQueue]);
  const currentNodeLabel =
    freeTalkMode
      ? language === 'zh'
        ? '自由对话'
        : 'Free chat'
      : sceneNodeById.get(currentNodeId)?.label ||
        activeStep?.title ||
        currentNodeId ||
        (language === 'zh' ? '整体场景' : 'Overall scene');

  const requestAnchorRect = useCallback(
    (nodeId = currentNodeId, options?: { reveal?: boolean }) => {
      const targetNodeId = nodeId.trim();
      if (!targetNodeId) {
        setAnchorRect(null);
        return;
      }
      iframeRef.current?.contentWindow?.postMessage(
        {
          source: 'cardbush-scene-host',
          type: 'set_anchor',
          sceneId: scene.sceneId,
          reveal: options?.reveal === true,
          anchor: {
            nodeId: targetNodeId,
            selector: scene.cardling.anchor?.selector,
          },
        },
        '*',
      );
    },
    [currentNodeId, scene.cardling.anchor?.selector, scene.sceneId],
  );

  const syncSceneInteractionMode = useCallback(
    (freeMode = freeTalkMode) => {
      iframeRef.current?.contentWindow?.postMessage(
        {
          source: 'cardbush-scene-host',
          type: 'set_interaction_mode',
          sceneId: scene.sceneId,
          mode: freeMode ? 'free_chat' : 'node',
        },
        '*',
      );
    },
    [freeTalkMode, scene.sceneId],
  );

  useEffect(() => {
    syncSceneInteractionMode();
    if (freeTalkMode) {
      setAnchorRect(null);
    }
  }, [freeTalkMode, syncSceneInteractionMode]);

  const activateSceneStep = useCallback(
    (index: number, play = false) => {
      if (sceneSteps.length === 0) {
        return;
      }
      const nextIndex = Math.min(Math.max(index, 0), sceneSteps.length - 1);
      const nextStep = sceneSteps[nextIndex];
      setActiveStepIndex(nextIndex);
      setTypedSpeech('');
      setPlaybackRunning(play);
      if (nextStep?.nodeId) {
        setSelectedNodeId(nextStep.nodeId);
        window.requestAnimationFrame(() =>
          requestAnchorRect(nextStep.nodeId, { reveal: true }),
        );
      } else {
        setSelectedNodeId('');
        setAnchorRect(null);
      }
    },
    [requestAnchorRect, sceneSteps],
  );

  const activateSceneNode = useCallback(
    (nodeId: string, play = false) => {
      const stepIndex = sceneSteps.findIndex((step) => step.nodeId === nodeId);
      if (stepIndex >= 0) {
        activateSceneStep(stepIndex, play);
        return;
      }
      const node = scene.nodes.find((candidate) => candidate.nodeId === nodeId);
      setSelectedNodeId(nodeId);
      setTypedSpeech(nodePurposeSpeech(node, language));
      setPlaybackRunning(false);
      window.requestAnimationFrame(() => requestAnchorRect(nodeId, { reveal: true }));
    },
    [activateSceneStep, language, requestAnchorRect, scene.nodes, sceneSteps],
  );

  const restartScenePlayback = useCallback(() => {
    activateSceneStep(0, true);
  }, [activateSceneStep]);

  const toggleScenePlayback = useCallback(() => {
    if (playbackRunning) {
      setPlaybackRunning(false);
      return;
    }
    if (activeStep && typedSpeech.length >= activeStep.speech.length) {
      if (activeStepIndex >= sceneSteps.length - 1) {
        restartScenePlayback();
        return;
      }
      activateSceneStep(activeStepIndex + 1, true);
      return;
    }
    setPlaybackRunning(true);
  }, [
    activeStep,
    activeStepIndex,
    activateSceneStep,
    playbackRunning,
    restartScenePlayback,
    sceneSteps.length,
    typedSpeech.length,
  ]);

  const toggleFreeTalkMode = useCallback(() => {
    const next = !freeTalkMode;
    setFreeTalkMode(next);
    setKabuDialogOpen(next);
    setTypedSpeech('');
    setPlaybackRunning(false);
    syncSceneInteractionMode(next);
    if (next) {
      setSelectedNodeId('');
      setAnchorRect(null);
      return;
    }
    const nodeId = activeStep?.nodeId?.trim() || selectedNodeId;
    if (nodeId) {
      window.requestAnimationFrame(() => requestAnchorRect(nodeId, { reveal: true }));
    }
  }, [
    activeStep?.nodeId,
    freeTalkMode,
    requestAnchorRect,
    selectedNodeId,
    syncSceneInteractionMode,
  ]);

  useEffect(() => {
    setAnchorRect(null);
    setSelectedNodeId(initialSceneSelectedNodeId(scene, sceneSteps));
    setActiveStepIndex(0);
    setTypedSpeech('');
    setPlaybackRunning(initialAutoPlay && sceneSteps.length > 0);
    setComment('');
    setFeedbackQueue([]);
    setNotice('');
    setError('');
    setEventStatus('idle');
    setSceneState(initialSceneRuntimeState(scene));
    setSceneHealth(initialSceneHealth(scene));
    setInspectorCollapsed(false);
    setFreeTalkMode(false);
    setKabuDialogOpen(false);
    setKabuDraft('');
    lastSceneHealthKeyRef.current = '';
    setDecisionSubmitting('');
  }, [initialAutoPlay, scene, sceneSteps]);

  useEffect(() => {
    if (sceneSteps.length === 0) {
      return;
    }
    setActiveStepIndex((index) => Math.min(index, sceneSteps.length - 1));
  }, [sceneSteps.length]);

  useEffect(() => {
    if (freeTalkMode) {
      setAnchorRect(null);
      return;
    }
    if (!activeStep?.nodeId) {
      setAnchorRect(null);
      return;
    }
    setSelectedNodeId(activeStep.nodeId);
    const frame = window.requestAnimationFrame(() =>
      requestAnchorRect(activeStep.nodeId, { reveal: true }),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [activeStep?.id, activeStep?.nodeId, freeTalkMode, requestAnchorRect]);

  const recordSceneRuntimeEvent = useCallback(
    (
      type: SceneRuntimeEventType | string,
      payload: Record<string, unknown>,
      nodeId = '',
    ) => {
      setSceneState((current) =>
        appendSceneRuntimeEvent(current, {
          id: `scene-event-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          type,
          nodeId: nodeId || undefined,
          payload,
          createdAt: new Date().toISOString(),
        }),
      );
    },
    [],
  );

  const applyBridgeRuntimeState = useCallback(
    (value: unknown) => {
      if (value == null) {
        return;
      }
      setSceneState((current) =>
        mergeSceneRuntimeState(
          current,
          normalizeSceneRuntimeState(value, scene, current),
        ),
      );
    },
    [scene],
  );

  const applyBridgeHealth = useCallback(
    (value: unknown, trigger: string) => {
      if (value == null) {
        return;
      }
      const health = normalizeSceneHealth(value, scene);
      setSceneHealth(health);
      const key = sceneHealthKey(health);
      if (key === lastSceneHealthKeyRef.current || health.ok) {
        return;
      }
      lastSceneHealthKeyRef.current = key;
      void sendSceneUserEvent(scene, {
        event: 'scene_health',
        values: { health },
        metadata: {
          kind: 'scene_health',
          trigger,
        },
      }).catch(() => undefined);
    },
    [scene],
  );

  const openSceneTarget = useCallback(
    async (payload: Record<string, unknown>) => {
      const target = sceneOpenTargetFromPayload(payload);
      if (!target) {
        setError(
          language === 'zh'
            ? '这个打开动作缺少可识别的链接或本地路径。'
            : 'This open action does not include a recognizable link or local path.',
        );
        return;
      }
      setError('');
      setNotice(
        language === 'zh'
          ? target.kind === 'url'
            ? '正在打开链接...'
            : '正在打开本地文件...'
          : target.kind === 'url'
            ? 'Opening link...'
            : 'Opening local file...',
      );
      try {
        if (target.kind === 'url') {
          await (
            window.cardbushDesktop?.openUiPreview ??
            window.cardbushDesktop?.openExternal
          )?.(target.target);
          setNotice(
            language === 'zh'
              ? '链接已在 CardBush UI 预览窗口中打开。'
              : 'The link was opened in the CardBush UI preview window.',
          );
          return;
        }
        const result = await window.cardbushDesktop?.openPath?.(target.target);
        if (result && result.trim()) {
          throw new Error(result);
        }
        setNotice(
          language === 'zh'
            ? '已交给系统打开本地文件。'
            : 'The local file was handed to the system.',
        );
      } catch (caught) {
        setNotice('');
        setError(
          language === 'zh'
            ? `打开失败：${errorMessage(caught)}`
            : `Open failed: ${errorMessage(caught)}`,
        );
      }
    },
    [language],
  );

  useEffect(() => {
    const speech = activeStep?.speech ?? '';
    if (!playbackRunning || !speech) {
      return;
    }
    if (typedSpeech.length >= speech.length) {
      if (activeStepIndex >= sceneSteps.length - 1) {
        setPlaybackRunning(false);
        return;
      }
      const timeout = window.setTimeout(
        () => activateSceneStep(activeStepIndex + 1, true),
        activeStep?.holdMs ?? 850,
      );
      return () => window.clearTimeout(timeout);
    }
    const chunkSize = speech.length > 140 ? 2 : 1;
    const timeout = window.setTimeout(() => {
      setTypedSpeech(speech.slice(0, Math.min(speech.length, typedSpeech.length + chunkSize)));
    }, 22);
    return () => window.clearTimeout(timeout);
  }, [
    activeStep?.holdMs,
    activeStep?.speech,
    activeStepIndex,
    activateSceneStep,
    playbackRunning,
    sceneSteps.length,
    typedSpeech,
  ]);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.source !== iframeRef.current?.contentWindow) {
        return;
      }
      const data = asRecord(event.data);
      if (data.source !== 'cardbush-scene' || data.sceneId !== scene.sceneId) {
        return;
      }
      const type = String(data.type ?? '');
      const nodeId = String(data.nodeId ?? currentNodeId).trim();
      if (
        freeTalkMode &&
        [
          'node_click',
          'selection_change',
          'node_drag_start',
          'node_drag_end',
          'node_reorder',
        ].includes(type)
      ) {
        return;
      }
      if (data.state != null) {
        applyBridgeRuntimeState(data.state);
      }
      if (data.health != null) {
        applyBridgeHealth(data.health, type || 'bridge');
      }
      if (type === 'scene_ready') {
        if (currentNodeId) {
          requestAnchorRect(currentNodeId, { reveal: true });
        } else {
          setAnchorRect(null);
        }
        recordSceneRuntimeEvent(type, asRecord(data), nodeId);
        void sendSceneUserEvent(scene, {
          event: 'scene_ready',
          values: {
            state: data.state,
            health: data.health,
          },
          metadata: { title: scene.title },
        }).catch(() => undefined);
        return;
      }
      if (type === 'anchor_rect') {
        const rect = asRecord(data.rect);
        setAnchorRect({
          nodeId: String(data.nodeId ?? currentNodeId),
          rect: {
            left: Number(rect.left) || 0,
            top: Number(rect.top) || 0,
            width: Number(rect.width) || 0,
            height: Number(rect.height) || 0,
          },
          tone: data.tone === 'light' ? 'light' : 'dark',
        });
        return;
      }
      if (type === 'anchor_missing') {
        setAnchorRect(null);
        return;
      }
      if (type === 'scene_health') {
        recordSceneRuntimeEvent(type, asRecord(data), nodeId);
        return;
      }
      if (type === 'scene_error') {
        const message = String(data.message ?? data.error ?? '').trim();
        recordSceneRuntimeEvent(type, asRecord(data), nodeId);
        if (message) {
          setError(
            language === 'zh'
              ? `场景脚本错误：${message}`
              : `Scene script error: ${message}`,
          );
        }
        void sendSceneUserEvent(scene, {
          event: 'scene_error',
          nodeId,
          values: {
            message,
            stack: String(data.stack ?? ''),
          },
          metadata: { kind: 'scene_health' },
        }).catch(() => undefined);
        return;
      }
      if (type === 'node_click') {
        if (nodeId) {
          activateSceneNode(nodeId);
          recordSceneRuntimeEvent(type, asRecord(data), nodeId);
          void sendSceneUserEvent(scene, {
            event: 'node_click',
            nodeId,
            values: { state: data.state },
            metadata: { label: data.label },
          }).catch(() => undefined);
        }
        return;
      }
      if (sceneRuntimeEventTypes.has(type)) {
        recordSceneRuntimeEvent(type, asRecord(data), nodeId);
        void sendSceneUserEvent(scene, {
          event: type,
          nodeId,
          values: {
            state: data.state,
            order: data.order,
            previous_order: data.previousOrder ?? data.previous_order,
            values: data.values,
            action: data.action,
            route: data.route,
          },
          metadata: {
            kind: 'scene_runtime_event',
            label: data.label,
            source: data.source,
          },
        })
          .then(async (response) => {
            if (
              type === 'request_llm_action' &&
              !sceneLlmRunning &&
              !sceneEventContinuesTurn(response)
            ) {
              const prompt = formatSceneActionRunPrompt(scene, data, language);
              if (prompt) {
                await onSendFeedbackToLlm(prompt);
              }
            }
          })
          .catch((caught) => setError(sceneEventError(caught, language)));
        if (type === 'selection_change' && nodeId) {
          activateSceneNode(nodeId);
        }
        if (type === 'node_reorder') {
          setNotice(
            language === 'zh'
              ? '节点顺序已同步给后端。'
              : 'Node order synced to the backend.',
          );
        }
        if (type === 'scene_toast') {
          const message = String(data.message ?? '').trim();
          if (message) {
            setNotice(message);
          }
        }
        return;
      }
      if (type === 'form_submit') {
        recordSceneRuntimeEvent(type, asRecord(data), nodeId);
        void sendSceneUserEvent(scene, {
          event: 'form_submit',
          nodeId,
          values: asRecord(data.values),
          metadata: { state: data.state },
        })
          .then(() =>
            setNotice(
              language === 'zh'
                ? '表单事件已发送给后端'
                : 'Form event sent to backend',
            ),
          )
          .catch((caught) => setError(sceneEventError(caught, language)));
        return;
      }
      if (type === 'external_url') {
        const target = sceneOpenTargetFromPayload(data);
        if (target) {
          recordSceneRuntimeEvent(type, { ...data, target: target.target }, nodeId);
          void sendSceneUserEvent(scene, {
            event: 'external_url',
            nodeId,
            metadata: {
              url: target.kind === 'url' ? target.target : undefined,
              path: target.kind === 'path' ? target.target : undefined,
              kind: target.kind,
              label: target.label,
            },
          }).catch(() => undefined);
          void openSceneTarget(data);
        }
      }
    }
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [
    activateSceneNode,
    applyBridgeHealth,
    applyBridgeRuntimeState,
    currentNodeId,
    freeTalkMode,
    language,
    onSendFeedbackToLlm,
    openSceneTarget,
    recordSceneRuntimeEvent,
    requestAnchorRect,
    scene,
    sceneLlmRunning,
  ]);

  const addFeedbackToQueue = useCallback(() => {
    const text = comment.trim();
    if (!text) {
      return;
    }
    setFeedbackQueue((current) => [
      ...current,
      {
        id: sceneFeedbackId(),
        nodeId: currentNodeId,
        stepId: currentNodeId ? undefined : currentFeedbackStepId,
        nodeLabel: currentNodeLabel,
        text,
        createdAt: new Date().toISOString(),
      },
    ]);
    setComment('');
    setError('');
    setEventStatus('idle');
    setNotice(
      language === 'zh'
        ? sceneLlmRunning
          ? '已加入反馈清单，不会打断 LLM 当前思考。'
          : '已加入反馈清单，可继续选择节点补充。'
        : sceneLlmRunning
          ? 'Added to the feedback list without interrupting the current run.'
          : 'Added to the feedback list. You can keep reviewing nodes.',
    );
  }, [
    comment,
    currentFeedbackStepId,
    currentNodeId,
    currentNodeLabel,
    language,
    sceneLlmRunning,
  ]);

  const removeFeedback = useCallback((id: string) => {
    setFeedbackQueue((current) => current.filter((item) => item.id !== id));
  }, []);

  const submitImmediateComment = useCallback(async () => {
    const text = comment.trim();
    if (!text || submitting) {
      return;
    }
    setSubmitting(true);
    setEventStatus('sending');
    setError('');
    try {
      const feedback: CardlingSceneFeedback = {
        id: sceneFeedbackId(),
        nodeId: currentNodeId,
        stepId: currentNodeId ? undefined : currentFeedbackStepId,
        nodeLabel: currentNodeLabel,
        text,
        createdAt: new Date().toISOString(),
      };
      const response = await sendSceneUserEvent(scene, {
        event: 'comment',
        nodeId: currentNodeId,
        text,
        metadata: {
          step_id: currentNodeId ? undefined : currentFeedbackStepId,
          target_key: currentFeedbackTargetKey,
          target_label: currentNodeLabel,
          target_kind: freeTalkMode ? 'free_chat' : currentNodeId ? 'node' : 'step',
        },
      });
      const continued =
        sceneEventContinuesTurn(response) || sceneEventDelivery(response) === 'guidance';
      if (!sceneLlmRunning && !continued) {
        await onSendFeedbackToLlm(
          formatSceneFeedbackRunPrompt(scene, [feedback], language),
        );
      }
      setEventStatus(continued || sceneLlmRunning ? 'continuing' : 'recorded');
      setComment('');
      setNotice(
        language === 'zh'
          ? continued || sceneLlmRunning
            ? '这条反馈已交给 LLM 继续处理。'
            : '这条反馈已发送给 LLM 处理。'
          : continued || sceneLlmRunning
            ? 'This feedback was handed to the running LLM task.'
            : 'This feedback was sent to the LLM.',
      );
    } catch (caught) {
      setEventStatus('failed');
      setError(sceneEventError(caught, language));
    } finally {
      setSubmitting(false);
    }
  }, [
    comment,
    currentFeedbackStepId,
    currentFeedbackTargetKey,
    currentNodeId,
    currentNodeLabel,
    freeTalkMode,
    language,
    onSendFeedbackToLlm,
    scene,
    sceneLlmRunning,
    submitting,
  ]);

  const submitKabuDialog = useCallback(async () => {
    const text = kabuDraft.trim();
    if (!text || submitting) {
      return;
    }
    setSubmitting(true);
    setEventStatus('sending');
    setError('');
    try {
      const response = await sendSceneUserEvent(scene, {
        event: 'comment',
        nodeId: currentNodeId,
        text,
        metadata: {
          kind: 'kabu_chat',
          step_id: currentNodeId ? undefined : currentFeedbackStepId,
          target_key: currentFeedbackTargetKey,
          target_label: currentNodeLabel,
          target_kind: freeTalkMode ? 'free_chat' : currentNodeId ? 'node' : 'step',
        },
      });
      const continued =
        sceneEventContinuesTurn(response) || sceneEventDelivery(response) === 'guidance';
      if (!sceneLlmRunning && !continued) {
        await onSendFeedbackToLlm(
          formatSceneKabuChatPrompt(scene, {
            text,
            nodeId: currentNodeId,
            nodeLabel: currentNodeLabel,
            stepId: currentNodeId ? undefined : currentFeedbackStepId,
            language,
          }),
        );
      }
      setKabuDraft('');
      setKabuDialogOpen(false);
      setEventStatus(continued || sceneLlmRunning ? 'continuing' : 'recorded');
      setNotice(
        language === 'zh'
          ? continued || sceneLlmRunning
            ? '卡布已把这句话交给正在运行的任务。'
            : '卡布已把这句话发给 LLM 继续处理。'
          : continued || sceneLlmRunning
            ? 'Kabu handed this message to the running task.'
            : 'Kabu sent this message to the LLM.',
      );
    } catch (caught) {
      setEventStatus('failed');
      setError(sceneEventError(caught, language));
    } finally {
      setSubmitting(false);
    }
  }, [
    currentFeedbackStepId,
    currentFeedbackTargetKey,
    currentNodeId,
    currentNodeLabel,
    freeTalkMode,
    kabuDraft,
    language,
    onSendFeedbackToLlm,
    scene,
    sceneLlmRunning,
    submitting,
  ]);

  const submitFeedbackQueue = useCallback(async () => {
    if (feedbackQueue.length === 0 || submitting) {
      return;
    }
    const feedbackToSubmit = feedbackQueue;
    setSubmitting(true);
    setEventStatus('sending');
    setError('');
    try {
      const response = await sendSceneUserEvent(scene, {
        event: 'form_submit',
        nodeId: currentNodeId,
        values: {
          kind: 'scene_feedback_batch',
          count: feedbackToSubmit.length,
          comments: feedbackToSubmit.map((item) => ({
            node_id: item.nodeId,
            step_id: item.stepId,
            target_kind:
              item.stepId === 'free_chat' ? 'free_chat' : item.nodeId ? 'node' : 'step',
            node_label: item.nodeLabel,
            text: item.text,
            created_at: item.createdAt,
          })),
        },
        metadata: {
          kind: 'scene_feedback_batch',
          count: feedbackToSubmit.length,
          delivery: sceneLlmRunning ? 'guidance' : 'recorded',
        },
      });
      const continued =
        sceneEventContinuesTurn(response) || sceneEventDelivery(response) === 'guidance';
      if (!sceneLlmRunning && !continued) {
        await onSendFeedbackToLlm(
          formatSceneFeedbackRunPrompt(scene, feedbackToSubmit, language),
        );
      }
      setEventStatus(continued || sceneLlmRunning ? 'continuing' : 'recorded');
      setFeedbackQueue([]);
      setNotice(
        language === 'zh'
          ? continued || sceneLlmRunning
            ? '反馈清单已提交给正在运行的任务。'
            : '反馈清单已发送给 LLM 处理。'
          : continued || sceneLlmRunning
            ? 'Feedback list submitted to the running task.'
            : 'Feedback list sent to the LLM.',
      );
    } catch (caught) {
      setEventStatus('failed');
      setError(sceneEventError(caught, language));
    } finally {
      setSubmitting(false);
    }
  }, [
    currentNodeId,
    feedbackQueue,
    language,
    onSendFeedbackToLlm,
    scene,
    sceneLlmRunning,
    submitting,
  ]);

  const submitDecision = useCallback(
    async (event: 'confirm' | 'cancel') => {
      if (decisionSubmitting) {
        return;
      }
      setDecisionSubmitting(event);
      setError('');
      try {
        await sendSceneUserEvent(scene, {
          event,
          nodeId: currentNodeId,
          metadata: { expectedAction },
        });
        setNotice(
          event === 'confirm'
            ? language === 'zh'
              ? '确认已发送给后端'
              : 'Confirmation sent to backend'
            : language === 'zh'
              ? '取消已发送给后端'
              : 'Cancellation sent to backend',
        );
      } catch (caught) {
        setError(sceneEventError(caught, language));
      } finally {
        setDecisionSubmitting('');
      }
    },
    [currentNodeId, decisionSubmitting, expectedAction, language, scene],
  );

  return (
    <section ref={sceneHostRef} className="scene-host" aria-label={scene.title}>
      <header className="scene-toolbar">
        <div className="scene-toolbar-title">
          <Sparkles size={16} />
          <span>
            <strong>{scene.title}</strong>
            <small>
              {language === 'zh'
                ? 'HTML 任务场景'
                : 'HTML task scene'}
            </small>
          </span>
        </div>
        <div className={`scene-runtime-pill ${sceneWorkActive ? 'running' : 'idle'}`}>
          {sceneWorkActive ? <LoaderCircle size={13} /> : <Bot size={13} />}
          <span>
            {eventStatus === 'sending'
              ? language === 'zh'
                ? '正在提交反馈'
                : 'Submitting feedback'
              : sceneWorkActive
              ? language === 'zh'
                ? 'LLM 正在思考'
                : 'LLM thinking'
              : language === 'zh'
                ? '卡布待命'
                : 'Kabu ready'}
          </span>
        </div>
        <button
          className={`scene-free-talk-toggle ${freeTalkMode ? 'active' : ''}`}
          type="button"
          onClick={toggleFreeTalkMode}
          title={
            freeTalkMode
              ? language === 'zh'
                ? '切回节点讲解'
                : 'Return to node narration'
              : language === 'zh'
                ? '开启自由对话，测试页面时不切换节点'
                : 'Enable free chat without retargeting nodes while testing the page'
          }
        >
          <MessageSquare size={14} />
          <span>
            {freeTalkMode
              ? language === 'zh'
                ? '自由对话'
                : 'Free chat'
              : language === 'zh'
                ? '节点讲解'
                : 'Node mode'}
          </span>
        </button>
        {sceneSteps.length > 0 && (
          <div
            className="scene-playback-controls"
            aria-label={language === 'zh' ? '场景播放控制' : 'Scene playback controls'}
          >
            <button
              type="button"
              onClick={restartScenePlayback}
              title={language === 'zh' ? '重播讲解' : 'Replay narration'}
            >
              <RotateCcw size={14} />
            </button>
            <button
              type="button"
              disabled={activeStepIndex <= 0}
              onClick={() => activateSceneStep(activeStepIndex - 1)}
              title={language === 'zh' ? '上一个节点' : 'Previous node'}
            >
              <ArrowLeft size={14} />
            </button>
            <button
              type="button"
              onClick={toggleScenePlayback}
              title={playbackRunning
                ? language === 'zh'
                  ? '暂停讲解'
                  : 'Pause narration'
                : language === 'zh'
                  ? '继续讲解'
                  : 'Resume narration'}
            >
              {playbackRunning ? <Pause size={14} /> : <Play size={14} />}
            </button>
            <button
              type="button"
              disabled={activeStepIndex >= sceneSteps.length - 1}
              onClick={() => activateSceneStep(activeStepIndex + 1)}
              title={language === 'zh' ? '下一个节点' : 'Next node'}
            >
              <ArrowRight size={14} />
            </button>
            <span>{`${Math.min(activeStepIndex + 1, sceneSteps.length)}/${sceneSteps.length}`}</span>
          </div>
        )}
        <button
          className={`scene-inspector-toggle ${inspectorCollapsed ? 'collapsed' : ''}`}
          type="button"
          onClick={() => setInspectorCollapsed((current) => !current)}
          title={
            inspectorCollapsed
              ? language === 'zh'
                ? '展开反馈面板'
                : 'Show feedback panel'
              : language === 'zh'
                ? '折叠反馈面板'
                : 'Hide feedback panel'
          }
        >
          {inspectorCollapsed ? (
            <PanelRightOpen size={16} />
          ) : (
            <PanelRightClose size={16} />
          )}
          {feedbackQueue.length > 0 && <span>{feedbackQueue.length}</span>}
        </button>
        <button
          type="button"
          onClick={() => requestAnchorRect()}
          title={language === 'zh' ? '重新同步卡布位置' : 'Resync Kabu position'}
        >
          <RefreshCw size={15} />
        </button>
        <button
          type="button"
          onClick={onClose}
          title={language === 'zh' ? '返回对话' : 'Back to chat'}
        >
          <X size={16} />
        </button>
      </header>
      <div className={`scene-body ${inspectorCollapsed ? 'inspector-collapsed' : ''}`}>
        <div className="scene-viewport">
          <iframe
            ref={iframeRef}
            title={scene.title}
            sandbox="allow-forms allow-scripts"
            srcDoc={srcDoc}
            onLoad={() => {
              syncSceneInteractionMode();
              if (freeTalkMode) {
                setAnchorRect(null);
              } else if (currentNodeId) {
                requestAnchorRect(currentNodeId, { reveal: true });
              } else {
                setAnchorRect(null);
              }
            }}
          />
          {(embedded || activeSpeech) && (
            <div
              className={`scene-cardling ${embedded ? 'embedded' : 'floating'} ${embedded && !cardlingAnchorRect ? 'fallback' : ''} mood-${scene.cardling.mood} tone-${cardlingAnchorRect?.tone ?? 'dark'}`}
              style={
                embedded
                  ? sceneCardlingStyle(cardlingAnchorRect, scene.cardling.anchor)
                  : sceneFloatingCardlingStyle(scene.cardling.position)
              }
            >
              <button
                className="scene-cardling-avatar scene-cardling-avatar-button"
                type="button"
                aria-label={language === 'zh' ? '和卡布对话' : 'Talk to Kabu'}
                title={language === 'zh' ? '和卡布对话' : 'Talk to Kabu'}
                onClick={() => setKabuDialogOpen((current) => !current)}
              >
                <span className="cardling-orbit" />
                <span className="cardling-card">
                  <span className="cardling-stack" />
                  <span className="cardling-leaf" />
                  <span className="cardling-eye left" />
                  <span className="cardling-eye right" />
                  <span className="cardling-wave" />
                  <span className="cardling-cursor" />
                  <span className="cardling-error-corner" />
                  <span className="cardling-spark one" />
                  <span className="cardling-spark two" />
                </span>
              </button>
              {activeSpeech && (
                <div className="scene-cardling-bubble">
                  <span>{displayedSpeech}</span>
                  {playbackRunning && typedSpeech.length < activeSpeech.length && (
                    <i aria-hidden="true" />
                  )}
                  {sceneWorkActive && !playbackRunning && (
                    <small>
                      <LoaderCircle size={11} />
                      {language === 'zh'
                        ? eventStatus === 'sending'
                          ? '我正在把反馈交给后端和 LLM。'
                          : '我正在跟进任务，反馈会先收进清单。'
                        : eventStatus === 'sending'
                          ? 'I am sending the feedback to the backend and LLM.'
                          : 'I am following the task. Feedback is collected first.'}
                    </small>
                  )}
                </div>
              )}
            </div>
          )}
          {kabuDialogOpen && (
            <div
              className="scene-kabu-dialog"
              style={sceneKabuDialogStyle(cardlingAnchorRect, scene.cardling.anchor)}
            >
              <header>
                <Sparkles size={14} />
                <strong>{language === 'zh' ? '和卡布说' : 'Talk to Kabu'}</strong>
                <button
                  type="button"
                  onClick={() => setKabuDialogOpen(false)}
                  title={language === 'zh' ? '关闭' : 'Close'}
                >
                  <X size={13} />
                </button>
              </header>
              <small>
                {freeTalkMode
                  ? language === 'zh'
                    ? '自由对话：不绑定具体节点'
                    : 'Free chat: not bound to a specific node'
                  : currentNodeId
                  ? `${language === 'zh' ? '当前节点' : 'Current node'}: ${currentNodeLabel}`
                  : activeStep?.title ||
                    (language === 'zh' ? '整体场景' : 'Overall scene')}
              </small>
              <textarea
                value={kabuDraft}
                autoFocus
                placeholder={
                  language === 'zh'
                    ? freeTalkMode
                      ? '和卡布自由聊这个页面、交互感受或测试结果...'
                      : '告诉卡布你想调整哪里，或让它解释这个节点...'
                    : freeTalkMode
                      ? 'Freely talk with Kabu about this page, interactions, or test results...'
                      : 'Tell Kabu what to adjust, or ask it to explain this node...'
                }
                onChange={(event) => setKabuDraft(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                    event.preventDefault();
                    void submitKabuDialog();
                  }
                }}
              />
              <footer>
                <button type="button" onClick={() => setKabuDraft('')}>
                  {language === 'zh' ? '清空' : 'Clear'}
                </button>
                <button
                  className="primary-button"
                  type="button"
                  disabled={submitting || !kabuDraft.trim()}
                  onClick={() => void submitKabuDialog()}
                >
                  {submitting ? <LoaderCircle size={13} /> : <ArrowUp size={13} />}
                  {language === 'zh' ? '发送' : 'Send'}
                </button>
              </footer>
            </div>
          )}
        </div>
        <aside
          ref={sceneInspectorRef}
          className={`scene-inspector ${inspectorCollapsed ? 'collapsed' : ''}`}
        >
          {inspectorCollapsed ? (
            <button
              className="scene-inspector-rail"
              type="button"
              onClick={() => setInspectorCollapsed(false)}
              title={language === 'zh' ? '展开节点反馈' : 'Show node feedback'}
            >
              <MessageSquare size={15} />
              {feedbackQueue.length > 0 && <span>{feedbackQueue.length}</span>}
            </button>
          ) : (
            <>
          <strong>{language === 'zh' ? '节点反馈' : 'Node feedback'}</strong>
          <p>
            {freeTalkMode
              ? language === 'zh'
                ? '自由对话模式：页面点击不会切换节点。'
                : 'Free chat mode: page clicks will not retarget nodes.'
              : currentNodeId
              ? `${language === 'zh' ? '当前节点' : 'Current node'}: ${currentNodeId}`
              : activeStep?.title
                ? `${language === 'zh' ? '当前步骤' : 'Current step'}: ${activeStep.title}`
              : language === 'zh'
                ? '点击场景里的节点来定位反馈。'
                : 'Click a node in the scene to target feedback.'}
          </p>
          {!sceneHealth.ok && (
            <div className="scene-health-warning">
              <AlertCircle size={14} />
              <span>
                <strong>
                  {language === 'zh'
                    ? '场景部分渲染异常'
                    : 'Scene rendered with issues'}
                </strong>
                <small>
                  {sceneHealth.issues[0]?.message ||
                    (language === 'zh'
                      ? '已把健康检查结果回传后端。'
                      : 'Health check was sent to the backend.')}
                  {sceneHealth.issues.length > 1
                    ? language === 'zh'
                      ? `，另有 ${sceneHealth.issues.length - 1} 项`
                      : `, plus ${sceneHealth.issues.length - 1} more`
                    : ''}
                </small>
              </span>
            </div>
          )}
          <div className="scene-state-strip">
            <span>
              {language === 'zh'
                ? `节点 ${sceneState.nodes.length}`
                : `Nodes ${sceneState.nodes.length}`}
            </span>
            <span>
              {language === 'zh'
                ? `事件 ${sceneState.userEvents.length}`
                : `Events ${sceneState.userEvents.length}`}
            </span>
          </div>
          {sceneNavigationItems.length > 0 && (
            <div ref={sceneNodeListRef} className="scene-node-list">
              {sceneNavigationItems.map((item) => {
                const isActiveNode = item.nodeId
                  ? item.nodeId === currentNodeId
                  : !currentNodeId && activeStep?.id === item.stepId;
                const isPlayingNode = item.stepIndex === activeStepIndex;
                const feedbackCount = feedbackCountByTarget.get(item.key) ?? 0;
                return (
                  <button
                    key={item.key}
                    className={`${isActiveNode ? 'active' : ''} ${isPlayingNode ? 'playing' : ''} ${item.overview ? 'overview' : ''}`.trim()}
                    type="button"
                    onClick={() => {
                      if (item.stepIndex >= 0) {
                        activateSceneStep(item.stepIndex);
                      } else if (item.nodeId) {
                        activateSceneNode(item.nodeId);
                      }
                      if (item.nodeId) {
                        void sendSceneUserEvent(scene, {
                          event: 'node_click',
                          nodeId: item.nodeId,
                          metadata: {
                            label: item.label,
                            source: 'inspector',
                          },
                        }).catch(() => undefined);
                      } else {
                        void sendSceneUserEvent(scene, {
                          event: 'scene_step_select',
                          metadata: {
                            step_id: item.stepId,
                            label: item.label,
                            source: 'inspector',
                          },
                        }).catch(() => undefined);
                      }
                    }}
                  >
                    <span>
                      {item.label}
                      {feedbackCount > 0 && <em>{feedbackCount}</em>}
                    </span>
                    {item.purpose && <small>{item.purpose}</small>}
                  </button>
                );
              })}
            </div>
          )}
          <div ref={sceneFeedbackRef} className="scene-feedback-panel">
            <div className={`scene-feedback-status ${sceneWorkActive ? 'running' : 'idle'}`}>
              {sceneWorkActive ? <LoaderCircle size={14} /> : <Sparkles size={14} />}
              <span>
                <strong>
                  {eventStatus === 'sending'
                    ? language === 'zh'
                      ? '正在提交反馈'
                      : 'Submitting feedback'
                    : sceneWorkActive
                    ? language === 'zh'
                      ? 'LLM 正在处理'
                      : 'LLM is running'
                    : language === 'zh'
                      ? '反馈清单'
                      : 'Feedback list'}
                </strong>
                <small>
                  {eventStatus === 'sending'
                    ? language === 'zh'
                      ? '正在把反馈交给后端，随后会触发 LLM 处理。'
                      : 'Sending feedback to the backend, then the LLM will process it.'
                    : eventStatus === 'recorded'
                      ? language === 'zh'
                        ? '反馈已提交。若没有运行中任务，前端已发起一轮 LLM 请求。'
                        : 'Feedback submitted. If no task was running, a new LLM request was started.'
                    : eventStatus === 'failed'
                      ? language === 'zh'
                        ? '反馈提交失败，请查看错误信息。'
                        : 'Feedback submission failed. See the error below.'
                    : sceneWorkActive
                    ? language === 'zh'
                      ? '继续添加反馈，默认不会打断当前思考。'
                      : 'Keep adding feedback; it will not interrupt by default.'
                    : feedbackQueue.length > 0
                      ? language === 'zh'
                        ? `待提交 ${feedbackQueue.length} 条反馈`
                        : `${feedbackQueue.length} feedback item(s) pending`
                      : language === 'zh'
                        ? '点选页面节点后添加修改意见。'
                        : 'Select nodes and add review notes.'}
                </small>
              </span>
            </div>
            <textarea
              value={comment}
              placeholder={
                language === 'zh'
                  ? sceneLlmRunning
                    ? 'LLM 正在思考。这里写下反馈，先加入清单...'
                    : '对这个位置提出修改、疑问或确认...'
                  : sceneLlmRunning
                    ? 'LLM is thinking. Write feedback here and collect it first...'
                    : 'Comment, ask, or confirm this position...'
              }
              onChange={(event) => setComment(event.currentTarget.value)}
            />
            <div className="scene-feedback-actions">
              <button
                className="primary-button"
                type="button"
                disabled={!comment.trim()}
                onClick={addFeedbackToQueue}
              >
                <MessageSquare size={14} />
                {language === 'zh' ? '添加反馈' : 'Add feedback'}
              </button>
              <button
                type="button"
                disabled={submitting || !comment.trim()}
                onClick={() => void submitImmediateComment()}
                title={
                  language === 'zh'
                    ? '绕过清单，立即把当前这条反馈发给后端'
                    : 'Bypass the list and send this note immediately'
                }
              >
                {submitting ? <LoaderCircle size={14} /> : <ArrowUp size={14} />}
                {language === 'zh' ? '立即发送' : 'Send now'}
              </button>
            </div>
            {feedbackQueue.length > 0 && (
              <div className="scene-feedback-queue">
                <header>
                  <strong>
                    {language === 'zh'
                      ? `待提交反馈 ${feedbackQueue.length}`
                      : `Pending feedback ${feedbackQueue.length}`}
                  </strong>
                  <button type="button" onClick={() => setFeedbackQueue([])}>
                    {language === 'zh' ? '清空' : 'Clear'}
                  </button>
                </header>
                <div>
                  {feedbackQueue.map((item) => (
                    <article key={item.id}>
                      <span>{item.nodeLabel}</span>
                      <p>{item.text}</p>
                      <button
                        type="button"
                        title={language === 'zh' ? '移除这条反馈' : 'Remove this feedback'}
                        onClick={() => removeFeedback(item.id)}
                      >
                        <X size={12} />
                      </button>
                    </article>
                  ))}
                </div>
                <button
                  className="primary-button"
                  type="button"
                  disabled={submitting}
                  onClick={() => void submitFeedbackQueue()}
                >
                  {submitting ? <LoaderCircle size={14} /> : <Check size={14} />}
                  {language === 'zh' ? '提交全部反馈' : 'Submit all feedback'}
                </button>
              </div>
            )}
            {showDecisionActions && (
              <div className="scene-decision-actions">
                <button
                  type="button"
                  disabled={decisionSubmitting !== ''}
                  onClick={() => void submitDecision('cancel')}
                >
                  {decisionSubmitting === 'cancel' ? (
                    <LoaderCircle size={14} />
                  ) : (
                    <X size={14} />
                  )}
                  {language === 'zh' ? '取消' : 'Cancel'}
                </button>
                <button
                  className="primary-button"
                  type="button"
                  disabled={decisionSubmitting !== ''}
                  onClick={() => void submitDecision('confirm')}
                >
                  {decisionSubmitting === 'confirm' ? (
                    <LoaderCircle size={14} />
                  ) : (
                    <Check size={14} />
                  )}
                  {language === 'zh' ? '确认' : 'Confirm'}
                </button>
              </div>
            )}
            {notice && <p className="scene-notice">{notice}</p>}
            {error && <p className="scene-error">{error}</p>}
          </div>
            </>
          )}
        </aside>
      </div>
    </section>
  );
}


function asRecord(value: unknown) {
  return value != null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
