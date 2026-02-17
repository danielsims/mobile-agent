import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { ServerMessage, Project, ProviderModelOption, AgentType, Skill } from '@shared/types';
import { AgentProvider, useAgentState } from './state/AgentContext';
import { useWebSocket } from './hooks/useWebSocket';
import { useSettings } from './hooks/useSettings';
import { ActivityBar, type ActivityTab } from './components/ActivityBar';
import { Toolbar } from './components/Toolbar';
import { TerminalGrid } from './components/TerminalGrid';
import { Sidebar, type GitStatusData } from './components/Sidebar';
import { DiffView } from './components/DiffView';
import { CreateAgentModal } from './components/CreateAgentModal';
import type { SkillSearchResult } from './components/SkillsPanel';

interface ServiceInfo {
  port: number;
  token: string;
  tunnel_url: string | null;
}

interface PairingInfoState {
  url: string;
  pairingToken: string;
  serverPublicKey: string;
  expiresAt: number;
}

function AppInner() {
  const { state, dispatch, handleServerMessage } = useAgentState();
  const { settings, updateSetting } = useSettings();
  const [serviceInfo, setServiceInfo] = useState<ServiceInfo | null>(null);
  const [serviceError, setServiceError] = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [models, setModels] = useState<ProviderModelOption[]>([]);

  // Activity bar state
  const [activeTab, setActiveTab] = useState<ActivityTab>('git');

  // Git state
  const [gitDataMap, setGitDataMap] = useState<Map<string, GitStatusData>>(new Map());
  const [gitDiffMap, setGitDiffMap] = useState<Map<string, string>>(new Map());

  // Derive loading state: an agent is loading if it has a cwd but no git data yet
  const loadingGitStatus = useMemo(() => {
    const loading = new Set<string>();
    for (const agent of state.agents.values()) {
      if (agent.cwd && !gitDataMap.has(agent.id)) {
        loading.add(agent.id);
      }
    }
    return loading;
  }, [state.agents, gitDataMap]);

  // Diff view state — when a file is clicked, show diff in main area
  const [activeDiff, setActiveDiff] = useState<{ agentId: string; filePath: string } | null>(null);

  // Skills state
  const [skills, setSkills] = useState<Skill[]>([]);
  const [skillSearchResults, setSkillSearchResults] = useState<SkillSearchResult[]>([]);
  const [skillSearchLoading, setSkillSearchLoading] = useState(false);
  const [installStatus, setInstallStatus] = useState<string | null>(null);

  // Mobile pairing state
  const [pairingInfo, setPairingInfo] = useState<PairingInfoState | null>(null);
  const [pairingError, setPairingError] = useState<string | null>(null);

  const onConnect = useCallback(() => {
    // Connected and authenticated
  }, []);

  const onDisconnect = useCallback((_code: number, _willReconnect: boolean) => {
    // Will auto-reconnect if applicable
  }, []);

  const onMessage = useCallback((msg: ServerMessage) => {
    handleServerMessage(msg);

    // Handle project/model list responses
    if (msg.type === 'projectList' && msg.projects) {
      setProjects(msg.projects);
    }
    if (msg.type === 'modelList' && msg.models) {
      setModels(msg.models);
    }

    // Handle git status response
    if (msg.type === 'gitStatus' && msg.agentId) {
      setGitDataMap(prev => {
        const next = new Map(prev);
        next.set(msg.agentId!, {
          branch: msg.branch ?? null,
          files: msg.files ?? [],
          ahead: msg.ahead ?? 0,
          behind: msg.behind ?? 0,
        });
        return next;
      });
    }

    // Handle git diff response
    if (msg.type === 'gitDiff' && msg.agentId && msg.filePath) {
      setGitDiffMap(prev => {
        const next = new Map(prev);
        next.set(`${msg.agentId}:${msg.filePath}`, msg.diff ?? '');
        return next;
      });
    }

    // Handle skills responses
    if (msg.type === 'skillList' && msg.skills) {
      setSkills(msg.skills);
    }
    if (msg.type === 'skillSearchResults' && msg.searchResults) {
      setSkillSearchResults(msg.searchResults);
      setSkillSearchLoading(false);
    }
    // Handle pairing info response
    if (msg.type === 'pairingInfo') {
      if (msg.error) {
        setPairingError(msg.error);
        setPairingInfo(null);
      } else if (msg.url && msg.pairingToken && msg.serverPublicKey && msg.expiresAt) {
        setPairingInfo({
          url: msg.url,
          pairingToken: msg.pairingToken,
          serverPublicKey: msg.serverPublicKey,
          expiresAt: msg.expiresAt,
        });
        setPairingError(null);
      }
    }

    if (msg.type === 'skillInstallProgress' && msg.installStatus) {
      setInstallStatus(msg.installStatus);
      if (msg.installStatus === 'installed' || msg.installStatus === 'error') {
        setTimeout(() => setInstallStatus(null), 2000);
      }
    }
  }, [handleServerMessage]);

  const { status, connect, send, disconnect: _disconnect } = useWebSocket({
    onMessage,
    onConnect,
    onDisconnect,
  });

  // Keep send in a ref so callbacks don't depend on it
  const sendRef = useRef(send);
  useEffect(() => { sendRef.current = send; }, [send]);

  // Poll for service info on startup
  useEffect(() => {
    let cancelled = false;

    async function waitForService() {
      const maxAttempts = 90; // 90 * 500ms = 45s to match Tauri timeout
      for (let i = 0; i < maxAttempts; i++) {
        if (cancelled) return;
        try {
          const info = await invoke<ServiceInfo>('get_service_info');
          if (!cancelled) {
            setServiceInfo(info);
            return;
          }
        } catch {
          // Service not ready yet
        }
        await new Promise(r => setTimeout(r, 500));
      }
      if (!cancelled) {
        setServiceError('Service failed to start');
      }
    }

    waitForService();
    return () => { cancelled = true; };
  }, []);

  // Connect WebSocket when service info is available
  useEffect(() => {
    if (serviceInfo) {
      connect(serviceInfo.port, serviceInfo.token);
    }
  }, [serviceInfo, connect]);

  // Listen for service crash
  useEffect(() => {
    const unlisten = listen<string>('service-crashed', (event) => {
      setServiceError(event.payload);
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  // Keyboard shortcut for creating agents
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return;

      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        setShowCreateModal(true);
      }
      // Escape to close diff view
      if (e.key === 'Escape' && activeDiff) {
        setActiveDiff(null);
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [activeDiff]);

  // Request history for all agents once when connected
  const historyRequestedRef = useRef(false);
  useEffect(() => {
    if (status !== 'connected') {
      historyRequestedRef.current = false;
      return;
    }
    if (historyRequestedRef.current) return;
    historyRequestedRef.current = true;

    for (const agent of state.agents.values()) {
      if (agent.messages.length === 0) {
        sendRef.current('getHistory', { agentId: agent.id });
      }
    }
  }, [status, state.agents]);

  // Request git status for all agents on mount and when agents go idle
  const gitStatusRequestedRef = useRef(new Set<string>());
  useEffect(() => {
    if (status !== 'connected') return;

    for (const agent of state.agents.values()) {
      if (!agent.cwd) continue;
      const key = `${agent.id}:${agent.status}`;
      if (
        !gitStatusRequestedRef.current.has(agent.id) ||
        (agent.status === 'idle' && !gitStatusRequestedRef.current.has(key))
      ) {
        gitStatusRequestedRef.current.add(agent.id);
        gitStatusRequestedRef.current.add(key);
        sendRef.current('getGitStatus', { agentId: agent.id });
      }
    }
  }, [status, state.agents]);

  // Request skills list and projects when connected
  const skillsRequestedRef = useRef(false);
  const projectsRequestedRef = useRef(false);
  useEffect(() => {
    if (status !== 'connected') {
      skillsRequestedRef.current = false;
      projectsRequestedRef.current = false;
      return;
    }
    if (!skillsRequestedRef.current) {
      skillsRequestedRef.current = true;
      sendRef.current('listSkills', {});
    }
    if (!projectsRequestedRef.current) {
      projectsRequestedRef.current = true;
      sendRef.current('listProjects', {});
    }
  }, [status]);

  // Pending prompt for newly created agents
  const pendingPromptRef = useRef<string | null>(null);
  const prevAgentCountRef = useRef(state.agents.size);

  // Detect new agent creation and send pending prompt
  useEffect(() => {
    const currentCount = state.agents.size;
    if (pendingPromptRef.current && currentCount > prevAgentCountRef.current) {
      const agents = Array.from(state.agents.values());
      const newest = agents[agents.length - 1];
      if (newest) {
        const prompt = pendingPromptRef.current;
        const agentId = newest.id;
        pendingPromptRef.current = null;
        setTimeout(() => {
          sendRef.current('sendMessage', { agentId, text: prompt });
        }, 500);
      }
    }
    prevAgentCountRef.current = currentCount;
  }, [state.agents]);

  const handleCreateAgent = useCallback((opts: {
    agentType: AgentType;
    projectId: string | null;
    worktreePath: string | null;
    model: string;
    prompt: string;
  }) => {
    sendRef.current('createAgent', {
      agentType: opts.agentType,
      projectId: opts.projectId,
      worktreePath: opts.worktreePath,
      model: opts.model || undefined,
    });

    if (opts.prompt.trim()) {
      pendingPromptRef.current = opts.prompt.trim();
    }
  }, []);

  const handleRequestModels = useCallback((agentType: AgentType) => {
    setModels([]);
    sendRef.current('listModels', { agentType });
  }, []);

  const handleRequestProjects = useCallback(() => {
    sendRef.current('listProjects', {});
  }, []);

  // Git file click → open diff in main area
  const handleFileClick = useCallback((agentId: string, filePath: string) => {
    // Toggle off if clicking the same file
    if (activeDiff?.agentId === agentId && activeDiff?.filePath === filePath) {
      setActiveDiff(null);
      return;
    }
    setActiveDiff({ agentId, filePath });
    // Request the diff if we don't have it
    const diffKey = `${agentId}:${filePath}`;
    if (!gitDiffMap.has(diffKey)) {
      sendRef.current('getGitDiff', { agentId, filePath });
    }
  }, [activeDiff, gitDiffMap]);

  // Skills callbacks
  const handleSearchSkills = useCallback((query: string) => {
    setSkillSearchLoading(true);
    sendRef.current('searchSkills', { query });
  }, []);

  const handleInstallSkill = useCallback((packageRef: string) => {
    sendRef.current('installSkill', { packageRef });
    setInstallStatus('installing');
  }, []);

  const handleUpdateSkill = useCallback((name: string, body: string) => {
    sendRef.current('updateSkill', { name, body });
  }, []);

  // Mobile pairing
  const handleRequestPairingInfo = useCallback(() => {
    sendRef.current('getPairingInfo', {});
  }, []);

  const tunnelAvailable = !!serviceInfo?.tunnel_url;

  if (serviceError) {
    return (
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        color: 'var(--text-muted)',
      }}>
        <div style={{ fontSize: 14, color: 'var(--danger)' }}>Service Error</div>
        <div style={{ fontSize: 12, maxWidth: 400, textAlign: 'center' }}>{serviceError}</div>
      </div>
    );
  }

  if (!serviceInfo) {
    return (
      <div style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--text-muted)',
        fontSize: 13,
      }}>
        Starting service...
      </div>
    );
  }

  const diffKey = activeDiff ? `${activeDiff.agentId}:${activeDiff.filePath}` : null;

  return (
    <>
      <ActivityBar activeTab={activeTab} onTabChange={setActiveTab} />
      <Sidebar
        activeTab={activeTab}
        agents={state.agents}
        projects={projects}
        settings={settings}
        onUpdateSetting={updateSetting}
        gitDataMap={gitDataMap}
        loadingGitStatus={loadingGitStatus}
        onFileClick={handleFileClick}
        activeFile={activeDiff}
        skills={skills}
        searchResults={skillSearchResults}
        searchLoading={skillSearchLoading}
        installStatus={installStatus}
        onSearchSkills={handleSearchSkills}
        onClearSearchResults={() => { setSkillSearchResults([]); setSkillSearchLoading(false); }}
        onInstallSkill={handleInstallSkill}
        onUpdateSkill={handleUpdateSkill}
        onRequestPairingInfo={handleRequestPairingInfo}
        pairingInfo={pairingInfo}
        pairingError={pairingError}
        tunnelAvailable={tunnelAvailable}
      />
      <div className="main-content">
        <Toolbar
          connectionStatus={status}
          onCreateAgent={() => setShowCreateModal(true)}
        />
        {activeDiff ? (
          <DiffView
            filePath={activeDiff.filePath}
            diff={diffKey ? gitDiffMap.get(diffKey) : undefined}
            onClose={() => setActiveDiff(null)}
          />
        ) : (
          <TerminalGrid
            agents={state.agents}
            agentOrder={state.agentOrder}
            projects={projects}
            colorfulGitLabels={settings.colorfulGitLabels}
            dispatch={dispatch}
            onSendMessage={(agentId, text) => {
              sendRef.current('sendMessage', { agentId, text });
              dispatch({
                type: 'ADD_MESSAGE',
                agentId,
                message: {
                  id: `local-${Date.now()}`,
                  type: 'user',
                  content: text,
                  timestamp: Date.now(),
                },
              });
            }}
            onInterrupt={(agentId) => sendRef.current('interruptAgent', { agentId })}
            onRespondPermission={(agentId, requestId, behavior) => {
              sendRef.current('respondPermission', { agentId, requestId, behavior });
              dispatch({ type: 'REMOVE_PERMISSION', agentId, requestId });
            }}
            onSetAutoApprove={(agentId, enabled) => {
              sendRef.current('setAutoApprove', { agentId, enabled });
              dispatch({ type: 'SET_SESSION_INFO', agentId, autoApprove: enabled });
            }}
            onDestroy={(agentId) => sendRef.current('destroyAgent', { agentId })}
            onRequestHistory={(agentId) => sendRef.current('getHistory', { agentId })}
            onCreateAgent={() => setShowCreateModal(true)}
          />
        )}
      </div>

      {showCreateModal && (
        <CreateAgentModal
          projects={projects}
          models={models}
          onClose={() => setShowCreateModal(false)}
          onCreate={handleCreateAgent}
          onRequestModels={handleRequestModels}
          onRequestProjects={handleRequestProjects}
        />
      )}
    </>
  );
}

export function App() {
  return (
    <AgentProvider>
      <AppInner />
    </AgentProvider>
  );
}
