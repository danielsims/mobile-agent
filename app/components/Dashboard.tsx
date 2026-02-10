import React, { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  Alert,
  Keyboard,
  Platform,
} from 'react-native';
import Svg, { Path } from 'react-native-svg';
import * as Haptics from 'expo-haptics';
import { useAgentState } from '../state/AgentContext';
import { useSettings } from '../state/SettingsContext';
import type { AgentState, Project } from '../state/types';
import type { ConnectionStatus } from '../types';
import { AgentCard } from './AgentCard';

function GearIcon({ size = 18, color = '#888' }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M12 15a3 3 0 100-6 3 3 0 000 6z"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-1.415 3.417 2 2 0 01-1.415-.587l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
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

// Threshold: 1-3 agents use single column, 4+ use 2-column grid
const GRID_THRESHOLD = 4;

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
  const inlineInputRef = useRef<TextInput>(null);

  const agents = useMemo(() =>
    Array.from(state.agents.values()).sort((a, b) => a.createdAt - b.createdAt),
    [state.agents],
  );

  const useGrid = agents.length >= GRID_THRESHOLD;

  const chatAgent = chatAgentId ? state.agents.get(chatAgentId) : null;

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
    // Focus after a short delay for layout
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

  const isConnected = connectionStatus === 'connected';
  const canSend = chatText.trim().length > 0 && connectionStatus === 'connected';

  const header = (
    <View style={styles.header}>
      <Text style={styles.title}>Agents</Text>
      <View style={styles.headerRight}>
        <TouchableOpacity style={styles.newAgentBtn} onPress={onCreateAgent} activeOpacity={0.7}>
          <Text style={styles.newAgentBtnText}>+</Text>
        </TouchableOpacity>
        <View style={styles.statusPill}>
          <View style={[styles.statusDot, isConnected ? styles.dotGreen : styles.dotRed]} />
          <Text style={styles.statusText}>
            {connectionStatus === 'connected' ? 'Connected' :
             connectionStatus === 'connecting' ? 'Connecting' : 'Offline'}
          </Text>
        </View>
        <TouchableOpacity onPress={onOpenSettings} style={styles.settingsBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <GearIcon />
        </TouchableOpacity>
      </View>
    </View>
  );

  // Absolutely-positioned inline input overlay
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

  // --- Grid layout (4+ agents) ---
  if (useGrid) {
    const renderItem = ({ item }: { item: AgentState }) => (
      <AgentCard
        agent={item}
        projects={projects}
        layout="grid"
        onPress={() => onSelectAgent(item.id)}
        onLongPress={() => handleLongPress(item)}
        onChat={() => handleChatOpen(item.id)}
      />
    );

    return (
      <View style={styles.container}>
        {header}
        <FlatList
          data={agents}
          renderItem={renderItem}
          keyExtractor={(item) => item.id}
          numColumns={2}
          contentContainerStyle={styles.gridContent}
          columnWrapperStyle={styles.gridRow}
          showsVerticalScrollIndicator={false}
        />
        {inlineInput}
      </View>
    );
  }

  // --- Single column layout (0-3 agents) ---
  return (
    <View style={styles.container}>
      {header}
      {agents.length === 0 ? (
        <View style={styles.emptyState}>
          <Text style={styles.emptyTitle}>No agents running</Text>
          <Text style={styles.emptySubtitle}>Create an agent to get started</Text>
        </View>
      ) : (
        <View style={styles.singleColumnContent}>
          {agents.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              projects={projects}
              layout="full"
              onPress={() => onSelectAgent(agent.id)}
              onLongPress={() => handleLongPress(agent)}
              onDestroy={() => onDestroyAgent(agent.id)}
              onChat={() => handleChatOpen(agent.id)}
            />
          ))}
        </View>
      )}
      {inlineInput}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
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
  title: {
    color: '#fafafa',
    fontSize: 28,
    fontWeight: '700',
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  newAgentBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: '#1a1a1a',
    alignItems: 'center',
    justifyContent: 'center',
  },
  newAgentBtnText: {
    color: '#888',
    fontSize: 20,
    fontWeight: '300',
    marginTop: -1,
  },
  settingsBtn: {
    padding: 4,
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
  // Grid layout
  gridContent: {
    padding: 8,
    paddingBottom: 40,
  },
  gridRow: {
    justifyContent: 'flex-start',
  },
  // Single column layout
  singleColumnContent: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 34,
    gap: 8,
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
  // Inline input overlay — absolutely positioned above keyboard
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
