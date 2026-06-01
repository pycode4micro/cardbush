import {
  ArrowRight,
  FolderOpen,
  LoaderCircle,
  Music2,
  Pause,
  Play,
  Plus,
  Search,
  Settings,
  Trash2,
  X,
} from 'lucide-react';
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type { AppLanguage } from '../types';

const LOCAL_MUSIC_LIBRARY_STORAGE_KEY = 'cardbush_local_music_library';
const LOCAL_MUSIC_PLAYLISTS_STORAGE_KEY = 'cardbush_local_music_playlists';
const LOCAL_MUSIC_LIBRARY_LIST_ID = 'library';

type LocalMusicTrack = {
  id: string;
  path: string;
  name: string;
  classification?: LocalMusicClassification;
};

type LocalMusicClassification = {
  source: 'manual' | 'ai';
  tags: string[];
  mood?: string;
  genre?: string;
  energy?: number;
  updatedAt: string;
};

type LocalMusicPlaylist = {
  id: string;
  name: string;
  trackIds: string[];
  kind: 'manual' | 'smart';
  description?: string;
  rules?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export function LocalMusicPanel({
  language,
  onClose,
}: {
  language: AppLanguage;
  onClose: () => void;
}) {
  const [tracks, setTracks] = useState<LocalMusicTrack[]>(loadLocalMusicLibrary);
  const [playlists, setPlaylists] = useState<LocalMusicPlaylist[]>(
    loadLocalMusicPlaylists,
  );
  const [activeListId, setActiveListId] = useState(LOCAL_MUSIC_LIBRARY_LIST_ID);
  const [playlistDraft, setPlaylistDraft] = useState('');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [currentTrackId, setCurrentTrackId] = useState('');
  const [playing, setPlaying] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [status, setStatus] = useState(
    language === 'zh'
      ? '选择本地音乐后即可播放。'
      : 'Choose local music to start playback.',
  );
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const currentTrack = tracks.find((track) => track.id === currentTrackId) ?? null;
  const activePlaylist =
    playlists.find((playlist) => playlist.id === activeListId) ?? null;
  const currentTracks = useMemo(() => {
    if (!activePlaylist) {
      return tracks;
    }
    const allowed = new Set(activePlaylist.trackIds);
    return tracks.filter((track) => allowed.has(track.id));
  }, [activePlaylist, tracks]);
  const visibleTracks = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) {
      return currentTracks;
    }
    return currentTracks.filter((track) =>
      `${track.name}\n${track.path}`.toLowerCase().includes(term),
    );
  }, [currentTracks, query]);
  const statusTone = playing ? 'connected' : busy ? 'busy' : tracks.length > 0 ? 'ready' : 'setup';

  useEffect(() => {
    window.localStorage.setItem(LOCAL_MUSIC_LIBRARY_STORAGE_KEY, JSON.stringify(tracks));
  }, [tracks]);

  useEffect(() => {
    window.localStorage.setItem(
      LOCAL_MUSIC_PLAYLISTS_STORAGE_KEY,
      JSON.stringify(playlists),
    );
  }, [playlists]);

  const addMusicPaths = useCallback((paths: string[], targetListId = activeListId) => {
    const nextTracks = paths
      .map(localMusicTrackFromPath)
      .filter((track): track is LocalMusicTrack => track != null);
    if (nextTracks.length === 0) {
      setStatus(language === 'zh' ? '没有找到可播放的音频文件。' : 'No playable audio files found.');
      return;
    }
    setTracks((previous) => {
      const seen = new Set(previous.map((track) => normalizedPathKey(track.path)));
      const merged = [...previous];
      for (const track of nextTracks) {
        const key = normalizedPathKey(track.path);
        if (!seen.has(key)) {
          seen.add(key);
          merged.push(track);
        }
      }
      return merged.sort((left, right) => left.name.localeCompare(right.name));
    });
    if (targetListId !== LOCAL_MUSIC_LIBRARY_LIST_ID) {
      const ids = nextTracks.map((track) => track.id);
      setPlaylists((previous) =>
        previous.map((playlist) =>
          playlist.id === targetListId
            ? {
                ...playlist,
                trackIds: mergeTrackIds(playlist.trackIds, ids),
                updatedAt: new Date().toISOString(),
              }
            : playlist,
        ),
      );
    }
    setStatus(
      language === 'zh'
        ? activePlaylist && targetListId === activePlaylist.id
          ? `已加入 ${nextTracks.length} 首到「${activePlaylist.name}」。`
          : `已加入 ${nextTracks.length} 首本地歌曲。`
        : activePlaylist && targetListId === activePlaylist.id
          ? `Added ${nextTracks.length} tracks to "${activePlaylist.name}".`
          : `Added ${nextTracks.length} local tracks.`,
    );
  }, [activeListId, activePlaylist, language]);

  const pickMusicFiles = useCallback(async () => {
    if (!window.cardbushDesktop?.pickMusicFiles) {
      setStatus(language === 'zh' ? '当前环境不支持选择本地音乐。' : 'Local music picker is unavailable.');
      return;
    }
    const paths = await window.cardbushDesktop.pickMusicFiles();
    addMusicPaths(paths, activeListId);
  }, [activeListId, addMusicPaths, language]);

  const pickMusicFolder = useCallback(async () => {
    if (!window.cardbushDesktop?.pickMusicDirectory || !window.cardbushDesktop?.scanMusicDirectory) {
      setStatus(language === 'zh' ? '当前环境不支持扫描音乐文件夹。' : 'Music folder scan is unavailable.');
      return;
    }
    const folderPath = await window.cardbushDesktop.pickMusicDirectory();
    if (!folderPath) {
      return;
    }
    setBusy(true);
    setStatus(language === 'zh' ? '正在扫描本地音乐...' : 'Scanning local music...');
    try {
      const paths = await window.cardbushDesktop.scanMusicDirectory(folderPath);
      addMusicPaths(paths, activeListId);
    } catch (caught) {
      setStatus(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }, [activeListId, addMusicPaths, language]);

  const playTrack = useCallback((track: LocalMusicTrack) => {
    setCurrentTrackId(track.id);
    setPlaying(true);
    setStatus(
      language === 'zh'
        ? `正在播放：${track.name}`
        : `Playing: ${track.name}`,
    );
  }, [language]);

  const playNextTrack = useCallback(() => {
    const pool = visibleTracks.length > 0 ? visibleTracks : currentTracks.length > 0 ? currentTracks : tracks;
    if (pool.length === 0) {
      return;
    }
    const currentIndex = pool.findIndex((track) => track.id === currentTrackId);
    const next = pool[(currentIndex + 1 + pool.length) % pool.length];
    playTrack(next);
  }, [currentTrackId, currentTracks, playTrack, tracks, visibleTracks]);

  const togglePlayback = useCallback(() => {
    if (!currentTrack) {
      const firstTrack = visibleTracks[0] ?? currentTracks[0] ?? tracks[0];
      if (firstTrack) {
        playTrack(firstTrack);
      }
      return;
    }
    setPlaying((value) => !value);
    setStatus(
      playing
        ? language === 'zh'
          ? '已暂停。'
          : 'Paused.'
        : language === 'zh'
          ? `正在播放：${currentTrack.name}`
          : `Playing: ${currentTrack.name}`,
    );
  }, [currentTrack, currentTracks, language, playTrack, playing, tracks, visibleTracks]);

  const removeTrack = useCallback((trackId: string) => {
    if (activePlaylist) {
      setPlaylists((previous) =>
        previous.map((playlist) =>
          playlist.id === activePlaylist.id
            ? {
                ...playlist,
                trackIds: playlist.trackIds.filter((id) => id !== trackId),
                updatedAt: new Date().toISOString(),
              }
            : playlist,
        ),
      );
      if (trackId === currentTrackId) {
        audioRef.current?.pause();
        setCurrentTrackId('');
        setPlaying(false);
      }
      setStatus(
        language === 'zh'
          ? `已从「${activePlaylist.name}」移除。`
          : `Removed from "${activePlaylist.name}".`,
      );
      return;
    }
    setTracks((previous) => previous.filter((track) => track.id !== trackId));
    setPlaylists((previous) =>
      previous.map((playlist) => ({
        ...playlist,
        trackIds: playlist.trackIds.filter((id) => id !== trackId),
        updatedAt: new Date().toISOString(),
      })),
    );
    if (trackId === currentTrackId) {
      audioRef.current?.pause();
      setCurrentTrackId('');
      setPlaying(false);
    }
  }, [activePlaylist, currentTrackId, language]);

  const clearActiveList = useCallback(() => {
    audioRef.current?.pause();
    if (activePlaylist) {
      setPlaylists((previous) =>
        previous.map((playlist) =>
          playlist.id === activePlaylist.id
            ? { ...playlist, trackIds: [], updatedAt: new Date().toISOString() }
            : playlist,
        ),
      );
      setCurrentTrackId('');
      setPlaying(false);
      setStatus(
        language === 'zh'
          ? `已清空「${activePlaylist.name}」。`
          : `Cleared "${activePlaylist.name}".`,
      );
      return;
    }
    setTracks([]);
    setPlaylists((previous) =>
      previous.map((playlist) => ({
        ...playlist,
        trackIds: [],
        updatedAt: new Date().toISOString(),
      })),
    );
    setCurrentTrackId('');
    setPlaying(false);
    setStatus(language === 'zh' ? '已清空本地音乐库。' : 'Local music library cleared.');
  }, [activePlaylist, language]);

  const createPlaylist = useCallback((event: FormEvent) => {
    event.preventDefault();
    const name = playlistDraft.trim();
    if (!name) {
      setStatus(language === 'zh' ? '先给列表起个名字。' : 'Name the playlist first.');
      return;
    }
    const now = new Date().toISOString();
    const playlist: LocalMusicPlaylist = {
      id: `playlist-${crypto.randomUUID()}`,
      name,
      trackIds: [],
      kind: 'manual',
      createdAt: now,
      updatedAt: now,
    };
    setPlaylists((previous) => [...previous, playlist]);
    setActiveListId(playlist.id);
    setPlaylistDraft('');
    setStatus(
      language === 'zh'
        ? `已创建列表「${name}」。`
        : `Created playlist "${name}".`,
    );
  }, [language, playlistDraft]);

  const deleteActivePlaylist = useCallback(() => {
    if (!activePlaylist) {
      return;
    }
    setPlaylists((previous) =>
      previous.filter((playlist) => playlist.id !== activePlaylist.id),
    );
    setActiveListId(LOCAL_MUSIC_LIBRARY_LIST_ID);
    if (activePlaylist.trackIds.includes(currentTrackId)) {
      audioRef.current?.pause();
      setCurrentTrackId('');
      setPlaying(false);
    }
    setStatus(
      language === 'zh'
        ? `已删除列表「${activePlaylist.name}」。`
        : `Deleted playlist "${activePlaylist.name}".`,
    );
  }, [activePlaylist, currentTrackId, language]);

  const submitSearch = useCallback((event: FormEvent) => {
    event.preventDefault();
    const firstTrack = visibleTracks[0];
    if (firstTrack) {
      playTrack(firstTrack);
    }
  }, [playTrack, visibleTracks]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !currentTrack) {
      return;
    }
    if (!playing) {
      audio.pause();
      return;
    }
    const nextSrc = localFileUrl(currentTrack.path);
    if (audio.src !== nextSrc) {
      audio.src = nextSrc;
    }
    void audio.play().catch((caught) => {
      setPlaying(false);
      setStatus(errorMessage(caught));
    });
  }, [currentTrack, playing]);

  return (
    <section className="apple-music-panel local-music-panel no-drag" aria-label="Local music">
      <audio ref={audioRef} onEnded={playNextTrack} preload="metadata" />
      <header className="apple-music-header">
        <span className="apple-music-title">
          <span className="apple-music-mark">
            <Music2 size={16} />
          </span>
          <span className="apple-music-heading">
            <strong>{language === 'zh' ? '本地音乐' : 'Local Music'}</strong>
            <small>
              {tracks.length > 0
                ? language === 'zh'
                  ? `${tracks.length} 首 · ${playlists.length} 个列表`
                  : `${tracks.length} tracks · ${playlists.length} lists`
                : language === 'zh'
                  ? '未添加'
                  : 'Empty'}
            </small>
          </span>
        </span>
        <span className="apple-music-actions">
          {currentTrack && (
            <button type="button" onClick={togglePlayback} aria-label="toggle music">
              {playing ? <Pause size={14} /> : <Play size={14} />}
            </button>
          )}
          {currentTrack && (
            <button type="button" onClick={playNextTrack} aria-label="next music">
              <ArrowRight size={14} />
            </button>
          )}
          <button
            className={configOpen ? 'active' : ''}
            type="button"
            onClick={() => setConfigOpen((open) => !open)}
            aria-label="music library"
          >
            <Settings size={14} />
          </button>
          <button type="button" onClick={onClose} aria-label="close music">
            <X size={15} />
          </button>
        </span>
      </header>
      {currentTrack ? (
        <div className="apple-music-login-card connected local-music-now">
          <span>
            <Music2 size={17} />
            <span>
              <strong>{currentTrack.name}</strong>
              <small>{currentTrack.path}</small>
            </span>
          </span>
          <span className="local-music-control-row">
            <button type="button" onClick={togglePlayback}>
              {playing ? <Pause size={14} /> : <Play size={14} />}
            </button>
            <button type="button" onClick={playNextTrack}>
              <ArrowRight size={14} />
            </button>
          </span>
        </div>
      ) : (
        <button
          className="apple-music-login-card"
          type="button"
          disabled={busy}
          onClick={() => void pickMusicFiles()}
        >
          <span>
            <Music2 size={17} />
            <span>
              <strong>{language === 'zh' ? '添加本地音乐' : 'Add local music'}</strong>
              <small>
                {language === 'zh'
                  ? '支持本机 mp3、m4a、wav、flac 等音频'
                  : 'Play local mp3, m4a, wav, flac and more'}
              </small>
            </span>
          </span>
          {busy ? <LoaderCircle size={16} /> : <Plus size={16} />}
        </button>
      )}
      <div className="local-music-playlists" role="tablist" aria-label="music playlists">
        <button
          className={activeListId === LOCAL_MUSIC_LIBRARY_LIST_ID ? 'active' : ''}
          type="button"
          onClick={() => setActiveListId(LOCAL_MUSIC_LIBRARY_LIST_ID)}
        >
          <span>{language === 'zh' ? '全部歌曲' : 'Library'}</span>
          <small>{tracks.length}</small>
        </button>
        {playlists.map((playlist) => (
          <button
            className={activeListId === playlist.id ? 'active' : ''}
            type="button"
            key={playlist.id}
            onClick={() => setActiveListId(playlist.id)}
          >
            <span>{playlist.name}</span>
            <small>{trackCountForPlaylist(playlist, tracks)}</small>
          </button>
        ))}
      </div>
      {configOpen && (
        <div className="apple-music-config local-music-config">
          <div className="apple-music-help">
            <span>
              {language === 'zh'
                ? '播放列表只保存本地 trackId，后面可以让 AI 给歌曲打标签、生成智能列表或按场景分类。'
                : 'Playlists store local track IDs, leaving room for AI tags, smart lists, and scene-based classification.'}
            </span>
          </div>
          <form className="local-music-playlist-form" onSubmit={createPlaylist}>
            <input
              value={playlistDraft}
              placeholder={language === 'zh' ? '新列表名称' : 'New playlist name'}
              onChange={(event) => setPlaylistDraft(event.currentTarget.value)}
            />
            <button type="submit">
              <Plus size={14} />
              {language === 'zh' ? '新建列表' : 'Create'}
            </button>
          </form>
          <div className="local-music-actions-row">
            <button type="button" disabled={busy} onClick={() => void pickMusicFiles()}>
              <Plus size={14} />
              {activePlaylist
                ? language === 'zh'
                  ? '添加到列表'
                  : 'Add to list'
                : language === 'zh'
                  ? '添加歌曲'
                  : 'Add files'}
            </button>
            <button type="button" disabled={busy} onClick={() => void pickMusicFolder()}>
              <FolderOpen size={14} />
              {activePlaylist
                ? language === 'zh'
                  ? '文件夹入列'
                  : 'Folder to list'
                : language === 'zh'
                  ? '添加文件夹'
                  : 'Add folder'}
            </button>
            <button
              type="button"
              disabled={activePlaylist ? activePlaylist.trackIds.length === 0 : tracks.length === 0}
              onClick={clearActiveList}
            >
              <Trash2 size={14} />
              {activePlaylist
                ? language === 'zh'
                  ? '清空列表'
                  : 'Clear list'
                : language === 'zh'
                  ? '清空曲库'
                  : 'Clear library'}
            </button>
            {activePlaylist && (
              <button type="button" onClick={deleteActivePlaylist}>
                <Trash2 size={14} />
                {language === 'zh' ? '删除列表' : 'Delete list'}
              </button>
            )}
          </div>
        </div>
      )}
      <form className="apple-music-search" onSubmit={submitSearch}>
        <Search size={15} />
        <input
          value={query}
          placeholder={language === 'zh' ? '搜索本地歌曲或路径' : 'Search local songs or paths'}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
        <button type="submit" disabled={visibleTracks.length === 0}>
          {busy ? <LoaderCircle size={15} /> : <ArrowRight size={15} />}
        </button>
      </form>
      <div className={`apple-music-status ${statusTone}`}>
        <span />
        {status}
      </div>
      <div className="apple-music-results">
        {visibleTracks.length === 0 && (
          <div className="apple-music-empty">
            <Music2 size={18} />
            <span>
              {tracks.length === 0
                ? language === 'zh'
                  ? '添加本地歌曲后会在这里显示'
                  : 'Add local songs to show them here'
                : activePlaylist && currentTracks.length === 0
                  ? language === 'zh'
                    ? '这个列表还是空的'
                    : 'This playlist is empty'
                : language === 'zh'
                  ? '没有匹配的本地歌曲'
                  : 'No matching local songs'}
            </span>
          </div>
        )}
        {visibleTracks.map((track) => (
          <div
            key={track.id}
            className={`apple-music-song ${currentTrackId === track.id ? 'playing' : ''}`}
            role="button"
            tabIndex={0}
            onClick={() => playTrack(track)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                playTrack(track);
              }
            }}
          >
            <span className="apple-music-artwork">
              <Music2 size={17} />
            </span>
            <span className="apple-music-song-meta">
              <strong>{track.name}</strong>
              <small>{track.path}</small>
            </span>
            <span className="apple-music-play-indicator">
              {currentTrackId === track.id && playing ? <Pause size={14} /> : <Play size={14} />}
            </span>
            <button
              className="local-music-remove"
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                removeTrack(track.id);
              }}
              aria-label={activePlaylist ? 'remove from playlist' : 'remove track'}
            >
              <X size={13} />
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

