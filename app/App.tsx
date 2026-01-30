import { StatusBar } from 'expo-status-bar';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Linking from 'expo-linking';
import { CameraView, useCameraPermissions } from 'expo-camera';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  StyleSheet,
  Text,
  View,
  ScrollView,
  TouchableOpacity,
  SafeAreaView,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';

import { Message, PermissionRequest, Session, ConnectionStatus, PermissionMode } from './types';
import {
  Settings,
  InputBar,
  KeyboardScrollView,
  MessageBubble,
  PermissionPrompt,
  SessionList,
} from './components';
import { useWebSocket } from './hooks/useWebSocket';

type Screen = 'settings' | 'scanner' | 'chat' | 'sessions';

export default function App() {
  // Connection state
  const [serverUrl, setServerUrl] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [screen, setScreen] = useState<Screen>('settings');
  const [scanned, setScanned] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();

  // Chat state
  const [messages, setMessages] = useState<Message[]>([]);
  const [sessionName, setSessionName] = useState('New Chat');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('confirm');
  const [draftText, setDraftText] = useState('');

  const pendingConnectRef = useRef<{ url: string; token: string } | null>(null);
  const messageIdRef = useRef(0);
  const permissionSentRef = useRef(false);  // Prevent double-sending permission responses
  const draftSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Throttle streaming updates to prevent UI freeze
  const pendingContentRef = useRef('');
  const flushTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Message handling
  const addMessage = useCallback((type: Message['type'], content: string, extra?: Partial<Message>) => {
    const msg: Message = {
      id: String(messageIdRef.current++),
      type,
      content,
      timestamp: Date.now(),
      ...extra,
    };
    setMessages(prev => [...prev, msg]);
  }, []);

  // Flush pending content to messages (throttled)
  const flushPendingContent = useCallback(() => {
    if (pendingContentRef.current) {
      const content = pendingContentRef.current;
      pendingContentRef.current = '';
      setMessages(prev => {
        const last = prev[prev.length - 1];
        if (last && last.type === 'assistant') {
          return [...prev.slice(0, -1), { ...last, content: last.content + content }];
        }
        return [...prev, {
          id: String(messageIdRef.current++),
          type: 'assistant' as const,
          content,
          timestamp: Date.now(),
        }];
      });
    }
  }, []);

  const appendToLastAssistant = useCallback((content: string) => {
    // Batch content and flush every 50ms to prevent UI freeze
    pendingContentRef.current += content;
    if (!flushTimeoutRef.current) {
      flushTimeoutRef.current = setTimeout(() => {
        flushTimeoutRef.current = null;
        flushPendingContent();
      }, 50);
    }
  }, [flushPendingContent]);

  // WebSocket
  const { status, connect, send, disconnect, reconnect, resetPingTimer } = useWebSocket({
    onMessage: (msg) => {
      switch (msg.type) {
        case 'connected':
          if (msg.sessionId) {
            setSessionId(msg.sessionId);
            // Clear messages - history will be sent separately with proper types
            setMessages([]);
          }
          if (msg.sessionName) setSessionName(msg.sessionName);
          if (msg.permissionMode) setPermissionMode(msg.permissionMode);
          break;

        case 'session':
          if (msg.sessionId) setSessionId(msg.sessionId);
          if (msg.name) setSessionName(msg.name);
          break;

        case 'history':
          // Load message history with proper types
          if (msg.messages && Array.isArray(msg.messages)) {
            console.log(`Received ${msg.messages.length} history messages`);
            const loadedMessages: Message[] = msg.messages.map((m: any, i: number) => {
              console.log(`History message ${i}: type=${m.type}, content=${(m.content || '').slice(0, 50)}`);
              return {
                id: `history-${i}`,
                type: m.type as Message['type'],
                content: m.content || '',
                toolName: m.toolName,
                toolInput: m.toolInput,
                timestamp: Date.now() - (msg.messages.length - i) * 1000,
              };
            });
            setMessages(loadedMessages);
          }
          break;

        case 'userMessage':
          if (msg.content) {
            addMessage('user', msg.content);
          }
          break;

        case 'output':
          if (msg.data) {
            appendToLastAssistant(msg.data);
          }
          break;

        case 'buffer':
          if (msg.data) {
            appendToLastAssistant(msg.data);
          }
          break;

        case 'tool':
          addMessage('tool', '', {
            toolName: msg.name,
            toolInput: msg.input,
          });
          break;

        case 'toolResult':
          if (msg.content) {
            setMessages(prev => {
              const last = prev[prev.length - 1];
              if (last && last.type === 'tool') {
                return [...prev.slice(0, -1), { ...last, content: msg.content }];
              }
              return prev;
            });
          }
          break;

        case 'permission':
          // Only show if it's a new permission (different ID)
          const newPermId = msg.id || '';
          setPendingPermission(prev => {
            if (prev && prev.id === newPermId) {
              // Same permission, ignore duplicate
              return prev;
            }
            permissionSentRef.current = false;  // Reset for new permission request
            return {
              id: newPermId,
              toolName: msg.toolName || 'Permission Required',
              description: msg.description || '',
              timestamp: Date.now(),
            };
          });
          break;

        case 'done':
          // Message complete - flush any pending content and reset state
          if (flushTimeoutRef.current) {
            clearTimeout(flushTimeoutRef.current);
            flushTimeoutRef.current = null;
          }
          flushPendingContent();
          // In auto mode, always clear permission state
          // In confirm mode, only clear if we already responded
          if (permissionMode === 'auto' || permissionSentRef.current) {
            setPendingPermission(null);
          }
          permissionSentRef.current = false;
          break;

        case 'sessions':
          setSessions(msg.sessions || []);
          setLoadingSessions(false);
          break;

        case 'reset':
          setMessages([]);
          setSessionId(null);
          setSessionName('New Chat');
          permissionSentRef.current = false;
          break;

        case 'permissionMode':
          if (msg.mode) setPermissionMode(msg.mode);
          break;
      }
    },
    onConnect: () => {
      setScreen('chat');
      saveSettings();
    },
    onDisconnect: (code) => {
      if (code === 4001) {
        addMessage('system', 'Authentication failed');
      }
    },
  });

  // Load/save settings
  useEffect(() => {
    if (pendingConnectRef.current) return;
    AsyncStorage.getItem('serverUrl').then(v => v && setServerUrl(v));
    AsyncStorage.getItem('authToken').then(v => v && setAuthToken(v));
  }, []);

  const saveSettings = async () => {
    await AsyncStorage.setItem('serverUrl', serverUrl);
    await AsyncStorage.setItem('authToken', authToken);
  };

  // Draft persistence - keyed by session
  const getDraftKey = (sid: string | null) => `draft:${sid || 'new'}`;

  // Load draft when session changes
  useEffect(() => {
    const loadDraft = async () => {
      const key = getDraftKey(sessionId);
      const saved = await AsyncStorage.getItem(key);
      if (saved) {
        setDraftText(saved);
      } else {
        setDraftText('');
      }
    };
    loadDraft();
  }, [sessionId]);

  // Save draft with debounce
  const handleDraftChange = useCallback((text: string) => {
    setDraftText(text);

    // Debounce saving to storage
    if (draftSaveTimeoutRef.current) {
      clearTimeout(draftSaveTimeoutRef.current);
    }
    draftSaveTimeoutRef.current = setTimeout(() => {
      const key = getDraftKey(sessionId);
      if (text) {
        AsyncStorage.setItem(key, text);
      } else {
        AsyncStorage.removeItem(key);
      }
    }, 500);
  }, [sessionId]);

  // Clear draft after sending
  const clearDraft = useCallback(() => {
    setDraftText('');
    const key = getDraftKey(sessionId);
    AsyncStorage.removeItem(key);
  }, [sessionId]);

  // Deep linking
  const handleDeepLink = useCallback((url: string) => {
    try {
      const parsed = Linking.parse(url);
      if (parsed.path === 'connect' && parsed.queryParams) {
        const u = parsed.queryParams.url as string;
        const t = parsed.queryParams.token as string;
        if (u && t) {
          setServerUrl(u);
          setAuthToken(t);
          pendingConnectRef.current = { url: u, token: t };
        }
      }
    } catch (e) {}
  }, []);

  useEffect(() => {
    Linking.getInitialURL().then(url => url && handleDeepLink(url));
    const sub = Linking.addEventListener('url', e => handleDeepLink(e.url));
    return () => sub.remove();
  }, [handleDeepLink]);

  // Auto-connect after QR scan
  useEffect(() => {
    if (pendingConnectRef.current && serverUrl && authToken) {
      const p = pendingConnectRef.current;
      if (p.url === serverUrl && p.token === authToken) {
        pendingConnectRef.current = null;
        setTimeout(() => {
          connect(serverUrl, authToken);
        }, 100);
      }
    }
  }, [serverUrl, authToken, connect]);

  // Handlers
  const handleScan = async () => {
    if (!permission?.granted) {
      const result = await requestPermission();
      if (!result.granted) return;
    }
    setScanned(false);
    setScreen('scanner');
  };

  const handleBarCodeScanned = ({ data }: { data: string }) => {
    if (scanned) return;
    setScanned(true);
    try {
      const parsed = JSON.parse(data);
      if (parsed.url && parsed.token) {
        setServerUrl(parsed.url);
        setAuthToken(parsed.token);
        pendingConnectRef.current = { url: parsed.url, token: parsed.token };
        setScreen('settings');
      }
    } catch (e) {
      setScanned(false);
    }
  };

  const handleSend = (text: string) => {
    // Try to reconnect if disconnected
    if (status === 'disconnected') {
      reconnect();
      return;
    }
    send('input', { text });
    clearDraft();
  };

  const handlePermissionResponse = (action: 'yes' | 'no') => {
    if (permissionSentRef.current) {
      console.log('Permission response already sent, ignoring');
      return;
    }
    permissionSentRef.current = true;
    send('permission', { action });
    setPendingPermission(null);
  };

  const handleShowSessions = () => {
    // Try to reconnect if disconnected
    if (status === 'disconnected') {
      reconnect();
      return;
    }
    setLoadingSessions(true);
    send('getSessions', {});
    setScreen('sessions');
  };

  const handleSelectSession = (session: Session) => {
    send('resumeSession', { sessionId: session.id, name: session.name });
    setSessionId(session.id);
    setSessionName(session.name || 'Resumed Chat');
    setMessages([]);
    setScreen('chat');
  };

  const handleNewChat = () => {
    send('reset', {});
    setMessages([]);
    setSessionId(null);
    setSessionName('New Chat');
    setScreen('chat');
  };

  const togglePermissionMode = () => {
    const newMode = permissionMode === 'auto' ? 'confirm' : 'auto';
    send('setPermissionMode', { mode: newMode });
    setPermissionMode(newMode);
  };

  // Scanner screen
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
          <TouchableOpacity style={styles.cancelBtn} onPress={() => setScreen('settings')}>
            <Text style={styles.cancelBtnText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // Settings screen
  if (screen === 'settings') {
    return (
      <SafeAreaView style={styles.container}>
        <StatusBar style="light" />
        <Settings
          serverUrl={serverUrl}
          authToken={authToken}
          status={status}
          onServerUrlChange={setServerUrl}
          onAuthTokenChange={setAuthToken}
          onConnect={() => connect(serverUrl, authToken)}
          onScan={handleScan}
          onBack={status === 'connected' ? () => setScreen('chat') : undefined}
        />
      </SafeAreaView>
    );
  }

  // Sessions screen
  if (screen === 'sessions') {
    return (
      <SafeAreaView style={styles.container}>
        <StatusBar style="light" />
        <SessionList
          sessions={sessions}
          loading={loadingSessions}
          onSelect={handleSelectSession}
          onNewChat={handleNewChat}
          onBack={() => setScreen('chat')}
        />
      </SafeAreaView>
    );
  }

  // Chat screen
  return (
    <View style={styles.container}>
      <StatusBar style="light" />
      <SafeAreaView style={styles.safeTop}>
        <View style={styles.header}>
          <TouchableOpacity onPress={handleShowSessions} style={styles.headerLeft}>
            <Text style={styles.sessionName} numberOfLines={1}>
              {sessionName}
            </Text>
            <View style={styles.chevronIcon}>
              <View style={styles.chevronLine1} />
              <View style={styles.chevronLine2} />
            </View>
          </TouchableOpacity>

          <View style={styles.headerRight}>
            <TouchableOpacity onPress={togglePermissionMode} style={styles.modePill}>
              <Text style={styles.modeText}>{permissionMode === 'auto' ? 'Auto' : 'Ask'}</Text>
            </TouchableOpacity>

            <TouchableOpacity onPress={() => setScreen('settings')}>
              <View style={styles.statusPill}>
                <View style={[styles.statusDot, status === 'connected' ? styles.dotGreen : styles.dotRed]} />
                <Text style={styles.statusText}>{status === 'connected' ? 'Connected' : 'Offline'}</Text>
              </View>
            </TouchableOpacity>
          </View>
        </View>
      </SafeAreaView>

      <KeyboardAvoidingView
        style={styles.main}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={0}
      >
        <KeyboardScrollView
          style={styles.chatArea}
          contentContainerStyle={styles.chatContent}
        >
          {messages.length === 0 ? (
            <Text style={styles.placeholder}>Send a message to start chatting...</Text>
          ) : (
            messages.map(msg => (
              <MessageBubble key={msg.id} message={msg} />
            ))
          )}

          {pendingPermission && (
            <PermissionPrompt
              description={pendingPermission.description}
              onApprove={() => handlePermissionResponse('yes')}
              onDeny={() => handlePermissionResponse('no')}
            />
          )}
        </KeyboardScrollView>

        <InputBar
          onSend={handleSend}
          disabled={status !== 'connected' || !!pendingPermission}
          onActivity={resetPingTimer}
          initialValue={draftText}
          onDraftChange={handleDraftChange}
        />
      </KeyboardAvoidingView>
    </View>
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
  // Header
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a1a',
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    marginRight: 12,
  },
  sessionName: {
    color: '#fafafa',
    fontSize: 16,
    fontWeight: '600',
    flex: 1,
  },
  chevronIcon: {
    width: 12,
    height: 8,
    marginLeft: 6,
    justifyContent: 'center',
    alignItems: 'center',
  },
  chevronLine1: {
    position: 'absolute',
    width: 7,
    height: 1.5,
    backgroundColor: '#666',
    borderRadius: 1,
    transform: [{ rotate: '45deg' }, { translateX: -2 }],
  },
  chevronLine2: {
    position: 'absolute',
    width: 7,
    height: 1.5,
    backgroundColor: '#666',
    borderRadius: 1,
    transform: [{ rotate: '-45deg' }, { translateX: 2 }],
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  modePill: {
    backgroundColor: '#1a1a1a',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 12,
  },
  modeText: {
    color: '#888',
    fontSize: 12,
  },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1a1a1a',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 12,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 6,
  },
  dotGreen: {
    backgroundColor: '#22c55e',
  },
  dotRed: {
    backgroundColor: '#ef4444',
  },
  statusText: {
    color: '#888',
    fontSize: 12,
  },
  // Main
  main: {
    flex: 1,
  },
  chatArea: {
    flex: 1,
  },
  chatContent: {
    padding: 16,
    paddingBottom: 16,
  },
  placeholder: {
    color: '#555',
    fontSize: 14,
    textAlign: 'center',
    marginTop: 40,
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
});
