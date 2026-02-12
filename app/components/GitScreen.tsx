import React, { useRef, useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  Image,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  PanResponder,
  Animated,
  Dimensions,
  Platform,
  Keyboard,
  Alert,
  ActivityIndicator,
  RefreshControl,
  type NativeSyntheticEvent,
  type NativeScrollEvent,
} from 'react-native';
import Svg, { Path } from 'react-native-svg';
import * as Haptics from 'expo-haptics';
import { useAgentState } from '../state/AgentContext';
import { useSettings } from '../state/SettingsContext';
import { AgentCard } from './AgentCard';
import { BottomModal } from './BottomModal';
import { FileTypeIcon } from './FileTypeIcon';
import { SourceTabContent } from './SourceTabContent';
import { CommitsTabContent } from './CommitsTabContent';
import { useSpeechRecognition } from '../hooks/useSpeechRecognition';
import type { Project, GitLogCommit, AgentState, AgentType, Skill } from '../state/types';

const SCREEN_WIDTH = Dimensions.get('window').width;
const SWIPE_THRESHOLD = SCREEN_WIDTH * 0.25;
const EDGE_WIDTH = 30;

interface GitFile {
  file: string;
  status: string;
}

interface AgentGitData {
  branch: string;
  ahead: number;
  behind: number;
  files: GitFile[];
}

interface GitScreenProps {
  onBack: () => void;
  onRequestGitStatus: (agentId: string) => void;
  onRequestGitLog: (projectPath: string) => void;
  onSelectAgent: (agentId: string) => void;
  onDestroyAgent?: (agentId: string) => void;
  onSendMessage?: (agentId: string, text: string) => void;
  onCreateAgentForWorktree?: (projectId: string, worktreePath: string, pendingPrompt?: string) => void;
  onRemoveWorktree?: (projectId: string, worktreePath: string) => void;
  onRefresh?: () => void;
  onRequestWorktreeStatus?: (worktreePath: string) => void;
  skills?: Skill[];
  gitDataMap: Map<string, AgentGitData>;
  worktreeGitData?: Map<string, AgentGitData>;
  worktreeGitLoading?: Set<string>;
  gitLogMap: Map<string, GitLogCommit[]>;
  gitLogLoading: Set<string>;
  loadingAgentIds: Set<string>;
  projects: Project[];
}

// VS Code git decoration colors
const STATUS_COLORS: Record<string, string> = {
  M: '#e2c08d',  // Modified
  A: '#73c991',  // Added (staged)
  D: '#c74e39',  // Deleted
  R: '#73c991',  // Renamed
  U: '#73c991',  // Untracked
  C: '#e4676b',  // Conflict / unmerged
};

// Normalize raw status codes (handles legacy ?? and other multi-char codes)
function normalizeStatus(raw: string): string {
  if (raw === '??' || raw === '?') return 'U';
  if (raw === 'UU' || raw === 'AA' || raw === 'DD' || raw === 'AU' || raw === 'UA') return 'C';
  // For two-char codes like 'MM', ' M', 'AM' — take the meaningful single char
  if (raw.length === 2) {
    const y = raw[1];
    if (y !== ' ') return y;
    return raw[0];
  }
  return raw;
}

function getStatusColor(status: string): string {
  const s = normalizeStatus(status);
  return STATUS_COLORS[s] || '#888';
}

function getStatusLetter(status: string): string {
  return normalizeStatus(status);
}

function ProjectIcon({ project, size = 24 }: { project: Project; size?: number }) {
  if (project.icon) {
    return (
      <Image
        source={{ uri: project.icon }}
        style={{ width: size, height: size, borderRadius: size * 0.22 }}
      />
    );
  }
  return (
    <View style={[styles.projectIconFallback, { width: size, height: size, borderRadius: size * 0.22 }]}>
      <Text style={[styles.projectIconLetter, { fontSize: size * 0.48 }]}>
        {project.name.charAt(0).toUpperCase()}
      </Text>
    </View>
  );
}

const CLAUDE_LOGO_PATH = 'M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z';
const OPENAI_LOGO_PATH = 'M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z';

const AGENT_BRAND: Record<string, { color: string; bg: string; letter: string }> = {
  claude:   { color: '#D97757', bg: '#FFFFFF', letter: 'C' },
  codex:    { color: '#111111', bg: '#FFFFFF', letter: 'X' },
  opencode: { color: '#3B82F6', bg: '#FFFFFF', letter: 'O' },
};

function AgentAvatar({ type, size = 20 }: { type: AgentType; size?: number }) {
  const brand = AGENT_BRAND[type] || { color: '#888', bg: 'rgba(136,136,136,0.25)', letter: type[0]?.toUpperCase() || '?' };
  const iconSize = size * 0.55;
  return (
    <View style={[styles.agentAvatar, { width: size, height: size, borderRadius: size / 2, backgroundColor: brand.bg }]}>
      {type === 'claude' ? (
        <Svg width={iconSize} height={iconSize} viewBox="0 0 24 24">
          <Path d={CLAUDE_LOGO_PATH} fill={brand.color} fillRule="nonzero" />
        </Svg>
      ) : type === 'codex' ? (
        <Svg width={iconSize} height={iconSize} viewBox="0 0 24 24">
          <Path d={OPENAI_LOGO_PATH} fill={brand.color} fillRule="evenodd" />
        </Svg>
      ) : (
        <Text style={{ color: brand.color, fontSize: size * 0.45, fontWeight: '700', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }}>
          {brand.letter}
        </Text>
      )}
    </View>
  );
}

