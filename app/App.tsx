import { StatusBar } from 'expo-status-bar';
import { CameraView, useCameraPermissions } from 'expo-camera';
import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { SafeAreaView, SafeAreaProvider } from 'react-native-safe-area-context';

import { AgentProvider, useAgentState } from './state/AgentContext';
import { SettingsProvider } from './state/SettingsContext';
import { Dashboard, AgentDetailScreen, CreateAgentModal, SettingsScreen } from './components';
import { GitScreen } from './components/GitScreen';
import { SkillsScreen, type SkillSearchResult } from './components/SkillsScreen';
import { useWebSocket } from './hooks/useWebSocket';
import { useNotifications } from './hooks/useNotifications';
import { useCompletionChime } from './hooks/useCompletionChime';
import { parseQRCode, clearCredentials, isPaired, type QRPairingData } from './utils/auth';
import type { Project, AgentType, GitLogCommit, ProviderModelOption, Skill } from './state/types';
import type { GitStatusData } from './components/GitTabContent';

type Screen = 'pairing' | 'scanner' | 'dashboard' | 'agent' | 'settings' | 'git' | 'skills';
const MODEL_PREFETCH_TYPES: AgentType[] = ['claude', 'codex', 'opencode'];

// Inner app component that has access to AgentContext
function AppInner() {
  const [screen, setScreen] = useState<Screen>('pairing');
  const [scanned, setScanned] = useState(false);
  const scannedRef = useRef(false); // Synchronous guard — state is async
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createModalInitialProjectId, setCreateModalInitialProjectId] = useState<string | undefined>();
  const [createModalInitialWorktreePath, setCreateModalInitialWorktreePath] = useState<string | undefined>();
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [modelsByType, setModelsByType] = useState<Record<string, ProviderModelOption[]>>({});
  const [modelsLoadingType, setModelsLoadingType] = useState<AgentType | null>(null);
  const [hasCreds, setHasCreds] = useState(false);

  const { state, dispatch, handleServerMessage, loadCachedMessages } = useAgentState();
  const { notifyTaskComplete } = useNotifications();
  const { play: playChime } = useCompletionChime();

  // Git state — local to the active agent detail view
  const [gitStatus, setGitStatus] = useState<GitStatusData | null>(null);
  const [gitDiff, setGitDiff] = useState<string | null>(null);
  const [gitLoading, setGitLoading] = useState(false);
  const [gitDiffLoading, setGitDiffLoading] = useState(false);

  // Git overview state — for the GitScreen dashboard view
  const [gitDataMap, setGitDataMap] = useState<Map<string, GitStatusData>>(new Map());
  const [gitLoadingAgents, setGitLoadingAgents] = useState<Set<string>>(new Set());

  // Worktree-level git status — keyed by worktree path
  const [worktreeGitData, setWorktreeGitData] = useState<Map<string, GitStatusData>>(new Map());
  const [worktreeGitLoading, setWorktreeGitLoading] = useState<Set<string>>(new Set());

  // Git log state — per-project commit history
  const [gitLogMap, setGitLogMap] = useState<Map<string, GitLogCommit[]>>(new Map());
  const [gitLogLoading, setGitLogLoading] = useState<Set<string>>(new Set());

  // Skills state
  const [skills, setSkills] = useState<Skill[]>([]);
  const [skillSearchResults, setSkillSearchResults] = useState<SkillSearchResult[]>([]);
  const [skillSearchLoading, setSkillSearchLoading] = useState(false);

  // Whether we have stored pairing credentials (checked on mount, updated on pair/unpair)
  useEffect(() => {
    isPaired().then(setHasCreds);
  }, []);

  // Stable refs for WebSocket callbacks — avoids stale closures
  const stateRef = useRef(state);
  stateRef.current = state;
  const handleServerMessageRef = useRef(handleServerMessage);
  handleServerMessageRef.current = handleServerMessage;
  const loadCachedMessagesRef = useRef(loadCachedMessages);
  loadCachedMessagesRef.current = loadCachedMessages;
  const sendRef = useRef<(type: string, data?: Record<string, unknown>) => boolean>(() => false);
  const pendingSkillRef = useRef<{ worktreePath: string; prompt: string } | null>(null);
  const navigateOnCreateRef = useRef(false);

  const onWsMessage = useCallback((msg: import('./state/types').ServerMessage) => {
    handleServerMessageRef.current(msg);

    // Navigate to and optionally send a skill prompt to a newly created agent
    if (msg.type === 'agentCreated' && msg.agent) {
      const newAgentId = msg.agent.id;
      const pending = pendingSkillRef.current;
      if (pending && msg.agent.cwd === pending.worktreePath) {
        pendingSkillRef.current = null;
        // Small delay to let the agent finish spawning before sending
        setTimeout(() => {
          sendRef.current('sendMessage', { agentId: newAgentId, text: pending.prompt });
        }, 500);
      }
      if (navigateOnCreateRef.current) {
        navigateOnCreateRef.current = false;
        setSelectedAgentId(newAgentId);
        setScreen('agent');
      }
    }

    // On initial connect, load from cache then request history from server.
    // The agentHistory handler skips processing if cache already has data,
    // so the server request is only processed on cold start.
    if (msg.type === 'connected' && msg.agents) {
      for (const agent of msg.agents) {
        loadCachedMessagesRef.current(agent.id);
        sendRef.current('getHistory', { agentId: agent.id });
      }
      sendRef.current('listProjects');
      sendRef.current('listSkills');
    }

    // Project list response
    if (msg.type === 'projectList') {
      if (msg.projects) {
        setProjects(msg.projects);
      }
      setProjectsLoading(false);
    }

    if (msg.type === 'modelList' && msg.agentType) {
      const agentType = msg.agentType;
      setModelsByType(prev => ({
        ...prev,
        [agentType]: msg.models || [],
      }));
      setModelsLoadingType(prev => (prev === agentType ? null : prev));
    }

    // Worktree created — update projects list and fetch status for the new worktree
    if (msg.type === 'worktreeCreated' && msg.projectId && msg.worktrees) {
      setProjects(prev => prev.map(p =>
        p.id === msg.projectId ? { ...p, worktrees: msg.worktrees || [] } : p
      ));
      // Request git status for the newly created worktree so it renders immediately
      if (msg.worktree?.path) {
        sendRef.current('getWorktreeStatus', { worktreePath: msg.worktree.path });
      }
    }

    // Worktree removed — update projects list with remaining worktrees
    if (msg.type === 'worktreeRemoved' && msg.projectId && msg.worktrees) {
      setProjects(prev => prev.map(p =>
        p.id === msg.projectId ? { ...p, worktrees: msg.worktrees || [] } : p
      ));
    }

    // Git status response
    if (msg.type === 'gitStatus' && msg.agentId) {
      const agentId = msg.agentId;
      const gitData: GitStatusData = {
        branch: msg.branch || '',
        ahead: msg.ahead || 0,
        behind: msg.behind || 0,
        files: msg.files || [],
      };
      setGitStatus(gitData);
      setGitLoading(false);
      // Also update the git overview map (for GitScreen)
      setGitDataMap(prev => {
        const next = new Map(prev);
        next.set(agentId, gitData);
        return next;
      });
      setGitLoadingAgents(prev => {
        const next = new Set(prev);
        next.delete(agentId);
        return next;
      });
    }

    // Worktree-level git status response
    if (msg.type === 'worktreeStatus' && msg.worktreePath) {
      const wtPath = msg.worktreePath;
      const gitData: GitStatusData = {
        branch: msg.branch || '',
        ahead: msg.ahead || 0,
        behind: msg.behind || 0,
        files: msg.files || [],
      };
      setWorktreeGitData(prev => {
        const next = new Map(prev);
        next.set(wtPath, gitData);
        return next;
      });
      setWorktreeGitLoading(prev => {
        const next = new Set(prev);
        next.delete(wtPath);
        return next;
      });
    }

    // Git diff response
    if (msg.type === 'gitDiff' && msg.agentId) {
      setGitDiff(msg.diff || '');
      setGitDiffLoading(false);
    }

    // Git log response
    if (msg.type === 'gitLog' && msg.projectPath) {
      const projectPath = msg.projectPath;
      setGitLogMap(prev => {
        const next = new Map(prev);
        next.set(projectPath, msg.commits || []);
        return next;
      });
      setGitLogLoading(prev => {
        const next = new Set(prev);
        next.delete(projectPath);
        return next;
      });
    }

    // Skill list response
    if (msg.type === 'skillList') {
      setSkills(msg.skills || []);
    }

    // Skill search results
    if (msg.type === 'skillSearchResults') {
      setSkillSearchResults((msg.searchResults || []).map((r) => ({
        name: r.name || '',
        description: r.description || '',
        packageRef: r.packageRef || '',
        url: r.url || '',
      })));
      setSkillSearchLoading(false);
    }

    // Skill install progress
    if (msg.type === 'skillInstallProgress') {
      if (msg.installStatus === 'installed') {
        setSkillSearchLoading(false);
        // Re-fetch skills so the newly installed one appears immediately
        sendRef.current('listSkills');
      } else if (msg.installStatus === 'error') {
        setSkillSearchLoading(false);
        Alert.alert('Install Failed', msg.error || 'Unknown error');
      }
    }

    // Play chime + notify on agent result
    if (msg.type === 'agentResult' && msg.agentId) {
      playChime();
      const agent = stateRef.current.agents.get(msg.agentId);
      const name = agent?.sessionName || 'Agent';
      const cost = msg.totalCost || msg.cost || 0;
      const preview = agent?.lastOutput?.split('\n')[0]?.slice(0, 100) || 'Task completed';
      notifyTaskComplete(`[${name}] ${preview} ($${cost.toFixed(2)})`);
    }
  }, [playChime, notifyTaskComplete]);

  const onWsConnect = useCallback(() => {
    setHasCreds(true);
    // Navigate to dashboard from pre-auth screens.
    // If already on dashboard/agent (mid-session reconnect), stay put.
    setScreen(prev =>
      prev === 'pairing' || prev === 'scanner'
        ? 'dashboard'
        : prev,
    );
  }, []);

  const onWsDisconnect = useCallback((code: number, willReconnect: boolean) => {
    if (!willReconnect && code !== 1000) {
      // All retries exhausted or non-recoverable error — go to pairing screen.
      // Skip code 1000 (intentional close, e.g. unpair) — handled elsewhere.
      setScreen('pairing');
    }
  }, []);

  // WebSocket connection
  const {
    status: connectionStatus,
    authStatus,
    connect,
    pair,
    send,
    disconnect,
    resetPingTimer,
  } = useWebSocket({
    onMessage: onWsMessage,
    onConnect: onWsConnect,
    onDisconnect: onWsDisconnect,
    onAuthError: () => {
      clearCredentials();
      setHasCreds(false);
    },
  });

  // Keep sendRef in sync so onWsMessage can call send() without circular deps
  sendRef.current = send;


  // QR code scanning
  const handleScanPress = async () => {
    if (!permission?.granted) {
      const result = await requestPermission();
      if (!result.granted) return;
    }
    scannedRef.current = false;
    setScanned(false);
    setScreen('scanner');
  };

  const handleBarCodeScanned = ({ data }: { data: string }) => {
    // Use ref for synchronous guard — setState is async and the scanner
    // fires multiple times before React re-renders with scanned=true
    if (scannedRef.current) return;
    scannedRef.current = true;
    setScanned(true);

    const qrData = parseQRCode(data);
    if (qrData) {
      handleQRScanned(qrData);
    } else {
      Alert.alert('Invalid QR Code', 'This doesn\'t look like a Mobile Agent pairing code.');
      scannedRef.current = false;
      setScanned(false);
    }
  };

  const handleQRScanned = async (qrData: QRPairingData) => {
    // Go back to pairing screen — it shows "Connecting..." while status is 'connecting'.
    // onWsConnect will navigate to dashboard when the connection succeeds.
    setScreen('pairing');

    // Always pair when scanning a QR code. The token is fresh from the QR,
    // and re-pairing handles device re-registration cleanly (e.g. after service
    // restart where the device was lost from devices.json, or after app reinstall
    // where the device generated a new keypair).
    pair(qrData);
    // Success: onWsConnect → dashboard
    // Failure: onWsDisconnect → stays on pairing, status resets, button reappears
  };

  const handleUnpair = async () => {
    disconnect();
    await clearCredentials();
    setHasCreds(false);
    dispatch({ type: 'SET_AGENTS', agents: [] });
    dispatch({ type: 'SET_ACTIVE_AGENT', agentId: null });
    setScreen('pairing');
  };

  // Agent actions
  const prefetchModelsForCreateFlow = useCallback(() => {
    for (const type of MODEL_PREFETCH_TYPES) {
      if (Object.prototype.hasOwnProperty.call(modelsByType, type)) continue;
      send('listModels', { agentType: type });
    }
  }, [modelsByType, send]);

  const handleCreateAgent = () => {
    prefetchModelsForCreateFlow();
    setCreateModalInitialProjectId(undefined);
    setCreateModalInitialWorktreePath(undefined);
    setShowCreateModal(true);
  };

  const handleCreateAgentForWorktree = (projectId: string, worktreePath: string, pendingPrompt?: string) => {
    if (pendingPrompt) {
      pendingSkillRef.current = { worktreePath, prompt: pendingPrompt };
    }
    navigateOnCreateRef.current = true;
    prefetchModelsForCreateFlow();
    setCreateModalInitialProjectId(projectId);
    setCreateModalInitialWorktreePath(worktreePath);
    setShowCreateModal(true);
  };

  const handleCreateAgentSubmit = (config: {
    agentType: AgentType;
    model?: string;
    projectId?: string;
    worktreePath?: string;
  }) => {
    send('createAgent', {
      agentType: config.agentType,
      model: config.model,
      projectId: config.projectId,
      worktreePath: config.worktreePath,
    });
  };

  const handleRequestProjects = () => {
    setProjectsLoading(true);
    send('listProjects');
  };

  const handleRequestModels = (agentType: AgentType) => {
    setModelsLoadingType(agentType);
    send('listModels', { agentType });
  };

  const handleCreateWorktree = (projectId: string, branchName: string) => {
    send('createWorktree', { projectId, branchName });
  };

  const handleRemoveWorktree = (projectId: string, worktreePath: string) => {
    send('removeWorktree', { projectId, worktreePath });
  };

  const handleUnregisterProject = (projectId: string) => {
    send('unregisterProject', { projectId });
  };

  const handleDestroyAgent = (agentId: string) => {
    send('destroyAgent', { agentId });
    if (selectedAgentId === agentId) {
      setSelectedAgentId(null);
      setScreen('dashboard');
    }
  };

  const handleSelectAgent = (agentId: string) => {
    dispatch({ type: 'SET_ACTIVE_AGENT', agentId });
    setSelectedAgentId(agentId);
    setScreen('agent');

    // Load cached messages in background — only fetch from server if cache was empty
    loadCachedMessages(agentId).then((hadCache) => {
      if (!hadCache) {
        send('getHistory', { agentId });
      }
    });
  };

  const handleSendMessage = (agentId: string, text: string) => {
    send('sendMessage', { agentId, text });
  };

  const handleStopAgent = (agentId: string) => {
    send('interruptAgent', { agentId });
    // Optimistic: unblock input immediately while backend performs interrupt.
    dispatch({ type: 'UPDATE_AGENT_STATUS', agentId, status: 'idle' });
  };

  const handleRespondPermission = (agentId: string, requestId: string, behavior: 'allow' | 'deny') => {
    send('respondPermission', { agentId, requestId, behavior });
    dispatch({ type: 'REMOVE_PERMISSION', agentId, requestId });
  };

  const handleRequestGitStatus = useCallback((agentId: string) => {
    setGitLoading(true);
    send('getGitStatus', { agentId });
  }, [send]);

  const handleRequestGitDiff = useCallback((agentId: string, filePath: string) => {
    setGitDiffLoading(true);
    setGitDiff(null);
    send('getGitDiff', { agentId, filePath });
  }, [send]);

  const handleSetAutoApprove = (agentId: string, enabled: boolean) => {
    send('setAutoApprove', { agentId, enabled });
    dispatch({ type: 'SET_SESSION_INFO', agentId, autoApprove: enabled });
  };

  const handleBackToDashboard = () => {
    setSelectedAgentId(null);
    dispatch({ type: 'SET_ACTIVE_AGENT', agentId: null });
    setGitStatus(null);
    setGitDiff(null);
    setScreen('dashboard');
  };

  const handleOpenSettings = () => {
    setScreen('settings');
  };

  const handleBackFromSettings = () => {
    setScreen('dashboard');
  };

  const handleOpenGit = () => {
    setScreen('git');
  };

  const handleBackFromGit = () => {
    setScreen('dashboard');
  };

  const handleOpenSkills = () => {
    send('listSkills'); // Refresh on open
    setScreen('skills');
  };

  const handleBackFromSkills = () => {
    setSkillSearchResults([]);
    setSkillSearchLoading(false);
    setScreen('dashboard');
  };

  const handleUpdateSkill = (name: string, body: string) => {
    send('updateSkill', { name, body });
  };

  const handleInstallSkill = (packageRef: string) => {
    setSkillSearchLoading(true);
    send('installSkill', { packageRef });
  };

  const handleSearchSkills = useCallback((query: string) => {
    setSkillSearchLoading(true);
    setSkillSearchResults([]);
    send('searchSkills', { query });
  }, [send]);

  // Note: pending worktree skill fulfillment is handled in onWsMessage
  // when 'agentCreated' arrives, to avoid matching existing agents by cwd.

  // For GitScreen: request worktree-level git status
  const handleRequestWorktreeStatus = useCallback((worktreePath: string) => {
    setWorktreeGitLoading(prev => {
      const next = new Set(prev);
      next.add(worktreePath);
      return next;
    });
    send('getWorktreeStatus', { worktreePath });
  }, [send]);

  // For GitScreen: request status for any agent (tracks loading state)
  const handleGitScreenRequestStatus = useCallback((agentId: string) => {
    setGitLoadingAgents(prev => {
      const next = new Set(prev);
      next.add(agentId);
      return next;
    });
    send('getGitStatus', { agentId });
  }, [send]);

  // For GitScreen: request commit log for a project
  const handleRequestGitLog = useCallback((projectPath: string) => {
    setGitLogLoading(prev => {
      const next = new Set(prev);
      next.add(projectPath);
      return next;
    });
    send('getGitLog', { projectPath });
  }, [send]);

  // --- Screen rendering ---

  // QR Scanner
  if (screen === 'scanner') {
    return (
      <SafeAreaView style={styles.container}>
        <StatusBar style="light" />
        <View style={styles.scannerContainer}>
          <CameraView
            style={StyleSheet.absoluteFillObject}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={scanned ? undefined : handleBarCodeScanned}
          />
          <View style={styles.scannerOverlay}>
            <View style={styles.scannerFrame} />
            <Text style={styles.scannerHint}>Scan the QR code from your terminal</Text>
          </View>
          <TouchableOpacity
            style={styles.cancelBtn}
            onPress={() => setScreen('pairing')}
          >
            <Text style={styles.cancelBtnText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // Pairing screen
  if (screen === 'pairing') {
    const isConnecting = connectionStatus === 'connecting' || authStatus === 'authenticating';

    return (
      <SafeAreaView style={styles.container}>
        <StatusBar style="light" />
        <View style={styles.pairingContainer}>
          <Text style={styles.pairingTitle}>Mobile Agent</Text>
          <Text style={styles.pairingSubtitle}>
            Control coding agents remotely from your phone
          </Text>

          {isConnecting ? (
            <>
              <TouchableOpacity style={styles.primaryBtnConnecting} activeOpacity={1}>
                <View style={styles.primaryBtnRow}>
                  <ActivityIndicator color="#888" size="small" />
                  <Text style={styles.primaryBtnTextConnecting}>Connecting...</Text>
                </View>
              </TouchableOpacity>
              <TouchableOpacity style={styles.secondaryBtn} onPress={() => disconnect()}>
                <Text style={styles.secondaryBtnText}>Cancel</Text>
              </TouchableOpacity>
            </>
          ) : hasCreds ? (
            <>
              <TouchableOpacity style={styles.primaryBtn} onPress={() => connect()}>
                <Text style={styles.primaryBtnText}>Connect</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.secondaryBtn} onPress={handleScanPress}>
                <Text style={styles.secondaryBtnText}>Scan New QR Code</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <TouchableOpacity style={styles.primaryBtn} onPress={handleScanPress}>
                <Text style={styles.primaryBtnText}>Scan QR Code</Text>
              </TouchableOpacity>
              <Text style={styles.pairingHelp}>
                Run `npm start` in the mobile-agent/service directory,{'\n'}
                then scan the QR code shown in your terminal.
              </Text>
            </>
          )}
        </View>
      </SafeAreaView>
    );
  }

  // Dashboard + overlays (layered so dashboard is visible during swipe-back)
  if (screen === 'dashboard' || (screen === 'agent' && selectedAgentId) || screen === 'settings' || screen === 'git' || screen === 'skills') {
    return (
      <View style={styles.container}>
        <StatusBar style="light" />
        <SafeAreaView style={styles.safeTop} />
        <View style={styles.layerBase} pointerEvents={screen === 'dashboard' ? 'auto' : 'none'}>
          <Dashboard
            connectionStatus={connectionStatus}
            projects={projects}
            onSelectAgent={handleSelectAgent}
            onCreateAgent={handleCreateAgent}
            onDestroyAgent={handleDestroyAgent}
            onSendMessage={handleSendMessage}
            onOpenSettings={handleOpenSettings}
            onOpenGit={handleOpenGit}
            onOpenSkills={handleOpenSkills}
          />
        </View>
        {screen === 'agent' && selectedAgentId && (
          <View style={styles.layerOverlay} pointerEvents="box-none">
            <AgentDetailScreen
              agentId={selectedAgentId}
              connectionStatus={connectionStatus}
              projects={projects}
              skills={skills}
              onBack={handleBackToDashboard}
              onSendMessage={handleSendMessage}
              onStopAgent={handleStopAgent}
              onRespondPermission={handleRespondPermission}
              onSetAutoApprove={handleSetAutoApprove}
              onResetPingTimer={resetPingTimer}
              onRequestGitStatus={handleRequestGitStatus}
              onRequestGitDiff={handleRequestGitDiff}
              gitStatus={gitStatus}
              gitDiff={gitDiff}
              gitLoading={gitLoading}
              gitDiffLoading={gitDiffLoading}
            />
          </View>
        )}
        {screen === 'settings' && (
          <View style={styles.layerOverlay} pointerEvents="box-none">
            <SafeAreaView style={styles.safeTop} />
            <SettingsScreen
              onBack={handleBackFromSettings}
              onUnpair={handleUnpair}
            />
          </View>
        )}
        {screen === 'skills' && (
          <View style={styles.layerOverlay} pointerEvents="box-none">
            <SafeAreaView style={styles.safeTop} />
            <SkillsScreen
              onBack={handleBackFromSkills}
              skills={skills}
              onUpdateSkill={handleUpdateSkill}
              onInstallSkill={handleInstallSkill}
              onSearchSkills={handleSearchSkills}
              onClearSearchResults={() => setSkillSearchResults([])}
              searchResults={skillSearchResults}
              searchLoading={skillSearchLoading}
            />
          </View>
        )}
        {screen === 'git' && (
          <View style={styles.layerOverlay} pointerEvents="box-none">
            <SafeAreaView style={styles.safeTop} />
            <GitScreen
              onBack={handleBackFromGit}
              onRequestGitStatus={handleGitScreenRequestStatus}
              onRequestGitLog={handleRequestGitLog}
              onSelectAgent={handleSelectAgent}
              onDestroyAgent={handleDestroyAgent}
              onSendMessage={handleSendMessage}
              onCreateAgentForWorktree={handleCreateAgentForWorktree}
              onCreateWorktree={handleCreateWorktree}
              onRemoveWorktree={handleRemoveWorktree}
              onRefresh={handleRequestProjects}
              onRequestWorktreeStatus={handleRequestWorktreeStatus}
              skills={skills}
              gitDataMap={gitDataMap}
              worktreeGitData={worktreeGitData}
              worktreeGitLoading={worktreeGitLoading}
              gitLogMap={gitLogMap}
              gitLogLoading={gitLogLoading}
              loadingAgentIds={gitLoadingAgents}
              projects={projects}
            />
          </View>
        )}
        <CreateAgentModal
          visible={showCreateModal && (screen === 'dashboard' || screen === 'git')}
          projects={projects}
          projectsLoading={projectsLoading}
          modelsByType={modelsByType}
          modelsLoadingType={modelsLoadingType}
          onClose={() => { setShowCreateModal(false); setCreateModalInitialProjectId(undefined); setCreateModalInitialWorktreePath(undefined); }}
          onSubmit={handleCreateAgentSubmit}
          onRequestProjects={handleRequestProjects}
          onRequestModels={handleRequestModels}
          onCreateWorktree={handleCreateWorktree}
          onUnregisterProject={handleUnregisterProject}
          initialProjectId={createModalInitialProjectId}
          initialWorktreePath={createModalInitialWorktreePath}
        />
      </View>
    );
  }

  // Fallback
  return (
    <View style={styles.container}>
      <StatusBar style="light" />
      <View style={styles.centered}>
        <Text style={styles.errorText}>Something went wrong</Text>
        <TouchableOpacity style={styles.retryBtn} onPress={() => setScreen('pairing')}>
          <Text style={styles.retryBtnText}>Go to Pairing</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// Root component: wraps with providers
export default function App() {
  return (
    <SafeAreaProvider>
      <SettingsProvider>
        <AgentProvider>
          <AppInner />
        </AgentProvider>
      </SettingsProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0a0a0a',
  },
  safeTop: {
    backgroundColor: '#0a0a0a',
  },
  layerBase: {
    flex: 1,
  },
  layerOverlay: {
    ...StyleSheet.absoluteFillObject,
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  // Pairing screen
  pairingContainer: {
    flex: 1,
    padding: 24,
    justifyContent: 'center',
    backgroundColor: '#0a0a0a',
  },
  pairingTitle: {
    fontSize: 28,
    fontWeight: '700',
    color: '#fafafa',
    textAlign: 'center',
    marginBottom: 8,
  },
  pairingSubtitle: {
    fontSize: 15,
    color: '#888',
    textAlign: 'center',
    marginBottom: 40,
    lineHeight: 22,
  },
  primaryBtn: {
    backgroundColor: '#fff',
    padding: 16,
    borderRadius: 10,
    alignItems: 'center',
  },
  primaryBtnText: {
    color: '#000',
    fontSize: 16,
    fontWeight: '600',
  },
  primaryBtnConnecting: {
    backgroundColor: '#1a1a1a',
    padding: 16,
    borderRadius: 10,
    alignItems: 'center',
  },
  primaryBtnRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  primaryBtnTextConnecting: {
    color: '#888',
    fontSize: 16,
    fontWeight: '600',
  },
  secondaryBtn: {
    padding: 14,
    alignItems: 'center',
    marginTop: 12,
  },
  secondaryBtnText: {
    color: '#666',
    fontSize: 14,
    fontWeight: '500',
  },
  pairingHelp: {
    color: '#555',
    fontSize: 13,
    textAlign: 'center',
    marginTop: 24,
    lineHeight: 20,
  },
  // Scanner
  scannerContainer: {
    flex: 1,
  },
  scannerOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.7)',
  },
  scannerFrame: {
    width: 240,
    height: 240,
    borderWidth: 2,
    borderColor: '#fff',
    borderRadius: 12,
  },
  scannerHint: {
    color: '#aaa',
    marginTop: 24,
    fontSize: 14,
  },
  cancelBtn: {
    position: 'absolute',
    bottom: 50,
    left: 24,
    right: 24,
    backgroundColor: '#1a1a1a',
    padding: 14,
    borderRadius: 8,
    alignItems: 'center',
  },
  cancelBtnText: {
    color: '#fafafa',
    fontSize: 15,
  },
  // Error / fallback
  errorText: {
    color: '#888',
    fontSize: 15,
    marginBottom: 16,
  },
  retryBtn: {
    backgroundColor: '#1a1a1a',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
  },
  retryBtnText: {
    color: '#fafafa',
    fontSize: 14,
  },
});
