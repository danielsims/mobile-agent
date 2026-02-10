import { StatusBar } from 'expo-status-bar';
import { CameraView, useCameraPermissions } from 'expo-camera';
import React, { useState, useRef, useCallback } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  SafeAreaView,
  ActivityIndicator,
  Alert,
} from 'react-native';

import { AgentProvider, useAgentState } from './state/AgentContext';
import { Dashboard, AgentDetailScreen, CreateAgentModal } from './components';
import { useWebSocket } from './hooks/useWebSocket';
import { useNotifications } from './hooks/useNotifications';
import { useCompletionChime } from './hooks/useCompletionChime';
import { parseQRCode, clearCredentials, getStoredServerPublicKey, updateServerUrl, type QRPairingData } from './utils/auth';
import type { Project, AgentType } from './state/types';

type Screen = 'pairing' | 'scanner' | 'dashboard' | 'agent';

// Inner app component that has access to AgentContext
function AppInner() {
  const [screen, setScreen] = useState<Screen>('pairing');
  const [scanned, setScanned] = useState(false);
  const scannedRef = useRef(false); // Synchronous guard — state is async
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);

  const { state, dispatch, handleServerMessage } = useAgentState();
  const { notifyTaskComplete } = useNotifications();
  const { play: playChime } = useCompletionChime();

  // Stable refs for WebSocket callbacks — avoids stale closures
  const stateRef = useRef(state);
  stateRef.current = state;
  const handleServerMessageRef = useRef(handleServerMessage);
  handleServerMessageRef.current = handleServerMessage;
  const sendRef = useRef<(type: string, data?: Record<string, unknown>) => boolean>(() => false);

  const onWsMessage = useCallback((msg: import('./state/types').ServerMessage) => {
    handleServerMessageRef.current(msg);

    // On initial connect, request history for all agents so dashboard cards show content
    if (msg.type === 'connected' && msg.agents) {
      for (const agent of msg.agents) {
        sendRef.current('getHistory', { agentId: agent.id });
      }
    }

    // Project list response
    if (msg.type === 'projectList') {
      if (msg.projects) {
        setProjects(msg.projects);
      }
      setProjectsLoading(false);
    }

    // Worktree created — update projects list with new worktrees
    if (msg.type === 'worktreeCreated' && msg.projectId && msg.worktrees) {
      setProjects(prev => prev.map(p =>
        p.id === msg.projectId ? { ...p, worktrees: msg.worktrees || [] } : p
      ));
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
      // Auth failed — connection will close, onWsDisconnect navigates to pairing.
      // No alert needed — user just sees the scan button again.
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

    // Check if already paired with this server (same public key).
    // If so, just update the URL and reconnect — don't consume the pairing token.
    const storedServerPub = await getStoredServerPublicKey();
    if (storedServerPub && storedServerPub === qrData.serverPublicKey) {
      await updateServerUrl(qrData.url);
      connect();
    } else {
      pair(qrData);
    }
    // Success: onWsConnect → dashboard
    // Failure: onWsDisconnect → stays on pairing, status resets, button reappears
  };

  const handleUnpair = async () => {
    disconnect();
    await clearCredentials();
    dispatch({ type: 'SET_AGENTS', agents: [] });
    dispatch({ type: 'SET_ACTIVE_AGENT', agentId: null });
    setScreen('pairing');
  };

  // Agent actions
  const handleCreateAgent = () => {
    setShowCreateModal(true);
  };

  const handleCreateAgentSubmit = (config: {
    agentType: AgentType;
    projectId?: string;
    worktreePath?: string;
  }) => {
    send('createAgent', {
      agentType: config.agentType,
      projectId: config.projectId,
      worktreePath: config.worktreePath,
    });
  };

  const handleRequestProjects = () => {
    setProjectsLoading(true);
    send('listProjects');
  };

  const handleCreateWorktree = (projectId: string, branchName: string) => {
    send('createWorktree', { projectId, branchName });
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

    // Request history for this agent
    send('getHistory', { agentId });
  };

  const handleSendMessage = (agentId: string, text: string) => {
    send('sendMessage', { agentId, text });
  };

  const handleRespondPermission = (agentId: string, requestId: string, behavior: 'allow' | 'deny') => {
    send('respondPermission', { agentId, requestId, behavior });
    dispatch({ type: 'REMOVE_PERMISSION', agentId, requestId });
  };

  const handleBackToDashboard = () => {
    setSelectedAgentId(null);
    dispatch({ type: 'SET_ACTIVE_AGENT', agentId: null });
    setScreen('dashboard');
  };

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
            <View style={styles.pairingLoading}>
              <ActivityIndicator color="#fff" size="small" />
              <Text style={styles.pairingLoadingText}>Connecting...</Text>
            </View>
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

  // Dashboard
  if (screen === 'dashboard') {
    return (
      <View style={styles.container}>
        <StatusBar style="light" />
        <SafeAreaView style={styles.safeTop} />
        <Dashboard
          connectionStatus={connectionStatus}
          onSelectAgent={handleSelectAgent}
          onCreateAgent={handleCreateAgent}
          onDestroyAgent={handleDestroyAgent}
          onSendMessage={handleSendMessage}
          onOpenSettings={handleUnpair}
        />
        <CreateAgentModal
          visible={showCreateModal}
          projects={projects}
          projectsLoading={projectsLoading}
          onClose={() => setShowCreateModal(false)}
          onSubmit={handleCreateAgentSubmit}
          onRequestProjects={handleRequestProjects}
          onCreateWorktree={handleCreateWorktree}
          onUnregisterProject={handleUnregisterProject}
        />
      </View>
    );
  }

  // Agent detail
  if (screen === 'agent' && selectedAgentId) {
    return (
      <View style={styles.container}>
        <StatusBar style="light" />
        <SafeAreaView style={styles.safeTop} />
        <AgentDetailScreen
          agentId={selectedAgentId}
          connectionStatus={connectionStatus}
          onBack={handleBackToDashboard}
          onSendMessage={handleSendMessage}
          onRespondPermission={handleRespondPermission}
          onResetPingTimer={resetPingTimer}
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

// Root component: wraps with AgentProvider
export default function App() {
  return (
    <AgentProvider>
      <AppInner />
    </AgentProvider>
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
  pairingHelp: {
    color: '#555',
    fontSize: 13,
    textAlign: 'center',
    marginTop: 24,
    lineHeight: 20,
  },
  pairingLoading: {
    alignItems: 'center',
    gap: 12,
  },
  pairingLoadingText: {
    color: '#888',
    fontSize: 14,
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
