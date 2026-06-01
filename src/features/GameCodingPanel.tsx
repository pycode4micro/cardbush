import {
  Gamepad2,
  LoaderCircle,
  Map as MapIcon,
  Package,
  RefreshCw,
  ScrollText,
  Sparkles,
  Users,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { fetchSubagents, fetchSubagentRuntime } from '../backend/api';
import type {
  AppLanguage,
  SubagentListItem,
  SubagentRuntimeResult,
  SubagentSupervisorSnapshot,
} from '../types';
import {
  animeCharacterPresets,
  animeMapPresets,
  gameCodingAgentKey,
  gameCodingCardProgressForAgent,
  gameCodingCharacterImageForAgent,
  gameCodingLootTemplates,
  characterPresetForAgent,
  GAME_CODING_SETTINGS_EVENT,
  gameCodingDisplayName,
  gameCodingMapImage,
  gameCodingMoodText,
  gameCodingNextXp,
  gameCodingRoleText,
  mapPresetForSettings,
  readGameCodingSettings,
  saveGameCodingSettings,
  type GameCodingCharacterPreset,
  type GameCodingInventoryItem,
  type GameCodingRunLog,
  type GameCodingSettings,
} from './gameCodingPresets';

export function GameCodingPanel({ language }: { language: AppLanguage }) {
  const [agents, setAgents] = useState<SubagentListItem[]>([]);
  const [runtime, setRuntime] = useState<SubagentRuntimeResult | null>(null);
  const [settings, setSettings] = useState<GameCodingSettings>(() =>
    readGameCodingSettings(),
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const sortedAgents = useMemo(
    () => [...agents].sort((left, right) => left.displayName.localeCompare(right.displayName)),
    [agents],
  );
  const selectedMap = mapPresetForSettings(settings, sortedAgents);
  const selectedMapImage = gameCodingMapImage(settings, sortedAgents);
  const runtimeByAgent = useMemo(() => {
    const map = new Map<string, Record<string, unknown>>();
    for (const item of runtime?.items ?? []) {
      map.set(item.name, item.runtime);
      map.set(item.id, item.runtime);
    }
    return map;
  }, [runtime]);
  const supervisor = runtime?.supervisor ?? null;
  const activeTotal = supervisor ? gameCodingSupervisorTotal(supervisor) : 0;
  const enabledTotal = agents.filter((agent) => agent.enabled).length;
  const partyAgents = useMemo(() => {
    const byId = new Map(sortedAgents.flatMap((agent) => [
      [agent.id, agent],
      [agent.name, agent],
    ]));
    const selected = settings.idleCards.partyIds
      .map((id) => byId.get(id))
      .filter((agent): agent is SubagentListItem => agent != null)
      .slice(0, 5);
    return selected.length > 0 ? selected : sortedAgents.slice(0, 5);
  }, [settings.idleCards.partyIds, sortedAgents]);
  const selectedPartyKeys = useMemo(
    () => new Set(partyAgents.map(gameCodingAgentKey)),
    [partyAgents],
  );
  const deckPower = sortedAgents.reduce(
    (total, agent, index) => {
      const progress = gameCodingCardProgressForAgent(settings, agent);
      return total + characterPresetForAgent(agent, index, settings).power + progress.level * 3;
    },
    0,
  );
  const partyPower = partyAgents.reduce((total, agent, index) => {
    const progress = gameCodingCardProgressForAgent(settings, agent);
    return total + characterPresetForAgent(agent, index, settings).power + progress.level * 3;
  }, 0);
  const inventoryTotal = settings.idleCards.inventory.reduce(
    (total, item) => total + item.quantity,
    0,
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [nextAgents, nextRuntime] = await Promise.all([
        fetchSubagents(),
        fetchSubagentRuntime().catch(() => null),
      ]);
      setAgents(nextAgents);
      setRuntime(nextRuntime);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const update = () => setSettings(readGameCodingSettings());
    window.addEventListener(GAME_CODING_SETTINGS_EVENT, update);
    window.addEventListener('storage', update);
    return () => {
      window.removeEventListener(GAME_CODING_SETTINGS_EVENT, update);
      window.removeEventListener('storage', update);
    };
  }, []);

  const updateSettings = useCallback((next: GameCodingSettings) => {
    setSettings(saveGameCodingSettings(next));
  }, []);

  const assignCharacter = useCallback(
    (agent: SubagentListItem, presetId: string) => {
      const key = agent.id || agent.name;
      updateSettings({
        ...settings,
        assignments: {
          ...settings.assignments,
          [key]: presetId,
        },
      });
    },
    [settings, updateSettings],
  );

  const resetCharacter = useCallback(
    (agent: SubagentListItem) => {
      const key = agent.id || agent.name;
      const nextAssignments = { ...settings.assignments };
      delete nextAssignments[key];
      updateSettings({ ...settings, assignments: nextAssignments });
    },
    [settings, updateSettings],
  );

  const chooseCustomMap = useCallback(async () => {
    setError('');
    if (!window.cardbushDesktop?.pickBackgroundImage) {
      setError(language === 'zh' ? '当前环境不支持选择本地图片。' : 'Local image picker is unavailable.');
      return;
    }
    try {
      const pickedPath = await window.cardbushDesktop.pickBackgroundImage();
      if (!pickedPath) {
        return;
      }
      const cachedPath = window.cardbushDesktop.cacheBackgroundImage
        ? await window.cardbushDesktop.cacheBackgroundImage(pickedPath)
        : pickedPath;
      updateSettings({ ...settings, customMapPath: cachedPath });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [language, settings, updateSettings]);

  const chooseCustomCharacter = useCallback(
    async (agent: SubagentListItem) => {
      setError('');
      if (!window.cardbushDesktop?.pickBackgroundImage) {
        setError(language === 'zh' ? '当前环境不支持选择本地图片。' : 'Local image picker is unavailable.');
        return;
      }
      try {
        const pickedPath = await window.cardbushDesktop.pickBackgroundImage();
        if (!pickedPath) {
          return;
        }
        const cachedPath = window.cardbushDesktop.cacheBackgroundImage
          ? await window.cardbushDesktop.cacheBackgroundImage(pickedPath)
          : pickedPath;
        const key = agent.id || agent.name;
        updateSettings({
          ...settings,
          customCharacters: {
            ...settings.customCharacters,
            [key]: cachedPath,
          },
        });
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [language, settings, updateSettings],
  );

  const clearCustomCharacter = useCallback(
    (agent: SubagentListItem) => {
      const key = agent.id || agent.name;
      const nextCustomCharacters = { ...settings.customCharacters };
      delete nextCustomCharacters[key];
      updateSettings({ ...settings, customCharacters: nextCustomCharacters });
    },
    [settings, updateSettings],
  );

  const togglePartyAgent = useCallback(
    (agent: SubagentListItem) => {
      const key = gameCodingAgentKey(agent);
      const current = settings.idleCards.partyIds.filter(Boolean);
      const selected = current.includes(key);
      const partyIds = selected
        ? current.filter((id) => id !== key)
        : [...current, key].slice(0, 5);
      updateSettings({
        ...settings,
        idleCards: {
          ...settings.idleCards,
          partyIds,
        },
      });
    },
    [settings, updateSettings],
  );

  const claimIdleRewards = useCallback(() => {
    const now = new Date();
    const lastClaim = new Date(settings.idleCards.run.lastClaimAt);
    const elapsedMinutes = Number.isFinite(lastClaim.getTime())
      ? Math.max(1, Math.min(360, Math.floor((now.getTime() - lastClaim.getTime()) / 60000)))
      : 1;
    const activeParty = partyAgents.length > 0 ? partyAgents : sortedAgents.slice(0, 5);
    const rewardScale = Math.max(1, Math.round((partyPower || deckPower || 260) / 120));
    const insight = elapsedMinutes * rewardScale;
    const cores = Math.floor(elapsedMinutes / 45) + (activeTotal > 0 ? 1 : 0);
    const cards = { ...settings.idleCards.cards };
    for (const agent of activeParty) {
      const key = gameCodingAgentKey(agent);
      cards[key] = applyCardXp(
        gameCodingCardProgressForAgent(settings, agent),
        Math.max(8, Math.floor(insight / Math.max(1, activeParty.length))),
      );
    }
    const progressGain = Math.max(3, Math.floor(elapsedMinutes / 3) + activeTotal * 4);
    const nextProgress = settings.idleCards.run.progress + progressGain;
    const stageAdvance = Math.floor(nextProgress / 100);
    const lootTemplate = gameCodingLootTemplates[
      (settings.idleCards.run.stage + elapsedMinutes + activeParty.length) % gameCodingLootTemplates.length
    ];
    const lootQuantity = Math.max(1, Math.floor(elapsedMinutes / 80) + (stageAdvance > 0 ? 1 : 0));
    const inventory = mergeInventory(settings.idleCards.inventory, lootTemplate, lootQuantity);
    const log = prependRunLog(settings.idleCards.log, {
      kind: stageAdvance > 0 ? 'stage' : 'reward',
      textZh: `结算 ${elapsedMinutes} 分钟远征，获得 ${insight} 洞察、${cores} 核心、${lootTemplate.nameZh} x${lootQuantity}。`,
      textEn: `Claimed ${elapsedMinutes}m run: +${insight} insight, +${cores} cores, ${lootTemplate.nameEn} x${lootQuantity}.`,
    });
    updateSettings({
      ...settings,
      idleCards: {
        ...settings.idleCards,
        cards,
        inventory,
        log,
        resources: {
          insight: settings.idleCards.resources.insight + insight,
          cores: settings.idleCards.resources.cores + cores,
        },
        run: {
          stage: settings.idleCards.run.stage + stageAdvance,
          progress: nextProgress % 100,
          lastClaimAt: now.toISOString(),
        },
      },
    });
    setError('');
  }, [activeTotal, deckPower, partyAgents, partyPower, settings, sortedAgents, updateSettings]);

  const trainCard = useCallback(
    (agent: SubagentListItem) => {
      if (settings.idleCards.resources.insight < 40) {
        setError(language === 'zh' ? '洞察不足，先结算远征收益。' : 'Not enough insight. Claim run rewards first.');
        return;
      }
      const key = gameCodingAgentKey(agent);
      updateSettings({
        ...settings,
        idleCards: {
          ...settings.idleCards,
          cards: {
            ...settings.idleCards.cards,
            [key]: applyCardXp(gameCodingCardProgressForAgent(settings, agent), 46),
          },
          log: prependRunLog(settings.idleCards.log, {
            kind: 'train',
            textZh: `训练 ${agent.displayName || agent.name}，消耗 40 洞察。`,
            textEn: `Trained ${agent.displayName || agent.name}, spent 40 insight.`,
          }),
          resources: {
            ...settings.idleCards.resources,
            insight: Math.max(0, settings.idleCards.resources.insight - 40),
          },
        },
      });
      setError('');
    },
    [language, settings, updateSettings],
  );

  return (
    <div className="feature-content gamecoding-content">
      <div className="gamecoding-mode-bar">
        <button className="active" type="button">
          <span>{language === 'zh' ? '放置卡牌' : 'Idle Cards'}</span>
          <small>{language === 'zh' ? '当前模式' : 'Active'}</small>
        </button>
        <button type="button" disabled>
          <span>{language === 'zh' ? '战棋远征' : 'Tactics'}</span>
          <small>{language === 'zh' ? '预留' : 'Later'}</small>
        </button>
        <button type="button" disabled>
          <span>{language === 'zh' ? '经营工坊' : 'Workshop'}</span>
          <small>{language === 'zh' ? '预留' : 'Later'}</small>
        </button>
      </div>

      <div className="gamecoding-cardgame-shell">
        <section className="gamecoding-map-card gamecoding-campaign-board">
          <img
            className="gamecoding-map-image"
            src={selectedMapImage}
            alt={gameCodingDisplayName(selectedMap, language)}
          />
          <div className="gamecoding-map-shade" />
          <div className="gamecoding-map-topline">
            <span>
              <MapIcon size={16} />
              {gameCodingDisplayName(selectedMap, language)}
            </span>
            <em>{gameCodingMoodText(selectedMap, language)}</em>
          </div>
          <div className="gamecoding-campaign-route" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
          </div>
          <div className="gamecoding-party-line">
            {partyAgents.length > 0 ? partyAgents.map((agent, index) => {
              const preset = characterPresetForAgent(agent, index, settings);
              const runtimeInfo = runtimeByAgent.get(agent.name) ?? {};
              const runningCount = Number(runtimeInfo.current_running ?? 0);
              return (
                <button
                  className={`gamecoding-party-token ${agent.enabled ? '' : 'disabled'} ${runningCount > 0 ? 'running' : ''}`}
                  key={agent.id || agent.name}
                  type="button"
                  title={`${agent.displayName || agent.name} · ${gameCodingDisplayName(preset, language)}`}
                >
                  <img
                    src={gameCodingCharacterImageForAgent(agent, index, settings)}
                    alt=""
                  />
                  <span>
                    <strong>{agent.displayName || agent.name}</strong>
                    <small>{preset.rarity} · {preset.power}</small>
                  </span>
                </button>
              );
            }) : animeCharacterPresets.slice(0, 5).map((preset) => (
              <span className="gamecoding-party-token preview" key={preset.id}>
                <img src={preset.image} alt="" />
                <span>
                  <strong>{gameCodingDisplayName(preset, language)}</strong>
                  <small>{preset.rarity} · {preset.power}</small>
                </span>
              </span>
            ))}
          </div>
        </section>

        <aside className="gamecoding-director-card gamecoding-run-panel">
          <header>
            <span className="gamecoding-card-kicker">
              <Gamepad2 size={17} />
              {language === 'zh' ? '卡牌远征' : 'Card Run'}
            </span>
            <button
              className="secondary-button compact"
              type="button"
              disabled={loading}
              onClick={() => void load()}
            >
              {loading ? <LoaderCircle size={14} /> : <RefreshCw size={14} />}
              {language === 'zh' ? '刷新' : 'Refresh'}
            </button>
          </header>
          <h2>{language === 'zh' ? '边 coding 边养一副卡组' : 'Build a deck while coding'}</h2>
          <p>
            {language === 'zh'
              ? '每个子 Agent 是一张伙伴卡，运行状态会进入放置远征面板。'
              : 'Each subagent becomes a companion card, with runtime state feeding the idle run.'}
          </p>
          <div className="gamecoding-stat-grid">
            <InfoPill label={language === 'zh' ? '卡牌' : 'Cards'} value={`${enabledTotal}/${agents.length || animeCharacterPresets.length}`} />
            <InfoPill label={language === 'zh' ? '队伍战力' : 'Party power'} value={String(partyPower || animeCharacterPresets.slice(0, 5).reduce((sum, item) => sum + item.power, 0))} />
            <InfoPill label={language === 'zh' ? '洞察' : 'Insight'} value={String(settings.idleCards.resources.insight)} />
            <InfoPill label={language === 'zh' ? '核心' : 'Cores'} value={String(settings.idleCards.resources.cores)} />
            <InfoPill label={language === 'zh' ? '战利品' : 'Loot'} value={String(inventoryTotal)} />
          </div>
          <div className="gamecoding-idle-lanes">
            <span>
              <strong>{language === 'zh' ? '探索' : 'Explore'}</strong>
              <em>{Math.max(1, partyAgents.length)} / 5</em>
            </span>
            <span>
              <strong>{language === 'zh' ? '关卡' : 'Stage'}</strong>
              <em>{settings.idleCards.run.stage}</em>
            </span>
            <span>
              <strong>{language === 'zh' ? '进度' : 'Progress'}</strong>
              <em>{settings.idleCards.run.progress}%</em>
            </span>
          </div>
          <button className="primary-button gamecoding-claim-button" type="button" onClick={claimIdleRewards}>
            <Sparkles size={15} />
            {language === 'zh' ? '结算远征' : 'Claim run'}
          </button>
          <div className="gamecoding-run-meta">
            <section>
              <header>
                <span>
                  <Package size={15} />
                  {language === 'zh' ? '战利品背包' : 'Loot bag'}
                </span>
              </header>
              <div className="gamecoding-loot-list">
                {settings.idleCards.inventory.length > 0 ? settings.idleCards.inventory.slice(0, 5).map((item) => (
                  <span className={`rarity-${item.rarity}`} key={item.id}>
                    <strong>{gameCodingInventoryName(item, language)}</strong>
                    <em>x{item.quantity}</em>
                    <small>{gameCodingInventoryEffect(item, language)}</small>
                  </span>
                )) : (
                  <small className="gamecoding-empty-line">
                    {language === 'zh' ? '结算远征后会掉落素材。' : 'Claim a run to collect materials.'}
                  </small>
                )}
              </div>
            </section>
            <section>
              <header>
                <span>
                  <ScrollText size={15} />
                  {language === 'zh' ? '远征日志' : 'Run log'}
                </span>
              </header>
              <div className="gamecoding-run-log">
                {settings.idleCards.log.length > 0 ? settings.idleCards.log.slice(0, 4).map((item) => (
                  <span className={item.kind} key={item.id}>
                    <small>{formatRunLogTime(item.at)}</small>
                    <strong>{gameCodingRunLogText(item, language)}</strong>
                  </span>
                )) : (
                  <small className="gamecoding-empty-line">
                    {language === 'zh' ? '训练和结算会记录在这里。' : 'Training and claims will appear here.'}
                  </small>
                )}
              </div>
            </section>
          </div>
          <label className="gamecoding-field">
            <span>{language === 'zh' ? '当前地图' : 'Current map'}</span>
            <select
              value={settings.mapId}
              onChange={(event) =>
                updateSettings({ ...settings, mapId: event.currentTarget.value })
              }
            >
              <option value="auto">
                {language === 'zh' ? '自动选择地图' : 'Auto select map'}
              </option>
              {animeMapPresets.map((map) => (
                <option value={map.id} key={map.id}>
                  {gameCodingDisplayName(map, language)}
                </option>
              ))}
            </select>
          </label>
          <div className="gamecoding-map-actions">
            <button className="secondary-button compact" type="button" onClick={() => void chooseCustomMap()}>
              {language === 'zh' ? '选择自定义地图' : 'Custom map'}
            </button>
            {settings.customMapPath && (
              <button
                className="ghost-button"
                type="button"
                onClick={() => updateSettings({ ...settings, customMapPath: '' })}
              >
                {language === 'zh' ? '清除地图' : 'Clear map'}
              </button>
            )}
          </div>
          {error && <p className="feature-error">{error}</p>}
        </aside>
      </div>

      <section className="gamecoding-deck-section">
        <header>
          <span>
            <Users size={17} />
            {language === 'zh' ? '当前卡组' : 'Current deck'}
          </span>
          <em>
            {language === 'zh'
              ? '子 Agent 会自动匹配卡牌职业'
              : 'Subagents auto-match card classes'}
          </em>
        </header>
        <div className="gamecoding-card-grid">
          {sortedAgents.length > 0 ? sortedAgents.map((agent, index) => {
            const preset = characterPresetForAgent(agent, index, settings);
            const runtimeInfo = runtimeByAgent.get(agent.name) ?? {};
            const runningCount = Number(runtimeInfo.current_running ?? 0);
            return (
              <AgentBattleCard
                key={agent.id || agent.name}
                agent={agent}
                index={index}
                preset={preset}
                image={gameCodingCharacterImageForAgent(agent, index, settings)}
                runningCount={runningCount}
                progress={gameCodingCardProgressForAgent(settings, agent)}
                selected={selectedPartyKeys.has(gameCodingAgentKey(agent))}
                onToggleParty={() => togglePartyAgent(agent)}
                onTrain={() => trainCard(agent)}
                language={language}
              />
            );
          }) : animeCharacterPresets.slice(0, 8).map((preset, index) => (
            <PresetBattleCard
              key={preset.id}
              preset={preset}
              index={index}
              language={language}
            />
          ))}
        </div>
      </section>

      <section className="gamecoding-roster-card">
        <header>
          <span>
            <Users size={17} />
            {language === 'zh' ? '卡牌编成' : 'Deck assignment'}
          </span>
          <em>
            {language === 'zh'
              ? '角色和立绘会保存到本地配置'
              : 'Roles and artwork are stored locally'}
          </em>
        </header>
        <div className="gamecoding-roster-grid">
          {sortedAgents.map((agent, index) => {
            const preset = characterPresetForAgent(agent, index, settings);
            const autoPreset = !settings.assignments[agent.id || agent.name];
            const hasCustomImage = Boolean(
              settings.customCharacters[agent.id] ?? settings.customCharacters[agent.name],
            );
            return (
              <article className="gamecoding-roster-item" key={agent.id || agent.name}>
                <img
                  src={gameCodingCharacterImageForAgent(agent, index, settings)}
                  alt=""
                />
                <div>
                  <strong>{agent.displayName || agent.name}</strong>
                  <span>{gameCodingRoleText(preset, language)}</span>
                  <small>
                    {hasCustomImage
                      ? language === 'zh'
                        ? '自定义形象'
                        : 'Custom image'
                      : autoPreset
                      ? language === 'zh'
                        ? '自动匹配'
                        : 'Auto matched'
                      : language === 'zh'
                        ? '手动指定'
                        : 'Manual'}
                  </small>
                </div>
                <select
                  value={preset.id}
                  onChange={(event) => assignCharacter(agent, event.currentTarget.value)}
                  aria-label={language === 'zh' ? '选择角色' : 'Select character'}
                >
                  {animeCharacterPresets.map((item) => (
                    <option value={item.id} key={item.id}>
                      {gameCodingDisplayName(item, language)}
                    </option>
                  ))}
                </select>
                <div className="gamecoding-roster-actions">
                  {!autoPreset && (
                    <button
                      className="ghost-button"
                      type="button"
                      onClick={() => resetCharacter(agent)}
                    >
                      {language === 'zh' ? '自动' : 'Auto'}
                    </button>
                  )}
                  <button
                    className="ghost-button"
                    type="button"
                    onClick={() => void chooseCustomCharacter(agent)}
                  >
                    {language === 'zh' ? '换图' : 'Image'}
                  </button>
                  {hasCustomImage && (
                    <button
                      className="ghost-button"
                      type="button"
                      onClick={() => clearCustomCharacter(agent)}
                    >
                      {language === 'zh' ? '清图' : 'Clear'}
                    </button>
                  )}
                </div>
              </article>
            );
          })}
          {!loading && sortedAgents.length === 0 && (
            <div className="subagent-empty-detail compact">
              <Sparkles size={22} />
              <strong>{language === 'zh' ? '还没有子 Agent' : 'No subagents yet'}</strong>
              <p>
                {language === 'zh'
                  ? '注册子 Agent 后，这里会自动生成 NPC 队伍。'
                  : 'Register subagents and they will become an NPC crew here.'}
              </p>
            </div>
          )}
        </div>
      </section>

      <section className="gamecoding-library">
        <header>
          <span>
            <Sparkles size={17} />
            {language === 'zh' ? '本地预设库' : 'Local preset library'}
          </span>
          <em>{language === 'zh' ? '角色和地图都可继续扩展' : 'Characters and maps are extendable'}</em>
        </header>
        <div className="gamecoding-character-strip">
          {animeCharacterPresets.map((preset) => (
            <PresetCharacterCard
              key={preset.id}
              preset={preset}
              language={language}
            />
          ))}
        </div>
        <div className="gamecoding-map-strip">
          {animeMapPresets.map((map) => (
            <button
              className={`gamecoding-map-tile ${map.id === selectedMap.id ? 'active' : ''}`}
              key={map.id}
              type="button"
              onClick={() => updateSettings({ ...settings, mapId: map.id })}
            >
              <img src={map.image} alt="" />
              <span>{gameCodingDisplayName(map, language)}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function AgentBattleCard({
  agent,
  preset,
  image,
  runningCount,
  progress,
  selected,
  onToggleParty,
  onTrain,
  language,
}: {
  agent: SubagentListItem;
  index: number;
  preset: GameCodingCharacterPreset;
  image: string;
  runningCount: number;
  progress: { level: number; xp: number };
  selected: boolean;
  onToggleParty: () => void;
  onTrain: () => void;
  language: AppLanguage;
}) {
  const nextXp = gameCodingNextXp(progress.level);
  return (
    <article
      className={`gamecoding-battle-card rarity-${preset.rarity.toLowerCase()} element-${preset.element} ${agent.enabled ? '' : 'disabled'} ${runningCount > 0 ? 'running' : ''} ${selected ? 'selected' : ''}`}
    >
      <header>
        <span>{preset.rarity}</span>
        <em>Lv.{progress.level}</em>
      </header>
      <div className="gamecoding-card-portrait">
        <img src={image} alt="" />
      </div>
      <div className="gamecoding-card-copy">
        <strong>{agent.displayName || agent.name}</strong>
        <small>{gameCodingDisplayName(preset, language)} · {gameCodingRoleText(preset, language)}</small>
        <p>{language === 'zh' ? preset.skillZh : preset.skillEn}</p>
      </div>
      <span className="gamecoding-card-xp">
        <i>
          <b style={{ width: `${Math.max(4, Math.min(100, (progress.xp / nextXp) * 100))}%` }} />
        </i>
        <small>{progress.xp} / {nextXp}</small>
      </span>
      <div className="gamecoding-card-stats">
        <StatBar label={language === 'zh' ? '专注' : 'Focus'} value={preset.stats.focus} />
        <StatBar label={language === 'zh' ? '逻辑' : 'Logic'} value={preset.stats.logic} />
        <StatBar label={language === 'zh' ? '节奏' : 'Tempo'} value={preset.stats.tempo} />
        <StatBar label={language === 'zh' ? '守备' : 'Guard'} value={preset.stats.guard} />
      </div>
      <footer>
        <span>{preset.power + progress.level * 3}</span>
        <em>{runningCount > 0 ? (language === 'zh' ? `行动 ${runningCount}` : `Active ${runningCount}`) : agent.enabled ? (language === 'zh' ? '待命' : 'Ready') : (language === 'zh' ? '休眠' : 'Sleeping')}</em>
      </footer>
      <div className="gamecoding-card-actions">
        <button type="button" onClick={onToggleParty}>
          {selected
            ? language === 'zh'
              ? '下阵'
              : 'Bench'
            : language === 'zh'
              ? '上阵'
              : 'Party'}
        </button>
        <button type="button" onClick={onTrain}>
          {language === 'zh' ? '训练' : 'Train'}
        </button>
      </div>
    </article>
  );
}

function PresetBattleCard({
  preset,
  language,
}: {
  preset: GameCodingCharacterPreset;
  index: number;
  language: AppLanguage;
}) {
  return (
    <article className={`gamecoding-battle-card preview rarity-${preset.rarity.toLowerCase()} element-${preset.element}`}>
      <header>
        <span>{preset.rarity}</span>
        <em>{preset.power}</em>
      </header>
      <div className="gamecoding-card-portrait">
        <img src={preset.image} alt="" />
      </div>
      <div className="gamecoding-card-copy">
        <strong>{gameCodingDisplayName(preset, language)}</strong>
        <small>{gameCodingRoleText(preset, language)}</small>
        <p>{language === 'zh' ? preset.skillZh : preset.skillEn}</p>
      </div>
      <div className="gamecoding-card-stats">
        <StatBar label={language === 'zh' ? '专注' : 'Focus'} value={preset.stats.focus} />
        <StatBar label={language === 'zh' ? '逻辑' : 'Logic'} value={preset.stats.logic} />
      </div>
      <footer>
        <span>{elementLabel(preset.element, language)}</span>
        <em>{language === 'zh' ? '预览' : 'Preview'}</em>
      </footer>
    </article>
  );
}

function StatBar({ label, value }: { label: string; value: number }) {
  return (
    <span className="gamecoding-stat-bar">
      <small>{label}</small>
      <i>
        <b style={{ width: `${Math.max(6, Math.min(100, value))}%` }} />
      </i>
    </span>
  );
}

function elementLabel(element: GameCodingCharacterPreset['element'], language: AppLanguage) {
  const labels: Record<GameCodingCharacterPreset['element'], { zh: string; en: string }> = {
    logic: { zh: '逻辑', en: 'Logic' },
    patch: { zh: '修复', en: 'Patch' },
    debug: { zh: '调试', en: 'Debug' },
    test: { zh: '测试', en: 'Test' },
    flow: { zh: '流程', en: 'Flow' },
    guard: { zh: '守备', en: 'Guard' },
  };
  return labels[element][language];
}

function PresetCharacterCard({
  preset,
  language,
}: {
  preset: GameCodingCharacterPreset;
  language: AppLanguage;
}) {
  return (
    <article className="gamecoding-character-card">
      <div>
        <img src={preset.image} alt="" />
        <em>{preset.rarity}</em>
      </div>
      <strong>{gameCodingDisplayName(preset, language)}</strong>
      <span>{gameCodingRoleText(preset, language)}</span>
      <small>{elementLabel(preset.element, language)} · {preset.power}</small>
    </article>
  );
}

function InfoPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="gamecoding-info-pill">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function gameCodingInventoryName(item: GameCodingInventoryItem, language: AppLanguage) {
  return language === 'zh' ? item.nameZh : item.nameEn;
}

function gameCodingInventoryEffect(item: GameCodingInventoryItem, language: AppLanguage) {
  return language === 'zh' ? item.effectZh : item.effectEn;
}

function gameCodingRunLogText(item: GameCodingRunLog, language: AppLanguage) {
  return language === 'zh' ? item.textZh : item.textEn;
}

function formatRunLogTime(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return '--:--';
  }
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function mergeInventory(
  inventory: GameCodingInventoryItem[],
  item: Omit<GameCodingInventoryItem, 'quantity'>,
  quantity: number,
) {
  const amount = Math.max(1, Math.floor(quantity));
  const merged = new Map(inventory.map((entry) => [entry.id, { ...entry }]));
  const previous = merged.get(item.id);
  merged.set(item.id, {
    ...item,
    quantity: (previous?.quantity ?? 0) + amount,
  });
  return Array.from(merged.values()).slice(0, 24);
}

function prependRunLog(
  log: GameCodingRunLog[],
  entry: Omit<GameCodingRunLog, 'id' | 'at'>,
) {
  return [
    {
      ...entry,
      id: `${entry.kind}-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      at: new Date().toISOString(),
    },
    ...log,
  ].slice(0, 24);
}

function applyCardXp(progress: { level: number; xp: number }, addedXp: number) {
  let level = Math.max(1, Math.floor(progress.level));
  let xp = Math.max(0, Math.floor(progress.xp + addedXp));
  while (level < 99 && xp >= gameCodingNextXp(level)) {
    xp -= gameCodingNextXp(level);
    level += 1;
  }
  return { level, xp };
}

function gameCodingSupervisorTotal(supervisor: SubagentSupervisorSnapshot) {
  if (Number.isFinite(supervisor.counts.totalActive)) {
    return supervisor.counts.totalActive ?? 0;
  }
  return Object.values(supervisor.counts.agentActive).reduce(
    (sum, value) => sum + value,
    0,
  );
}
