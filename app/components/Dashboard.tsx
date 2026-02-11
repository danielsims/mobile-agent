import React, { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Alert,
  Keyboard,
  Platform,
  Dimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import Svg, { Path, Circle } from 'react-native-svg';
import * as Haptics from 'expo-haptics';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAgentState } from '../state/AgentContext';
import { useSettings } from '../state/SettingsContext';
import type { AgentState, Project } from '../state/types';
import type { ConnectionStatus } from '../types';
import { AgentCard } from './AgentCard';
import { useSpeechRecognition } from '../hooks/useSpeechRecognition';

interface DashboardProps {
  connectionStatus: ConnectionStatus;
  projects: Project[];
  onSelectAgent: (agentId: string) => void;
  onCreateAgent: () => void;
  onDestroyAgent: (agentId: string) => void;
  onSendMessage: (agentId: string, text: string) => void;
  onOpenSettings: () => void;
  onOpenGit?: () => void;
}

const AGENTS_PER_PAGE = 3;
const SCREEN_WIDTH = Dimensions.get('window').width;
const PAGE_STORAGE_KEY = 'dashboard_current_page';

// --- Bottom pill navigation ---

interface BottomPillNavProps {
  currentPage: number;
  totalPages: number;
  connectionStatus: ConnectionStatus;
  onOpenSettings: () => void;
  onCreateAgent: () => void;
  onOpenGit?: () => void;
}

