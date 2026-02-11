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

// --- User avatar with status badge ---

const AVATAR_SIZE = 32;
const BADGE_SIZE = 10;

function UserAvatar({ connected, onPress }: { connected: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.7} style={pillStyles.avatarWrap}>
      <View style={pillStyles.avatar}>
        <Svg width={16} height={16} viewBox="0 0 24 24" fill="none">
          <Circle cx={12} cy={8} r={4} stroke="#fff" strokeWidth={1.8} />
          <Path d="M4 20c0-3.3 3.6-6 8-6s8 2.7 8 6" stroke="#fff" strokeWidth={1.8} strokeLinecap="round" />
        </Svg>
      </View>
      <View style={[pillStyles.badge, connected ? pillStyles.badgeGreen : pillStyles.badgeRed]} />
    </TouchableOpacity>
  );
}

interface DashboardProps {
  connectionStatus: ConnectionStatus;
  projects: Project[];
  onSelectAgent: (agentId: string) => void;
  onCreateAgent: () => void;
  onDestroyAgent: (agentId: string) => void;
  onSendMessage: (agentId: string, text: string) => void;
  onOpenSettings: () => void;
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
}

function BottomPillNav({ currentPage, totalPages, connectionStatus, onOpenSettings, onCreateAgent }: BottomPillNavProps) {
  const isConnected = connectionStatus === 'connected';

  return (
    <View style={pillStyles.wrapper}>
      <View style={pillStyles.pill}>
        <UserAvatar connected={isConnected} onPress={onOpenSettings} />

        {totalPages > 1 && (
          <View style={pillStyles.dotsRow}>
            {Array.from({ length: totalPages }, (_, i) => (
              <View
                key={i}
                style={[pillStyles.dot, i === currentPage && pillStyles.dotActive]}
              />
            ))}
          </View>
        )}

        <TouchableOpacity onPress={onCreateAgent} style={pillStyles.addBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Text style={pillStyles.addText}>+</Text>
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
}: DashboardProps) {
  const { state } = useAgentState();
  const { settings } = useSettings();
  const [chatAgentId, setChatAgentId] = useState<string | null>(null);
  const [chatText, setChatText] = useState('');
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [currentPage, setCurrentPage] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);
  const [pageRestored, setPageRestored] = useState(false);
  const inlineInputRef = useRef<TextInput>(null);
  const scrollViewRef = useRef<ScrollView>(null);
  const prevAgentCount = useRef(0);

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

  // Auto-scroll to last page when a new agent is created
  useEffect(() => {
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
    setChatAgentId(agentId);
    setChatText('');
    setTimeout(() => inlineInputRef.current?.focus(), 100);
  }, []);

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

  const canSend = chatText.trim().length > 0 && connectionStatus === 'connected';

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
      />

      {inlineInput}
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
    paddingTop: 10,
    paddingBottom: 4,
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
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  inlineInput: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    color: '#fafafa',
    fontSize: 15,
    minHeight: 40,
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
});

const pillStyles = StyleSheet.create({
  wrapper: {
    alignItems: 'center',
    paddingBottom: 34,
    paddingTop: 8,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#ffffff',
    borderRadius: 100,
    paddingLeft: 4,
    paddingRight: 6,
    paddingVertical: 4,
    gap: 12,
  },
  avatarWrap: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    position: 'relative',
  },
  avatar: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
    backgroundColor: '#6b7280',
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    position: 'absolute',
    top: -1,
    right: -1,
    width: BADGE_SIZE,
    height: BADGE_SIZE,
    borderRadius: BADGE_SIZE / 2,
    borderWidth: 2,
    borderColor: '#ffffff',
  },
  badgeGreen: {
    backgroundColor: '#22c55e',
  },
  badgeRed: {
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
    backgroundColor: '#d1d5db',
  },
  dotActive: {
    backgroundColor: '#374151',
  },
  addBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#f3f4f6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  addText: {
    color: '#374151',
    fontSize: 18,
    fontWeight: '400',
    marginTop: -1,
  },
});