function loadLocalMusicLibrary(): LocalMusicTrack[] {
  try {
    const raw = JSON.parse(window.localStorage.getItem(LOCAL_MUSIC_LIBRARY_STORAGE_KEY) ?? '[]') as unknown;
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw
      .map(normalizeLocalMusicTrack)
      .filter((track): track is LocalMusicTrack => track != null);
  } catch {
    return [];
  }
}

function loadLocalMusicPlaylists(): LocalMusicPlaylist[] {
  try {
    const raw = JSON.parse(window.localStorage.getItem(LOCAL_MUSIC_PLAYLISTS_STORAGE_KEY) ?? '[]') as unknown;
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw
      .map(normalizeLocalMusicPlaylist)
      .filter((playlist): playlist is LocalMusicPlaylist => playlist != null);
  } catch {
    return [];
  }
}

function normalizeLocalMusicTrack(value: unknown): LocalMusicTrack | null {
  if (!isRecord(value)) {
    return null;
  }
  const pathValue = String(value.path ?? '').trim();
  if (!isLocalMusicPath(pathValue)) {
    return null;
  }
  const name = String(value.name ?? '').trim() || stripAudioExtension(basename(pathValue));
  return {
    id: String(value.id ?? '').trim() || localMusicTrackId(pathValue),
    path: pathValue,
    name,
    classification: normalizeLocalMusicClassification(value.classification),
  };
}