function BottomPillNav({ currentPage, totalPages, connectionStatus, onOpenSettings, onCreateAgent, onOpenGit }: BottomPillNavProps) {
  const isConnected = connectionStatus === 'connected';
  const hasGit = !!onOpenGit;

  const dots = totalPages > 1 ? (
    <View style={pillStyles.dotsRow}>
      {Array.from({ length: totalPages }, (_, i) => (
        <View key={i} style={[pillStyles.dot, i === currentPage && pillStyles.dotActive]} />
      ))}
    </View>
  ) : null;

  return (
    <View style={pillStyles.wrapper}>
      {dots && <View style={pillStyles.dotsAbove}>{dots}</View>}
      <View style={pillStyles.pill}>
        {hasGit && (
          <>
            <TouchableOpacity onPress={() => {
              if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              if (onOpenGit) onOpenGit();
            }} style={pillStyles.sideSection} activeOpacity={0.7}>
              <Svg width={16} height={16} viewBox="0 0 24 24" fill="none">
                <Path d="M6 3v12M18 9a3 3 0 100-6 3 3 0 000 6zM6 21a3 3 0 100-6 3 3 0 000 6zM18 9a9 9 0 01-9 9"
                  stroke="#999" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
              </Svg>
              <Text style={pillStyles.sectionLabel}>Git</Text>
            </TouchableOpacity>
            <View style={pillStyles.divider} />
          </>
        )}
        <TouchableOpacity onPress={() => {
          if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          onCreateAgent();
        }} style={pillStyles.centerSection} activeOpacity={0.7}>
          <Text style={pillStyles.addIcon}>+</Text>
          <Text style={pillStyles.sectionLabel}>New Agent</Text>
        </TouchableOpacity>
        {hasGit && <View style={pillStyles.divider} />}
        <TouchableOpacity onPress={onOpenSettings} style={pillStyles.sideSection} activeOpacity={0.7}>
          <View style={pillStyles.iconWrap}>
            <Svg width={16} height={16} viewBox="0 0 24 24" fill="none">
              <Circle cx={12} cy={8} r={4} stroke="#999" strokeWidth={2} />
              <Path d="M4 20c0-3.3 3.6-6 8-6s8 2.7 8 6" stroke="#999" strokeWidth={2} strokeLinecap="round" />
            </Svg>
            <View style={[pillStyles.statusDot, isConnected ? pillStyles.statusGreen : pillStyles.statusRed]} />
          </View>
          <Text style={pillStyles.sectionLabel}>Settings</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// --- Dashboard ---

export function Dashboard({
  connectionStatus,
  projects,
  onSelectAgent,
  onCreateAgent,
  onDestroyAgent,
  onSendMessage,
  onOpenSettings,
  onOpenGit,
}: DashboardProps) {
  const { state } = useAgentState();
  const { settings } = useSettings();
  const [chatAgentId, setChatAgentId] = useState<string | null>(null);
  const [chatText, setChatText] = useState('');
  const [voiceAgentId, setVoiceAgentId] = useState<string | null>(null);
  const [voiceText, setVoiceText] = useState('');
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [currentPage, setCurrentPage] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);
  const [pageRestored, setPageRestored] = useState(false);
  const inlineInputRef = useRef<TextInput>(null);
  const scrollViewRef = useRef<ScrollView>(null);
  const prevAgentCount = useRef(-1); // -1 = not yet initialized

  const agents = useMemo(() =>
    Array.from(state.agents.values()).sort((a, b) => a.createdAt - b.createdAt),
    [state.agents],
  );

  const pages = useMemo(() => {
    const result: AgentState[][] = [];
    for (let i = 0; i < agents.length; i += AGENTS_PER_PAGE) {
      result.push(agents.slice(i, i + AGENTS_PER_PAGE));
    }
    return result;
  }, [agents]);

  const totalPages = Math.max(pages.length, 1);

  const chatAgent = chatAgentId ? state.agents.get(chatAgentId) : null;
  const voiceAgent = voiceAgentId ? state.agents.get(voiceAgentId) : null;

  const {
    transcript,
    isListening,
    start: startListening,
    stop: stopListening,
    abort: abortListening,
    clear: clearTranscript,
  } = useSpeechRecognition();

  // Sync speech recognition transcript into editable text
  useEffect(() => {
    if (transcript) {
      setVoiceText(transcript);
    }
  }, [transcript]);

  // Restore saved page on mount
  useEffect(() => {
    AsyncStorage.getItem(PAGE_STORAGE_KEY).then((raw) => {
      if (raw != null) {
        const saved = parseInt(raw, 10);
        if (!isNaN(saved) && saved > 0) {
          setCurrentPage(saved);
          setTimeout(() => {
            scrollViewRef.current?.scrollTo({ x: saved * SCREEN_WIDTH, animated: false });
          }, 50);
        }
      }
      setPageRestored(true);
    });
  }, []);

  // Persist page on change (skip until initial restore completes)
  useEffect(() => {
    if (pageRestored) {
      AsyncStorage.setItem(PAGE_STORAGE_KEY, String(currentPage));
    }
  }, [currentPage, pageRestored]);

  // Clamp current page when agents are removed
  useEffect(() => {
    if (currentPage >= totalPages) {
      const newPage = Math.max(0, totalPages - 1);
      setCurrentPage(newPage);
      scrollViewRef.current?.scrollTo({ x: newPage * SCREEN_WIDTH, animated: true });
    }
  }, [totalPages, currentPage]);

  // Auto-scroll to last page when a new agent is created (not on initial load)
  useEffect(() => {
    if (prevAgentCount.current === -1) {
      // First load — just record the count, don't scroll
      prevAgentCount.current = agents.length;
      return;
    }
    if (agents.length > prevAgentCount.current && pages.length > 0) {
      const lastPage = pages.length - 1;
      setTimeout(() => {
        scrollViewRef.current?.scrollTo({ x: lastPage * SCREEN_WIDTH, animated: true });
        setCurrentPage(lastPage);
      }, 100);
    }
    prevAgentCount.current = agents.length;
  }, [agents.length, pages.length]);

  // Track keyboard height for positioning the inline input
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const showSub = Keyboard.addListener(showEvent, (e) => {
      setKeyboardHeight(e.endCoordinates.height);
    });
    const hideSub = Keyboard.addListener(hideEvent, () => {
      setKeyboardHeight(0);
    });

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  const handlePageScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const offsetX = event.nativeEvent.contentOffset.x;
    const page = Math.round(offsetX / SCREEN_WIDTH);
    if (page !== currentPage) {
      if (Platform.OS === 'ios') {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      }
      setCurrentPage(page);
    }
  }, [currentPage]);

  const handleLongPress = (agent: AgentState) => {
    if (Platform.OS === 'ios') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    }
    Alert.alert(
      'Destroy Agent',
      `End "${agent.sessionName}"? This will terminate the agent process.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Destroy',
          style: 'destructive',
          onPress: () => onDestroyAgent(agent.id),
        },
      ],
    );
  };

  const handleChatOpen = useCallback((agentId: string) => {
    // Close voice overlay if open
    if (voiceAgentId) {
      abortListening();
      setVoiceAgentId(null);
    }
    setChatAgentId(agentId);
    setChatText('');
    setTimeout(() => inlineInputRef.current?.focus(), 100);
  }, [voiceAgentId, abortListening]);

  const handleChatSend = useCallback(() => {
    const trimmed = chatText.trim();
    if (!trimmed || !chatAgentId) return;

    if (Platform.OS === 'ios') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }

    onSendMessage(chatAgentId, trimmed);
    setChatAgentId(null);
    setChatText('');
    Keyboard.dismiss();
  }, [chatAgentId, chatText, onSendMessage]);

  const handleChatDismiss = useCallback(() => {
    setChatAgentId(null);
    setChatText('');
    Keyboard.dismiss();
  }, []);

  // --- Voice handlers ---

  const handleVoiceOpen = useCallback(async (agentId: string) => {
    // Close keyboard chat if open
    if (chatAgentId) {
      setChatAgentId(null);
      setChatText('');
      Keyboard.dismiss();
    }

    setVoiceAgentId(agentId);
    setVoiceText('');
    clearTranscript();

    const started = await startListening();
    if (!started) {
      setVoiceAgentId(null);
      Alert.alert('Speech Recognition', 'Could not start speech recognition. Check permissions in Settings.');
    }
  }, [chatAgentId, clearTranscript, startListening]);

  const handleVoiceSend = useCallback(() => {
    const trimmed = voiceText.trim();
    if (!trimmed || !voiceAgentId) return;

    if (Platform.OS === 'ios') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }

    stopListening();
    onSendMessage(voiceAgentId, trimmed);
    setVoiceAgentId(null);
    setVoiceText('');
    clearTranscript();
  }, [voiceAgentId, voiceText, onSendMessage, stopListening, clearTranscript]);

  const handleVoiceDismiss = useCallback(() => {
    abortListening();
    setVoiceAgentId(null);
    setVoiceText('');
    clearTranscript();
  }, [abortListening, clearTranscript]);

  const canSend = chatText.trim().length > 0 && connectionStatus === 'connected';
  const canSendVoice = voiceText.trim().length > 0 && connectionStatus === 'connected';

  // Inline chat overlay
  const inlineInput = chatAgentId && chatAgent ? (
    <View style={[styles.inlineOverlay, { bottom: keyboardHeight - 40 }]}>
      <View style={styles.inlineContainer}>
        <View style={styles.inlineHeader}>
          <Text style={styles.inlineLabel} numberOfLines={1}>
            Send to: {chatAgent.projectName ? (
              <>
                <Text style={settings.colorfulGitLabels ? styles.inlineProjectName : undefined}>{chatAgent.projectName}</Text>
                {chatAgent.gitBranch ? <Text style={settings.colorfulGitLabels ? styles.inlineGit : undefined}> git:(<Text style={settings.colorfulGitLabels ? styles.inlineBranchName : undefined}>{chatAgent.gitBranch}</Text>)</Text> : null}
              </>
            ) : chatAgent.sessionName}
          </Text>
          <TouchableOpacity
            onPress={handleChatDismiss}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={styles.inlineDismiss}>Cancel</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.inlineRow}>
          <View style={styles.inlineInputWrapper}>
            <TextInput
              ref={inlineInputRef}
              style={styles.inlineInput}
              value={chatText}
              onChangeText={setChatText}
              placeholder="Type a message..."
              placeholderTextColor="#555"
              onSubmitEditing={handleChatSend}
              returnKeyType="send"
              autoCorrect={false}
              spellCheck={false}
              autoComplete="off"
              keyboardAppearance="dark"
            />
          </View>
          <TouchableOpacity
            style={[styles.inlineSendBtn, canSend && styles.inlineSendBtnActive]}
            onPress={handleChatSend}
            disabled={!canSend}
            activeOpacity={0.7}
          >
            <View style={styles.inlineSendIcon}>
              <View style={[styles.arrowStem, { backgroundColor: canSend ? '#000' : '#555' }]} />
              <View style={[styles.arrowHead, { borderBottomColor: canSend ? '#000' : '#555' }]} />
            </View>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  ) : null;

  // Voice input overlay
  const voiceOverlay = voiceAgentId && voiceAgent ? (
    <View style={[styles.voiceOverlay, keyboardHeight > 0 && { bottom: keyboardHeight - 40 }]}>
      <View style={styles.inlineContainer}>
        <View style={styles.inlineHeader}>
          <Text style={styles.inlineLabel} numberOfLines={1}>
            Send to: {voiceAgent.projectName ? (
              <>
                <Text style={settings.colorfulGitLabels ? styles.inlineProjectName : undefined}>{voiceAgent.projectName}</Text>
                {voiceAgent.gitBranch ? <Text style={settings.colorfulGitLabels ? styles.inlineGit : undefined}> git:(<Text style={settings.colorfulGitLabels ? styles.inlineBranchName : undefined}>{voiceAgent.gitBranch}</Text>)</Text> : null}
              </>
            ) : voiceAgent.sessionName}
          </Text>
          <TouchableOpacity
            onPress={handleVoiceDismiss}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={styles.inlineDismiss}>Cancel</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.voiceTranscriptArea}>
          <TextInput
            style={styles.voiceTranscriptInput}
            value={voiceText}
            onChangeText={setVoiceText}
            placeholder={isListening ? 'Listening...' : 'Starting...'}
            placeholderTextColor="#555"
            multiline
            autoCorrect={false}
            spellCheck={false}
            keyboardAppearance="dark"
          />
        </View>

        <View style={styles.voiceBottomRow}>
          <View style={styles.voiceListeningIndicator}>
            <View style={[
              styles.voiceListeningDot,
              isListening && styles.voiceListeningDotActive,
            ]} />
            <Text style={styles.voiceListeningText}>
              {isListening ? 'Listening' : 'Stopped'}
            </Text>
          </View>
          <TouchableOpacity
            style={[styles.inlineSendBtn, canSendVoice && styles.inlineSendBtnActive]}
            onPress={handleVoiceSend}
            disabled={!canSendVoice}
            activeOpacity={0.7}
          >
            <View style={styles.inlineSendIcon}>
              <View style={[styles.arrowStem, { backgroundColor: canSendVoice ? '#000' : '#555' }]} />
              <View style={[styles.arrowHead, { borderBottomColor: canSendVoice ? '#000' : '#555' }]} />
            </View>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  ) : null;

  return (
    <View style={styles.container}>
      {agents.length === 0 ? (
        <View style={styles.emptyState}>
          <Text style={styles.emptyTitle}>No agents running</Text>
          <Text style={styles.emptySubtitle}>Create an agent to get started</Text>
        </View>
      ) : (
        <View style={styles.cardArea} onLayout={(e) => setContentHeight(e.nativeEvent.layout.height)}>
          <ScrollView
            ref={scrollViewRef}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            onMomentumScrollEnd={handlePageScroll}
            scrollEventThrottle={16}
          >
            {pages.map((pageAgents, pageIndex) => (
              <View key={pageIndex} style={{ width: SCREEN_WIDTH, height: contentHeight, paddingHorizontal: 16, paddingTop: 8 }}>
                {pageAgents.map((agent) => (
                  <AgentCard
                    key={agent.id}
                    agent={agent}
                    projects={projects}
                    layout="page"
                    onPress={() => onSelectAgent(agent.id)}
                    onLongPress={() => handleLongPress(agent)}
                    onDestroy={() => onDestroyAgent(agent.id)}
                    onChat={() => handleChatOpen(agent.id)}
                    onVoice={() => handleVoiceOpen(agent.id)}
                  />
                ))}
              </View>
            ))}
          </ScrollView>
        </View>
      )}

      <BottomPillNav
        currentPage={currentPage}
        totalPages={totalPages}
        connectionStatus={connectionStatus}
        onOpenSettings={onOpenSettings}
        onCreateAgent={onCreateAgent}
        onOpenGit={onOpenGit}
      />

      {inlineInput}
      {voiceOverlay}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0a0a0a',
  },
  cardArea: {
    flex: 1,
  },
  // Empty state
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyTitle: {
    color: '#555',
    fontSize: 16,
    fontWeight: '500',
    marginBottom: 4,
  },
  emptySubtitle: {
    color: '#3a3a3a',
    fontSize: 13,
  },
  // Inline input overlay
  inlineOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingBottom: 40,
    backgroundColor: '#0a0a0a',
  },
  inlineContainer: {
    backgroundColor: '#0a0a0a',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.1)',
  },
  inlineHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  inlineLabel: {
    color: '#777',
    fontSize: 12,
    fontWeight: '500',
    flex: 1,
  },
  inlineProjectName: {
    color: '#17c6b2',
    fontWeight: '500',
  },
  inlineGit: {
    color: '#5fa2f9',
    fontWeight: '500',
  },
  inlineBranchName: {
    color: '#ec605f',
    fontWeight: '500',
  },
  inlineDismiss: {
    color: '#555',
    fontSize: 12,
    fontWeight: '500',
  },
  inlineRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 12,
    paddingTop: 4,
    paddingBottom: 8,
    gap: 10,
  },
  inlineInputWrapper: {
    flex: 1,
  },
  inlineInput: {
    paddingHorizontal: 4,
    paddingVertical: 12,
    color: '#fafafa',
    fontSize: 16,
    minHeight: 44,
  },
  inlineSendBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  inlineSendBtnActive: {
    backgroundColor: '#fff',
  },
  inlineSendIcon: {
    width: 16,
    height: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  arrowStem: {
    width: 2,
    height: 9,
    borderRadius: 1,
    marginTop: 4,
  },
  arrowHead: {
    position: 'absolute',
    top: 0,
    width: 0,
    height: 0,
    borderLeftWidth: 4.5,
    borderRightWidth: 4.5,
    borderBottomWidth: 5.5,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
  },
  // Voice overlay
  voiceOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingBottom: 40,
    backgroundColor: '#0a0a0a',
  },
  voiceTranscriptArea: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    minHeight: 60,
  },
  voiceTranscriptInput: {
    color: '#fafafa',
    fontSize: 15,
    lineHeight: 22,
    minHeight: 40,
    maxHeight: 120,
    padding: 0,
  },
  voiceBottomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  voiceListeningIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  voiceListeningDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#4b5563',
  },
  voiceListeningDotActive: {
    backgroundColor: '#ef4444',
  },
  voiceListeningText: {
    color: '#777',
    fontSize: 12,
    fontWeight: '500',
  },
});

const pillStyles = StyleSheet.create({
  wrapper: {
    alignItems: 'center',
    paddingBottom: 30,
    paddingTop: 12,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1c1c1e',
    borderRadius: 16,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  sideSection: {
    width: 56,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    gap: 3,
  },
  centerSection: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingVertical: 10,
    gap: 3,
  },
  sectionLabel: {
    color: '#666',
    fontSize: 10,
    fontWeight: '600',
  },
  divider: {
    width: StyleSheet.hairlineWidth,
    height: 28,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  addIcon: {
    color: '#999',
    fontSize: 18,
    fontWeight: '300',
    lineHeight: 18,
  },
  iconWrap: {
    position: 'relative',
  },
  statusDot: {
    position: 'absolute',
    top: -2,
    right: -4,
    width: 8,
    height: 8,
    borderRadius: 4,
    borderWidth: 2,
    borderColor: '#1c1c1e',
  },
  statusGreen: {
    backgroundColor: '#22c55e',
  },
  statusRed: {
    backgroundColor: '#ef4444',
  },
  dotsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#555',
  },
  dotActive: {
    backgroundColor: '#fff',
  },
  dotsAbove: {
    marginBottom: 8,
  },
});
