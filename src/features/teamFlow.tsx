import {
  LoaderCircle,
  Network,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import { useMemo } from 'react';

import type {
  AppLanguage,
  TeamFlowLayer,
  TeamFlowNode,
  TeamFlowState,
} from '../types';

export function TeamFlowDrawer({
  language,
  flow,
  loading,
  onRefresh,
}: {
  language: AppLanguage;
  flow: TeamFlowState | null;
  loading: boolean;
  onRefresh: () => Promise<TeamFlowState | null>;
}) {
  const currentLayer = useMemo(() => currentTeamLayer(flow), [flow]);
  const layers = flow?.layers ?? [];
  const summary =
    currentLayer?.title ||
    flow?.status ||
    (language === 'zh'
      ? '正常对话即可，后端会映射 DAG。'
      : 'Keep chatting; the backend maps the DAG.');

  return (
    <section className="team-flow-drawer">
      <div className="team-flow-drawer-panel">
        <div className="team-flow-drawer-head">
          <span>{summary}</span>
          <button className="team-flow-drawer-refresh" type="button" onClick={() => void onRefresh()}>
            {loading ? <LoaderCircle size={13} /> : <RefreshCw size={13} />}
            {language === 'zh' ? '刷新' : 'Refresh'}
          </button>
        </div>
        {flow ? (
          <>
            <div className="team-flow-drawer-dots" aria-label="Team Flow layers">
              {layers.length > 0 ? (
                layers.map((layer, index) => (
                  <span
                    className={`team-flow-dot ${teamFlowStatusClass(layer.status)} ${
                      layer.id === currentLayer?.id ? 'active' : ''
                    }`}
                    key={layer.id || index}
                    title={teamLayerTooltip(layer, language)}
                  />
                ))
              ) : (
                <span className="team-flow-dot active ready" />
              )}
            </div>
            <div className="team-flow-dag-grid">
              {teamFlowLayerCards(flow, language).map((layer) => (
                <article
                  className={`team-flow-layer-card ${teamFlowStatusClass(layer.status)}`}
                  key={layer.id}
                >
                  <header>
                    <span>{layer.kicker}</span>
                    <strong>{layer.title}</strong>
                    {layer.summary && <small>{layer.summary}</small>}
                  </header>
                  <div className="team-flow-layer-nodes">
                    {layer.nodes.length > 0 ? (
                      layer.nodes.map((node) => (
                        <div
                          className={`team-flow-layer-node ${teamFlowStatusClass(node.status)}`}
                          key={node.id}
                        >
                          <Network size={12} />
                          <span>
                            <strong>{node.title}</strong>
                            <small>{node.profileId || node.kind || node.summary}</small>
                          </span>
                        </div>
                      ))
                    ) : (
                      <em>{language === 'zh' ? '等待节点' : 'Waiting for nodes'}</em>
                    )}
                  </div>
                </article>
              ))}
            </div>
          </>
        ) : (
          <div className="team-flow-drawer-empty">
            {loading ? <LoaderCircle size={16} /> : <Sparkles size={16} />}
            <span>
              {language === 'zh'
                ? '发送任务后，这里会出现后端映射出的 DAG。'
                : 'After you send a task, the backend DAG will appear here.'}
            </span>
          </div>
        )}
      </div>
    </section>
  );
}

function currentTeamLayer(flow: TeamFlowState | null) {
  if (!flow) {
    return null;
  }
  if (flow.currentLayerId) {
    const matched = flow.layers.find((layer) => layer.id === flow.currentLayerId);
    if (matched) {
      return matched;
    }
  }
  if (flow.currentLayerIndex != null) {
    const matched = flow.layers.find((layer) => layer.index === flow.currentLayerIndex);
    if (matched) {
      return matched;
    }
  }
  return flow.layers.at(-1) ?? null;
}

function currentTeamNodes(flow: TeamFlowState | null, layer: TeamFlowLayer | null) {
  if (!flow) {
    return [];
  }
  if (!layer) {
    return flow.nodes;
  }
  const attached = flow.nodes.filter(
    (node) =>
      node.layerId === layer.id ||
      (node.layerIndex != null && node.layerIndex === layer.index),
  );
  return attached.length > 0 ? attached : layer.nodes;
}

function teamFlowStatusClass(status: string) {
  const normalized = status.trim().toLowerCase();
  if (normalized.includes('done') || normalized.includes('complete')) {
    return 'done';
  }
  if (normalized.includes('run') || normalized.includes('progress')) {
    return 'running';
  }
  if (normalized.includes('block') || normalized.includes('error')) {
    return 'blocked';
  }
  if (normalized.includes('review') || normalized.includes('wait')) {
    return 'review';
  }
  return 'ready';
}

function teamLayerTooltip(layer: TeamFlowLayer, language: AppLanguage) {
  const status = layer.status || (language === 'zh' ? '待确认' : 'Pending');
  return `${layer.title} · ${status}`;
}

function teamFlowLayerCards(flow: TeamFlowState, language: AppLanguage) {
  if (flow.layers.length > 0) {
    return flow.layers.map((layer, index) => ({
      id: layer.id || `layer-${index}`,
      kicker: layer.index != null ? `L${layer.index}` : String(index + 1).padStart(2, '0'),
      title: layer.title || (language === 'zh' ? '未命名层' : 'Untitled layer'),
      summary: layer.goal || layer.summary,
      status: layer.status,
      nodes: currentTeamNodes(flow, layer),
    }));
  }
  return [
    {
      id: flow.flowId || flow.id,
      kicker: 'DAG',
      title: language === 'zh' ? 'Team Flow' : 'Team Flow',
      summary: flow.status,
      status: flow.status,
      nodes: flow.nodes,
    },
  ];
}