function StackedAgentAvatars({ agents, size = 20 }: { agents: AgentState[]; size?: number }) {
  if (agents.length === 0) return null;
  const overlap = size * 0.35;
  const totalWidth = size + (agents.length - 1) * (size - overlap);
  return (
    <View style={{ width: totalWidth, height: size, flexDirection: 'row' }}>
      {agents.map((agent, i) => (
        <View key={agent.id} style={{ position: 'absolute', left: i * (size - overlap), zIndex: agents.length - i }}>
          <AgentAvatar type={agent.type} size={size} />
        </View>
      ))}
    </View>
  );
}

function CommitIcon({ size = 16, color = '#ccc' }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M12 16a4 4 0 100-8 4 4 0 000 8zM12 3v5M12 16v5"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
      />
    </Svg>
  );
}

function TrashIcon({ size = 16, color = '#ef4444' }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

type GitScreenTab = 'diff' | 'source' | 'commits';
const GIT_TABS: GitScreenTab[] = ['diff', 'source', 'commits'];

export function GitScreen({ onBack, onRequestGitStatus, onRequestGitLog, onSelectAgent, onDestroyAgent, onSendMessage, onCreateAgentForWorktree, onRemoveWorktree, onRefresh, onRequestWorktreeStatus, skills = [], gitDataMap, worktreeGitData, worktreeGitLoading, gitLogMap, gitLogLoading, loadingAgentIds, projects }: GitScreenProps) {
  const { state } = useAgentState();
  const { settings } = useSettings();
  const [expandedNewWorktree, setExpandedNewWorktree] = useState<string | null>(null);
  const [newBranchName, setNewBranchName] = useState('');
  const [selectedWorktree, setSelectedWorktree] = useState<{ projectId: string; path: string; branch: string; isMain: boolean } | null>(null);
  const [modalStep, setModalStep] = useState<'actions' | 'pickAgent' | 'confirmRemove'>('actions');
  const [pendingSkillPrompt, setPendingSkillPrompt] = useState<string | null>(null);
  const [removeConfirmText, setRemoveConfirmText] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  // Tab state
  const [activeTab, setActiveTab] = useState<GitScreenTab>('diff');
  const tabScrollRef = useRef<ScrollView>(null);

  // Request git log and worktree status for all projects when screen mounts / projects change
  useEffect(() => {
    for (const project of projects) {
      onRequestGitLog(project.path);
      for (const wt of project.worktrees) {
        onRequestWorktreeStatus?.(wt.path);
      }
    }
  }, [projects, onRequestGitLog, onRequestWorktreeStatus]);

  // Stop refreshing spinner when projects data updates
  useEffect(() => {
    if (refreshing) setRefreshing(false);
  }, [projects]);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    onRefresh?.();
    // Re-request worktree-level git status and logs
    for (const project of projects) {
      for (const wt of project.worktrees) {
        onRequestWorktreeStatus?.(wt.path);
      }
      onRequestGitLog(project.path);
    }
  }, [onRefresh, projects, onRequestWorktreeStatus, onRequestGitLog]);

  // Chat/voice state
  const [chatAgentId, setChatAgentId] = useState<string | null>(null);
  const [chatText, setChatText] = useState('');
  const [voiceAgentId, setVoiceAgentId] = useState<string | null>(null);
  const [voiceText, setVoiceText] = useState('');
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const inlineInputRef = useRef<TextInput>(null);

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

  useEffect(() => {
    if (transcript) setVoiceText(transcript);
  }, [transcript]);

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvent, (e) => setKeyboardHeight(e.endCoordinates.height));
    const hideSub = Keyboard.addListener(hideEvent, () => setKeyboardHeight(0));
    return () => { showSub.remove(); hideSub.remove(); };
  }, []);

  const handleChatOpen = useCallback((agentId: string) => {
    if (voiceAgentId) { abortListening(); setVoiceAgentId(null); }
    setChatAgentId(agentId);
    setChatText('');
    setTimeout(() => inlineInputRef.current?.focus(), 100);
  }, [voiceAgentId, abortListening]);

  const handleChatSend = useCallback(() => {
    const trimmed = chatText.trim();
    if (!trimmed || !chatAgentId || !onSendMessage) return;
    if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
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

  const handleVoiceOpen = useCallback(async (agentId: string) => {
    if (chatAgentId) { setChatAgentId(null); setChatText(''); Keyboard.dismiss(); }
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
    if (!trimmed || !voiceAgentId || !onSendMessage) return;
    if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
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

  const canSend = chatText.trim().length > 0;
  const canSendVoice = voiceText.trim().length > 0;

  // Tab switching
  const handleTabSwitch = useCallback((tab: GitScreenTab) => {
    if (tab !== activeTab) {
      if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setActiveTab(tab);
      const idx = GIT_TABS.indexOf(tab);
      tabScrollRef.current?.scrollTo({ x: idx * SCREEN_WIDTH, animated: true });
    }
  }, [activeTab]);

  const handleTabScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const offsetX = event.nativeEvent.contentOffset.x;
    const page = Math.round(offsetX / SCREEN_WIDTH);
    const tab = GIT_TABS[page];
    if (tab && tab !== activeTab) {
      if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setActiveTab(tab);
    }
  }, [activeTab]);

  const handleCreateWorktree = useCallback((projectId: string) => {
    const trimmed = newBranchName.trim();
    if (!trimmed) return;

    // Find the create-worktree skill and build the prompt with the branch name
    const createSkill = skills.find(s => s.name === 'create-worktree');
    const prompt = createSkill
      ? `${createSkill.body}\n\nCreate a worktree for branch: \`${trimmed}\``
      : `Create a new git worktree for branch: \`${trimmed}\``;

    // Find the project to get the main worktree path
    const project = projects.find(p => p.id === projectId);
    const mainWorktree = project?.worktrees.find(wt => wt.isMain);
    const worktreePath = mainWorktree?.path || project?.path || '';

    setNewBranchName('');
    setExpandedNewWorktree(null);
    Keyboard.dismiss();

    // Route through agent creation with the skill prompt
    onCreateAgentForWorktree?.(projectId, worktreePath, prompt);
  }, [newBranchName, skills, projects, onCreateAgentForWorktree]);

  // Slide in from the LEFT
  const swipeX = useRef(new Animated.Value(-SCREEN_WIDTH)).current;
  const didRequestInitialStatuses = useRef(false);

  useEffect(() => {
    Animated.timing(swipeX, {
      toValue: 0,
      duration: 250,
      useNativeDriver: true,
    }).start();
  }, [swipeX]);

  // Request git status for all agents on mount
  useEffect(() => {
    if (didRequestInitialStatuses.current) return;
    didRequestInitialStatuses.current = true;

    const agents = Array.from(state.agents.values());
    for (const agent of agents) {
      if (agent.cwd || agent.gitBranch) {
        onRequestGitStatus(agent.id);
      }
    }
  }, [onRequestGitStatus, state.agents]);

  // Swipe from right edge to dismiss (slide back left)
  // Use capture phase so the ScrollView doesn't steal the touch
  const edgeSwipeActive = useRef(false);
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponderCapture: (evt) => {
        // Claim touch immediately if it starts near the right edge
        const startX = evt.nativeEvent.pageX;
        if (startX > SCREEN_WIDTH - EDGE_WIDTH) {
          edgeSwipeActive.current = true;
          return true;
        }
        edgeSwipeActive.current = false;
        return false;
      },
      onMoveShouldSetPanResponder: (_evt, gesture) => {
        return (
          edgeSwipeActive.current &&
          gesture.dx < -10 &&
          Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.5
        );
      },
      onMoveShouldSetPanResponderCapture: (_evt, gesture) => {
        // Also capture during move if we started at the edge
        return (
          edgeSwipeActive.current &&
          gesture.dx < -10 &&
          Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.5
        );
      },
      onPanResponderMove: (_evt, gesture) => {
        if (gesture.dx < 0) {
          swipeX.setValue(gesture.dx);
        }
      },
      onPanResponderRelease: (_evt, gesture) => {
        edgeSwipeActive.current = false;
        if (gesture.dx < -SWIPE_THRESHOLD) {
          Animated.timing(swipeX, {
            toValue: -SCREEN_WIDTH,
            duration: 150,
            useNativeDriver: true,
          }).start(() => onBack());
        } else {
          Animated.spring(swipeX, {
            toValue: 0,
            useNativeDriver: true,
            tension: 80,
            friction: 10,
          }).start();
        }
      },
      onPanResponderTerminate: () => {
        edgeSwipeActive.current = false;
        Animated.spring(swipeX, {
          toValue: 0,
          useNativeDriver: true,
        }).start();
      },
    }),
  ).current;

  const animateBack = useCallback(() => {
    Animated.timing(swipeX, {
      toValue: -SCREEN_WIDTH,
      duration: 250,
      useNativeDriver: true,
    }).start(() => onBack());
  }, [swipeX, onBack]);

  const backdropOpacity = swipeX.interpolate({
    inputRange: [-SCREEN_WIDTH, 0],
    outputRange: [0, 0.5],
    extrapolate: 'clamp',
  });

  // Build worktree path → agents lookup (multiple agents can share a worktree)
  const cwdToAgents = useMemo(() => {
    const map = new Map<string, AgentState[]>();
    for (const agent of state.agents.values()) {
      if (agent.cwd) {
        const list = map.get(agent.cwd) || [];
        list.push(agent);
        map.set(agent.cwd, list);
      }
    }
    return map;
  }, [state.agents]);

  const hasAnyLoading = loadingAgentIds.size > 0;

  return (
    <View style={styles.overlay}>
      <Animated.View style={[styles.backdrop, { opacity: backdropOpacity }]} pointerEvents="none" />

      <Animated.View
        style={[styles.container, { transform: [{ translateX: swipeX }] }]}
        {...panResponder.panHandlers}
      >
        <View style={styles.header}>
          <GitBranchIcon size={18} />
          <Text style={styles.headerTitle}>Git</Text>
          <View style={styles.headerSpacer} />
          {hasAnyLoading && <ActivityIndicator color="#444" size="small" />}
          <TouchableOpacity onPress={animateBack} style={styles.closeButton} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Text style={styles.closeText}>Done</Text>
          </TouchableOpacity>
        </View>

        {/* Tab bar */}
        <View style={styles.tabBar}>
          {GIT_TABS.map(tab => (
            <TouchableOpacity
              key={tab}
              style={[styles.tab, activeTab === tab && styles.tabActive]}
              onPress={() => handleTabSwitch(tab)}
              activeOpacity={0.7}
            >
              <Text style={[styles.tabText, activeTab === tab && styles.tabTextActive]}>
                {tab === 'diff' ? 'Worktrees' : tab === 'source' ? 'Source' : 'Commits'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Tab content — horizontal paging */}
        <View style={styles.tabMain}>
          <ScrollView
            ref={tabScrollRef}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            onMomentumScrollEnd={handleTabScroll}
            scrollEventThrottle={16}
            keyboardShouldPersistTaps="handled"
          >
            {/* Worktrees tab */}
            <View style={styles.tabPage}>
              <ScrollView
                style={styles.content}
                contentContainerStyle={styles.contentInner}
                refreshControl={
                  <RefreshControl
                    refreshing={refreshing}
                    onRefresh={handleRefresh}
                    tintColor="#555"
                  />
                }
              >
                {projects.length === 0 ? (
                  <View style={styles.emptyContainer}>
                    <Text style={styles.emptyText}>No projects registered</Text>
                    <Text style={styles.emptySubtext}>Register a project to see git status here</Text>
                  </View>
                ) : (() => {
                  // Wait for ALL worktree statuses before showing real data — avoids per-row flicker
                  const allPaths = projects.flatMap(p => p.worktrees.map(wt => wt.path));
                  const allLoaded = allPaths.length > 0 && allPaths.every(p => worktreeGitData?.has(p));
                  const result: React.ReactNode[] = projects.map(project => (
              <View key={project.id} style={styles.projectSection}>
                <View style={styles.sectionHeader}>
                  <ProjectIcon project={project} />
                  <Text style={styles.sectionName}>{project.name}</Text>
                </View>

                {project.worktrees.map(wt => {
                  const agents = cwdToAgents.get(wt.path) || [];
                  const hasAgents = agents.length > 0;
                  // Use worktree-level git data (works with or without agents)
                  const wtGitData = worktreeGitData?.get(wt.path);
                  const isLoading = !allLoaded;
                  const files = wtGitData?.files || [];

                  return (
                    <View key={wt.path}>
                      <TouchableOpacity
                        style={styles.worktreeRow}
                        activeOpacity={0.7}
                        onPress={() => {
                          if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                          setSelectedWorktree({ projectId: project.id, path: wt.path, branch: wt.branch, isMain: wt.isMain });
                          setModalStep('actions');
                          setRemoveConfirmText('');
                        }}
                      >
                        <View style={[
                          styles.branchDot,
                          isLoading ? styles.branchDotLoading
                            : wt.isMain ? styles.branchDotMain
                            : wt.status === 'merged' ? styles.branchDotMerged
                            : files.length > 0 ? styles.branchDotDirty
                            : styles.branchDotClean,
                        ]} />
                        <Text style={styles.branchName} numberOfLines={1}>
                          {wt.branch}
                        </Text>
                        {isLoading ? (
                          <View style={styles.worktreeRight}>
                            <View style={styles.skeletonBadge} />
                            <View style={styles.skeletonCircle} />
                            <View style={styles.skeletonCircle} />
                            <View style={styles.skeletonFileCount} />
                          </View>
                        ) : (
                          <>
                            {wt.isMain && <Text style={styles.mainBadge}>main</Text>}
                            {wt.status === 'merged' && <Text style={styles.mergedBadge}>merged</Text>}
                            <View style={styles.worktreeRight}>
                              {hasAgents && <StackedAgentAvatars agents={agents} size={20} />}
                              <Text style={styles.fileCountBadge}>
                                {files.length > 0 ? `${files.length} file${files.length !== 1 ? 's' : ''}` : 'clean'}
                              </Text>
                            </View>
                          </>
                        )}
                      </TouchableOpacity>

                      {files.length > 0 && (
                        <View style={styles.fileList}>
                          {files.map((f, i) => (
                            <View key={`${f.file}-${i}`} style={styles.fileRow}>
                              <FileTypeIcon filename={f.file} size={16} />
                              <Text style={styles.fileName} numberOfLines={1}>{f.file}</Text>
                              <Text style={[styles.fileStatus, { color: getStatusColor(f.status) }]}>
                                {getStatusLetter(f.status)}
                              </Text>
                            </View>
                          ))}
                        </View>
                      )}
                    </View>
                  );
                })}

                {onCreateAgentForWorktree && (
                  expandedNewWorktree === project.id ? (
                    <View style={styles.newWorktreeExpanded}>
                      <TextInput
                        style={styles.newWorktreeInput}
                        value={newBranchName}
                        onChangeText={setNewBranchName}
                        placeholder="branch-name"
                        placeholderTextColor="#444"
                        autoCapitalize="none"
                        autoCorrect={false}
                        autoFocus
                        keyboardAppearance="dark"
                        onSubmitEditing={() => handleCreateWorktree(project.id)}
                        onBlur={() => {
                          // Delay collapse so a "Create" button press can register first
                          setTimeout(() => {
                            setExpandedNewWorktree((cur) => cur === project.id ? null : cur);
                            setNewBranchName('');
                          }, 150);
                        }}
                        returnKeyType="done"
                      />
                      <TouchableOpacity
                        style={[styles.newWorktreeCreateBtn, newBranchName.trim() && styles.newWorktreeCreateBtnActive]}
                        onPress={() => handleCreateWorktree(project.id)}
                        disabled={!newBranchName.trim()}
                        activeOpacity={0.7}
                      >
                        <Text style={[styles.newWorktreeCreateText, newBranchName.trim() && styles.newWorktreeCreateTextActive]}>
                          Create
                        </Text>
                      </TouchableOpacity>
                    </View>
                  ) : (
                    <TouchableOpacity
                      style={styles.newWorktreeRow}
                      onPress={() => {
                        if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                        setExpandedNewWorktree(project.id);
                        setNewBranchName('');
                      }}
                      activeOpacity={0.7}
                    >
                      <Text style={styles.newWorktreeText}>+ New worktree...</Text>
                    </TouchableOpacity>
                  )
                )}
              </View>
            ));
            result.push(
              <View key="__legend" style={styles.legend}>
                <View style={styles.legendItem}><View style={[styles.legendDot, { backgroundColor: '#3b82f6' }]} /><Text style={styles.legendLabel}>Main</Text></View>
                <View style={styles.legendItem}><View style={[styles.legendDot, { backgroundColor: '#f59e0b' }]} /><Text style={styles.legendLabel}>Changes</Text></View>
                <View style={styles.legendItem}><View style={[styles.legendDot, { backgroundColor: '#22c55e' }]} /><Text style={styles.legendLabel}>Clean</Text></View>
                <View style={styles.legendItem}><View style={[styles.legendDot, { backgroundColor: '#8b5cf6' }]} /><Text style={styles.legendLabel}>Merged</Text></View>
              </View>
            );
            return result;
          })()}
              </ScrollView>
            </View>

            {/* Source tab */}
            <View style={styles.tabPage}>
              <SourceTabContent
                projects={projects}
                gitLogMap={gitLogMap}
                gitLogLoading={gitLogLoading}
              />
            </View>

            {/* Commits tab */}
            <View style={styles.tabPage}>
              <CommitsTabContent
                projects={projects}
                gitLogMap={gitLogMap}
                gitLogLoading={gitLogLoading}
              />
            </View>
          </ScrollView>
        </View>

        {chatAgentId && chatAgent && onSendMessage && (
          <View style={[overlayStyles.inlineOverlay, { bottom: keyboardHeight - 40 }]}>
            <View style={overlayStyles.inlineContainer}>
              <View style={overlayStyles.inlineHeader}>
                <Text style={overlayStyles.inlineLabel} numberOfLines={1}>
                  Send to: {chatAgent.projectName ? (
                    <>
                      <Text style={settings.colorfulGitLabels ? overlayStyles.inlineProjectName : undefined}>{chatAgent.projectName}</Text>
                      {chatAgent.gitBranch ? <Text style={settings.colorfulGitLabels ? overlayStyles.inlineGit : undefined}> git:(<Text style={settings.colorfulGitLabels ? overlayStyles.inlineBranchName : undefined}>{chatAgent.gitBranch}</Text>)</Text> : null}
                    </>
                  ) : chatAgent.sessionName}
                </Text>
                <TouchableOpacity onPress={handleChatDismiss} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Text style={overlayStyles.inlineDismiss}>Cancel</Text>
                </TouchableOpacity>
              </View>
              <View style={overlayStyles.inlineRow}>
                <View style={overlayStyles.inlineInputWrapper}>
                  <TextInput
                    ref={inlineInputRef}
                    style={overlayStyles.inlineInput}
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
                  style={[overlayStyles.sendBtn, canSend && overlayStyles.sendBtnActive]}
                  onPress={handleChatSend}
                  disabled={!canSend}
                  activeOpacity={0.7}
                >
                  <View style={overlayStyles.sendIcon}>
                    <View style={[overlayStyles.arrowStem, { backgroundColor: canSend ? '#000' : '#555' }]} />
                    <View style={[overlayStyles.arrowHead, { borderBottomColor: canSend ? '#000' : '#555' }]} />
                  </View>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        )}

        {voiceAgentId && voiceAgent && onSendMessage && (
          <View style={[overlayStyles.voiceOverlay, keyboardHeight > 0 && { bottom: keyboardHeight - 40 }]}>
            <View style={overlayStyles.inlineContainer}>
              <View style={overlayStyles.inlineHeader}>
                <Text style={overlayStyles.inlineLabel} numberOfLines={1}>
                  Send to: {voiceAgent.projectName ? (
                    <>
                      <Text style={settings.colorfulGitLabels ? overlayStyles.inlineProjectName : undefined}>{voiceAgent.projectName}</Text>
                      {voiceAgent.gitBranch ? <Text style={settings.colorfulGitLabels ? overlayStyles.inlineGit : undefined}> git:(<Text style={settings.colorfulGitLabels ? overlayStyles.inlineBranchName : undefined}>{voiceAgent.gitBranch}</Text>)</Text> : null}
                    </>
                  ) : voiceAgent.sessionName}
                </Text>
                <TouchableOpacity onPress={handleVoiceDismiss} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Text style={overlayStyles.inlineDismiss}>Cancel</Text>
                </TouchableOpacity>
              </View>
              <View style={overlayStyles.voiceTranscriptArea}>
                <TextInput
                  style={overlayStyles.voiceTranscriptInput}
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
              <View style={overlayStyles.voiceBottomRow}>
                <View style={overlayStyles.voiceListeningIndicator}>
                  <View style={[overlayStyles.voiceListeningDot, isListening && overlayStyles.voiceListeningDotActive]} />
                  <Text style={overlayStyles.voiceListeningText}>{isListening ? 'Listening' : 'Stopped'}</Text>
                </View>
                <TouchableOpacity
                  style={[overlayStyles.sendBtn, canSendVoice && overlayStyles.sendBtnActive]}
                  onPress={handleVoiceSend}
                  disabled={!canSendVoice}
                  activeOpacity={0.7}
                >
                  <View style={overlayStyles.sendIcon}>
                    <View style={[overlayStyles.arrowStem, { backgroundColor: canSendVoice ? '#000' : '#555' }]} />
                    <View style={[overlayStyles.arrowHead, { borderBottomColor: canSendVoice ? '#000' : '#555' }]} />
                  </View>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        )}

        <BottomModal
          isVisible={!!selectedWorktree}
          onClose={() => { setSelectedWorktree(null); setRemoveConfirmText(''); setPendingSkillPrompt(null); setModalStep('actions'); }}
          title={modalStep === 'confirmRemove' ? 'Remove Worktree' : modalStep === 'pickAgent' ? 'Choose Agent' : selectedWorktree?.branch ?? ''}
        >
          {selectedWorktree && modalStep === 'actions' && (() => {
            const worktreeAgents = Array.from(state.agents.values()).filter(a => a.cwd === selectedWorktree.path);
            const filteredSkills = skills.filter(s => s.source === 'builtin' && s.name !== 'create-worktree');
            return (
              <View style={actionStyles.container}>
                {/* New chat */}
                <TouchableOpacity
                  style={actionStyles.row}
                  activeOpacity={0.7}
                  onPress={() => {
                    if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                    const wt = selectedWorktree;
                    setSelectedWorktree(null);
                    onCreateAgentForWorktree?.(wt.projectId, wt.path);
                  }}
                >
                  <View style={actionStyles.icon}>
                    <Text style={{ color: '#ccc', fontSize: 18, fontWeight: '600' }}>+</Text>
                  </View>
                  <View style={actionStyles.rowContent}>
                    <Text style={actionStyles.label}>New Chat</Text>
                    <Text style={actionStyles.description}>Start a fresh chat in this worktree</Text>
                  </View>
                </TouchableOpacity>

                {/* Existing chats */}
                {worktreeAgents.map(agent => (
                  <TouchableOpacity
                    key={agent.id}
                    style={actionStyles.row}
                    activeOpacity={0.7}
                    onPress={() => {
                      if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                      setSelectedWorktree(null);
                      animateBack();
                      setTimeout(() => onSelectAgent(agent.id), 300);
                    }}
                  >
                    <AgentAvatar type={agent.type} size={36} />
                    <View style={actionStyles.rowContent}>
                      <Text style={actionStyles.label} numberOfLines={1}>{agent.sessionName || 'Chat'}</Text>
                      <Text style={actionStyles.description} numberOfLines={1}>
                        {agent.type} · {agent.status === 'running' ? 'Running' : 'Idle'}
                      </Text>
                    </View>
                  </TouchableOpacity>
                ))}

                {/* Skills */}
                {filteredSkills.length > 0 && (
                  <>
                    <View style={actionStyles.divider} />
                    {filteredSkills.map(skill => {
                      // Build skill prompt with worktree context so the agent knows which branch to act on
                      const skillPrompt = `${skill.body}\n\nWorktree branch: \`${selectedWorktree.branch}\`\nWorktree path: \`${selectedWorktree.path}\``;
                      return (
                      <TouchableOpacity
                        key={skill.name}
                        style={actionStyles.row}
                        activeOpacity={0.7}
                        onPress={() => {
                          if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                          if (worktreeAgents.length === 0) {
                            const wt = selectedWorktree;
                            setSelectedWorktree(null);
                            onCreateAgentForWorktree?.(wt.projectId, wt.path, skillPrompt);
                          } else {
                            setPendingSkillPrompt(skillPrompt);
                            setModalStep('pickAgent');
                          }
                        }}
                      >
                        <View style={actionStyles.icon}>
                          <CommitIcon size={16} color="#ccc" />
                        </View>
                        <View style={actionStyles.rowContent}>
                          <Text style={actionStyles.label}>{skill.name}</Text>
                          <Text style={actionStyles.description} numberOfLines={1}>{skill.description}</Text>
                        </View>
                      </TouchableOpacity>
                    );
                    })}
                  </>
                )}

                {/* Remove worktree */}
                {!selectedWorktree.isMain && onRemoveWorktree && (
                  <>
                    <View style={actionStyles.divider} />
                    <TouchableOpacity
                      style={actionStyles.row}
                      activeOpacity={0.7}
                      onPress={() => {
                        if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                        setModalStep('confirmRemove');
                      }}
                    >
                      <View style={actionStyles.iconDestructive}>
                        <TrashIcon size={16} color="#ef4444" />
                      </View>
                      <View style={actionStyles.rowContent}>
                        <Text style={actionStyles.labelDestructive}>Remove Worktree</Text>
                        <Text style={actionStyles.description}>Delete worktree directory</Text>
                      </View>
                    </TouchableOpacity>
                  </>
                )}
              </View>
            );
          })()}

          {/* Pick agent for skill — only shown when there are existing agents */}
          {selectedWorktree && modalStep === 'pickAgent' && pendingSkillPrompt && (() => {
            const worktreeAgents = Array.from(state.agents.values()).filter(a => a.cwd === selectedWorktree.path);
            return (
              <View style={actionStyles.container}>
                {worktreeAgents.map(agent => (
                  <TouchableOpacity
                    key={agent.id}
                    style={actionStyles.row}
                    activeOpacity={0.7}
                    onPress={() => {
                      if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                      const prompt = pendingSkillPrompt;
                      setSelectedWorktree(null);
                      setPendingSkillPrompt(null);
                      onSendMessage?.(agent.id, prompt);
                      onSelectAgent(agent.id);
                    }}
                  >
                    <AgentAvatar type={agent.type} size={36} />
                    <View style={actionStyles.rowContent}>
                      <Text style={actionStyles.label} numberOfLines={1}>{agent.sessionName || 'Chat'}</Text>
                      <Text style={actionStyles.description} numberOfLines={1}>
                        {agent.type} · {agent.status === 'running' ? 'Running' : 'Idle'}
                      </Text>
                    </View>
                  </TouchableOpacity>
                ))}
                <View style={actionStyles.divider} />
                <TouchableOpacity
                  style={actionStyles.row}
                  activeOpacity={0.7}
                  onPress={() => {
                    if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                    const wt = selectedWorktree;
                    const prompt = pendingSkillPrompt;
                    setSelectedWorktree(null);
                    setPendingSkillPrompt(null);
                    onCreateAgentForWorktree?.(wt.projectId, wt.path, prompt ?? undefined);
                  }}
                >
                  <View style={actionStyles.icon}>
                    <Text style={{ color: '#ccc', fontSize: 18, fontWeight: '600' }}>+</Text>
                  </View>
                  <View style={actionStyles.rowContent}>
                    <Text style={actionStyles.label}>New Chat</Text>
                    <Text style={actionStyles.description}>Start a fresh chat with this skill</Text>
                  </View>
                </TouchableOpacity>
              </View>
            );
          })()}

          {selectedWorktree && modalStep === 'confirmRemove' && (() => {
            const confirmed = removeConfirmText === selectedWorktree.branch;
            const affectedAgents = Array.from(state.agents.values()).filter(a => a.cwd === selectedWorktree.path);
            return (
              <View style={removeStyles.container}>
                <Text style={removeStyles.message}>
                  This will delete the worktree directory. Uncommitted changes will be lost.
                </Text>
                {affectedAgents.length > 0 && (
                  <View style={removeStyles.affectedAgents}>
                    <View style={removeStyles.affectedRow}>
                      <StackedAgentAvatars agents={affectedAgents} size={24} />
                      <Text style={removeStyles.affectedText}>
                        {affectedAgents.length === 1
                          ? `${affectedAgents[0].sessionName || 'Chat'} will also be closed`
                          : `${affectedAgents.length} chats will also be closed`}
                      </Text>
                    </View>
                  </View>
                )}
                <Text style={removeStyles.hint}>
                  Type <Text style={removeStyles.branch}>{selectedWorktree.branch}</Text> to confirm.
                </Text>
                <TextInput
                  style={removeStyles.input}
                  value={removeConfirmText}
                  onChangeText={setRemoveConfirmText}
                  placeholder={selectedWorktree.branch}
                  placeholderTextColor="#333"
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoFocus
                  keyboardAppearance="dark"
                />
                <TouchableOpacity
                  style={[removeStyles.removeBtn, !confirmed && removeStyles.removeBtnDisabled]}
                  activeOpacity={0.7}
                  disabled={!confirmed}
                  onPress={() => {
                    if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                    onRemoveWorktree?.(selectedWorktree.projectId, selectedWorktree.path);
                    setSelectedWorktree(null);
                    setRemoveConfirmText('');
                  }}
                >
                  <Text style={[removeStyles.removeBtnText, !confirmed && removeStyles.removeBtnTextDisabled]}>
                    Remove Worktree
                  </Text>
                </TouchableOpacity>
              </View>
            );
          })()}
        </BottomModal>
      </Animated.View>
    </View>
  );
}

function GitBranchIcon({ size = 14 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M6 3v12M18 9a3 3 0 100-6 3 3 0 000 6zM6 21a3 3 0 100-6 3 3 0 000 6zM18 9a9 9 0 01-9 9"
        stroke="#888"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000',
  },
  container: {
    flex: 1,
    backgroundColor: '#0a0a0a',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 10,
    gap: 8,
  },
  headerTitle: {
    color: '#fafafa',
    fontSize: 17,
    fontWeight: '600',
  },
  headerSpacer: {
    flex: 1,
  },
  closeButton: {
    paddingLeft: 8,
  },
  tabBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 4,
    backgroundColor: '#0f0f0f',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#1a1a1a',
  },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabActive: {
    borderBottomColor: '#fff',
  },
  tabText: {
    color: '#555',
    fontSize: 13,
    fontWeight: '600',
  },
  tabTextActive: {
    color: '#fff',
  },
  tabMain: {
    flex: 1,
  },
  tabPage: {
    width: SCREEN_WIDTH,
    flex: 1,
  },
  closeText: {
    color: '#888',
    fontSize: 15,
    fontWeight: '500',
  },
  content: {
    flex: 1,
  },
  contentInner: {
    padding: 16,
    paddingBottom: 40,
  },
  emptyContainer: {
    paddingTop: 60,
    alignItems: 'center',
  },
  emptyText: {
    color: '#555',
    fontSize: 15,
    fontWeight: '500',
  },
  emptySubtext: {
    color: '#3a3a3a',
    fontSize: 12,
    marginTop: 4,
  },
  // Project sections
  projectSection: {
    marginBottom: 20,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 10,
  },
  sectionName: {
    color: '#aaa',
    fontSize: 14,
    fontWeight: '600',
    flex: 1,
  },
  projectIconFallback: {
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  projectIconLetter: {
    color: '#888',
    fontWeight: '600',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  // Worktree rows
  worktreeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1a1a1a',
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 1,
    gap: 8,
  },
  branchDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#555',
  },
  branchDotLoading: {
    backgroundColor: '#333',
  },
  branchDotMain: {
    backgroundColor: '#3b82f6', // blue — main branch
  },
  branchDotDirty: {
    backgroundColor: '#f59e0b', // amber — uncommitted changes
  },
  branchDotClean: {
    backgroundColor: '#22c55e', // green — clean working tree
  },
  branchDotMerged: {
    backgroundColor: '#8b5cf6', // purple — merged into main
  },
  branchName: {
    color: '#ccc',
    fontSize: 14,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    flex: 1,
  },
  mainBadge: {
    color: '#555',
    fontSize: 10,
    fontWeight: '500',
    backgroundColor: 'rgba(255,255,255,0.06)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    overflow: 'hidden',
  },
  mergedBadge: {
    color: '#8b5cf6',
    fontSize: 10,
    fontWeight: '500',
    backgroundColor: 'rgba(139,92,246,0.1)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    overflow: 'hidden',
  },
  worktreeRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginLeft: 'auto',
  },
  agentAvatar: {
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(0,0,0,0.18)',
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 1.5,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  fileCountBadge: {
    color: '#555',
    fontSize: 11,
  },
  skeletonBadge: {
    width: 38,
    height: 16,
    borderRadius: 4,
    backgroundColor: '#1f1f1f',
  },
  skeletonCircle: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#1f1f1f',
    marginLeft: -6,
  },
  skeletonFileCount: {
    width: 36,
    height: 12,
    borderRadius: 3,
    backgroundColor: '#1f1f1f',
  },
  worktreeRowExpanded: {
    borderBottomWidth: 0,
    marginBottom: 0,
  },
  // Space (expanded agent cards)
  spaceContainer: {
    backgroundColor: '#111',
    paddingHorizontal: 8,
    paddingVertical: 8,
    marginBottom: 1,
  },
  spaceStack: {
    gap: 6,
  },
  spaceGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  spaceCardStacked: {
    height: 260,
  },
  spaceCardGrid: {
    width: (SCREEN_WIDTH - 32 - 16 - 6) / 2, // screen - outer padding - inner padding - gap
    height: 260,
  },
  // File rows
  fileList: {
    backgroundColor: '#141414',
    paddingVertical: 4,
    paddingRight: 14,
    paddingLeft: 10,
    marginBottom: 1,
  },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 3,
    gap: 8,
  },
  fileStatus: {
    fontSize: 11,
    fontWeight: '600',
    textAlign: 'right',
  },
  fileName: {
    flex: 1,
    color: '#777',
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  // New worktree
  newWorktreeRow: {
    backgroundColor: '#1a1a1a',
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 1,
  },
  newWorktreeText: {
    color: '#444',
    fontSize: 13,
    fontWeight: '500',
  },
  legend: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
    paddingVertical: 16,
    paddingHorizontal: 14,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  legendDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
  },
  legendLabel: {
    color: '#444',
    fontSize: 11,
  },
  newWorktreeExpanded: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1a1a1a',
    paddingVertical: 6,
    paddingHorizontal: 14,
    marginBottom: 1,
    gap: 10,
  },
  newWorktreeInput: {
    flex: 1,
    color: '#e5e5e5',
    fontSize: 14,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    paddingVertical: 6,
    paddingHorizontal: 0,
  },
  newWorktreeCreateBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  newWorktreeCreateBtnActive: {
    backgroundColor: '#fff',
  },
  newWorktreeCreateText: {
    color: '#444',
    fontSize: 13,
    fontWeight: '600',
  },
  newWorktreeCreateTextActive: {
    color: '#000',
  },
});