function normalizeLocalMusicPlaylist(value: unknown): LocalMusicPlaylist | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = String(value.id ?? '').trim();
  const name = String(value.name ?? '').trim();
  if (!id || !name) {
    return null;
  }
  const trackIds = Array.isArray(value.trackIds)
    ? Array.from(
        new Set(
          value.trackIds
            .map((item) => String(item ?? '').trim())
            .filter(Boolean),
        ),
      )
    : [];
  const kind = value.kind === 'smart' ? 'smart' : 'manual';
  return {
    id,
    name,
    trackIds,
    kind,
    description: String(value.description ?? '').trim() || undefined,
    rules: isRecord(value.rules) ? value.rules : undefined,
    createdAt: String(value.createdAt ?? '').trim() || new Date().toISOString(),
    updatedAt: String(value.updatedAt ?? '').trim() || new Date().toISOString(),
  };
}

function normalizeLocalMusicClassification(
  value: unknown,
): LocalMusicClassification | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return {
    source: value.source === 'ai' ? 'ai' : 'manual',
    tags: Array.isArray(value.tags)
      ? value.tags.map((item) => String(item ?? '').trim()).filter(Boolean)
      : [],
    mood: String(value.mood ?? '').trim() || undefined,
    genre: String(value.genre ?? '').trim() || undefined,
    energy: typeof value.energy === 'number' && Number.isFinite(value.energy)
      ? value.energy
      : undefined,
    updatedAt: String(value.updatedAt ?? '').trim() || new Date().toISOString(),
  };
}