const overlayStyles = StyleSheet.create({
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
  sendBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnActive: {
    backgroundColor: '#fff',
  },
  sendIcon: {
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

const actionStyles = StyleSheet.create({
  container: {
    paddingBottom: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 14,
  },
  icon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconDestructive: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowContent: {
    flex: 1,
  },
  label: {
    color: '#e5e5e5',
    fontSize: 15,
    fontWeight: '600',
  },
  labelDestructive: {
    color: '#ef4444',
    fontSize: 15,
    fontWeight: '600',
  },
  description: {
    color: '#666',
    fontSize: 12,
    marginTop: 2,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    marginVertical: 4,
  },
});

const removeStyles = StyleSheet.create({
  container: {
    gap: 12,
    paddingBottom: 8,
  },
  message: {
    color: '#999',
    fontSize: 14,
    lineHeight: 20,
  },
  branch: {
    color: '#e5e5e5',
    fontWeight: '600',
  },
  hint: {
    color: '#666',
    fontSize: 13,
    lineHeight: 18,
  },
  input: {
    backgroundColor: '#1a1a1a',
    color: '#e5e5e5',
    fontSize: 14,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#2a2a2a',
  },
  removeBtn: {
    backgroundColor: '#dc2626',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  removeBtnDisabled: {
    backgroundColor: 'rgba(220, 38, 38, 0.15)',
  },
  removeBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  removeBtnTextDisabled: {
    color: 'rgba(255, 255, 255, 0.25)',
  },
  affectedAgents: {
    backgroundColor: 'rgba(239, 68, 68, 0.08)',
    borderRadius: 8,
    padding: 10,
  },
  affectedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  affectedText: {
    color: '#ef4444',
    fontSize: 13,
    fontWeight: '500',
    flex: 1,
  },
});