function localMusicTrackFromPath(pathValue: string): LocalMusicTrack | null {
  const normalized = stripWrappingQuotes(pathValue.trim());
  if (!isLocalMusicPath(normalized)) {
    return null;
  }
  return {
    id: localMusicTrackId(normalized),
    path: normalized,
    name: stripAudioExtension(basename(normalized)),
  };
}

function isLocalMusicPath(value: string) {
  return /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|webm)$/i.test(stripWrappingQuotes(value.trim()));
}

function stripAudioExtension(value: string) {
  return value.replace(/\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|webm)$/i, '');
}

function localMusicTrackId(pathValue: string) {
  const raw = normalizedPathKey(pathValue);
  let hash = 2166136261;
  for (let index = 0; index < raw.length; index += 1) {
    hash ^= raw.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `music-${(hash >>> 0).toString(36)}`;
}

function normalizedPathKey(pathValue: string) {
  return pathValue.replaceAll('\\', '/').toLowerCase();
}

function mergeTrackIds(left: string[], right: string[]) {
  return Array.from(new Set([...left, ...right].map((id) => id.trim()).filter(Boolean)));
}

function trackCountForPlaylist(playlist: LocalMusicPlaylist, tracks: LocalMusicTrack[]) {
  const available = new Set(tracks.map((track) => track.id));
  return playlist.trackIds.filter((id) => available.has(id)).length;
}

function localFileUrl(value: string) {
  const normalized = stripWrappingQuotes(value.trim());
  if (/^file:\/\//i.test(normalized)) {
    if (!window.cardbushDesktop) {
      return normalized;
    }
    try {
      const parsed = new URL(normalized);
      const hostPrefix = parsed.hostname ? `/${parsed.hostname}` : '';
      return encodedLocalResourceUrl(`${hostPrefix}${decodeURIComponent(parsed.pathname)}`);
    } catch {
      return normalized;
    }
  }
  return encodedLocalResourceUrl(normalized);
}

function encodedLocalResourceUrl(value: string) {
  const pathValue = value.replaceAll('\\', '/').replace(/^\/+/, '');
  const encodedPath = pathValue
    .split('/')
    .map((segment, index) =>
      index === 0 && /^[a-z]:$/i.test(segment)
        ? segment
        : encodeURIComponent(segment),
    )
    .join('/');
  const scheme = window.cardbushDesktop ? 'cardbush-file' : 'file';
  return `${scheme}:///${encodedPath}`;
}

function basename(value: string) {
  const normalized = value.replaceAll('\\', '/').replace(/\/+$/, '');
  return normalized.split('/').pop() || value;
}

function stripWrappingQuotes(value: string) {
  return value.replace(/^['"]|['"]$/g, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
