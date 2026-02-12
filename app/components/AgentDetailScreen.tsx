import React, { useCallback, useState, useEffect, useMemo, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  Image,
  TouchableOpacity,
  StyleSheet,
  Platform,
  Keyboard,
  LayoutAnimation,
  PanResponder,
  Animated,
  Dimensions,
  ScrollView,
} from 'react-native';
import Svg, { Path } from 'react-native-svg';
import * as Haptics from 'expo-haptics';
import { useAgent, useAgentState } from '../state/AgentContext';
import type { ConnectionStatus, PermissionRequest } from '../types';
import type { AgentType, Project, Skill } from '../state/types';
import { KeyboardScrollView } from './KeyboardScrollView';
import { MessageBubble, buildToolResultMap } from './MessageBubble';
import { InputBar } from './InputBar';
import { BottomModal } from './BottomModal';
import { CodeBlock } from './CodeBlock';
import { GitTabContent, type GitStatusData } from './GitTabContent';
import { ArtifactsTabContent } from './ArtifactsTabContent';
import { useSpeechRecognition } from '../hooks/useSpeechRecognition';
import { useSettings } from '../state/SettingsContext';

// Claude logo SVG path (shared with AgentCard)
const CLAUDE_LOGO_PATH = 'M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z';
const OPENAI_LOGO_PATH = 'M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z';

const SCREEN_WIDTH = Dimensions.get('window').width;
const SWIPE_THRESHOLD = SCREEN_WIDTH * 0.25;
const EDGE_WIDTH = 30; // pixels from left edge to start recognizing swipe

type DetailTab = 'chat' | 'git' | 'artifacts';
const DETAIL_TABS: DetailTab[] = ['chat', 'git', 'artifacts'];

interface AgentDetailScreenProps {
  agentId: string;
  connectionStatus: ConnectionStatus;
  projects?: Project[];
  skills?: Skill[];
  onBack: () => void;
  onSendMessage: (agentId: string, text: string) => void;
  onStopAgent?: (agentId: string) => void;
  onRespondPermission: (agentId: string, requestId: string, behavior: 'allow' | 'deny') => void;
  onSetAutoApprove?: (agentId: string, enabled: boolean) => void;
  onResetPingTimer: () => void;
  onRequestGitStatus?: (agentId: string) => void;
  onRequestGitDiff?: (agentId: string, filePath: string) => void;
  gitStatus?: GitStatusData | null;
  gitDiff?: string | null;
  gitLoading?: boolean;
  gitDiffLoading?: boolean;
}

function formatCost(cost: number): string {
  if (cost === 0) return '$0.00';
  if (cost < 0.01) return '<$0.01';
  return `$${cost.toFixed(2)}`;
}

function formatModelName(model: string | null, type: AgentType): string {
  if (!model) return type.charAt(0).toUpperCase() + type.slice(1);
  const claudeMatch = model.match(/^claude-(\w+)-(\d+)-(\d+)/);
  if (claudeMatch) {
    const variant = claudeMatch[1].charAt(0).toUpperCase() + claudeMatch[1].slice(1);
    return `Claude ${variant} ${claudeMatch[2]}.${claudeMatch[3]}`;
  }
  if (model.length > 30) return model.slice(0, 30) + '...';
  return model;
}

// Diff view for Edit tool permissions — shows old_string/new_string as red/green lines
function PermissionDiffView({ filePath, oldStr, newStr }: { filePath?: string; oldStr: string; newStr: string }) {
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');

  return (
    <View>
      {filePath && (
        <Text style={styles.diffHeader} numberOfLines={1}>{filePath}</Text>
      )}
      {oldLines.map((line, i) => (
        <View key={`r${i}`} style={styles.diffLineRemoved}>
          <Text style={styles.diffPrefix}>-</Text>
          <Text style={styles.diffTextRemoved}>{line}</Text>
        </View>
      ))}
      {newLines.map((line, i) => (
        <View key={`a${i}`} style={styles.diffLineAdded}>
          <Text style={styles.diffPrefix}>+</Text>
          <Text style={styles.diffTextAdded}>{line}</Text>
        </View>
      ))}
    </View>
  );
}

function isEditWithDiff(toolName: string, toolInput: Record<string, unknown>): boolean {
  return toolName === 'Edit' && typeof toolInput.old_string === 'string' && typeof toolInput.new_string === 'string';
}

// Individual permission prompt for structured tool data
function PermissionCard({
  permission,
  onAllow,
  onDeny,
}: {
  permission: PermissionRequest;
  onAllow: () => void;
  onDeny: () => void;
}) {
  const handleAllow = () => {
    if (Platform.OS === 'ios') {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
    onAllow();
  };

  const handleDeny = () => {
    if (Platform.OS === 'ios') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    onDeny();
  };

  const showDiff = isEditWithDiff(permission.toolName, permission.toolInput);

  return (
    <View style={styles.permissionCard}>
      <Text style={styles.permissionTitle}>Permission Required</Text>
      <Text style={styles.permissionToolName}>{permission.toolName}</Text>
      {Object.keys(permission.toolInput).length > 0 && (
        <View style={styles.permissionInput}>
          {showDiff ? (
            <ScrollView style={styles.diffScroll} nestedScrollEnabled>
              <PermissionDiffView
                filePath={typeof permission.toolInput.file_path === 'string' ? permission.toolInput.file_path : undefined}
                oldStr={permission.toolInput.old_string as string}
                newStr={permission.toolInput.new_string as string}
              />
            </ScrollView>
          ) : (
            <CodeBlock
              code={JSON.stringify(permission.toolInput, null, 2)}
              language="json"
            />
          )}
        </View>
      )}
      <View style={styles.permissionButtons}>
        <TouchableOpacity style={styles.denyButton} onPress={handleDeny} activeOpacity={0.7}>
          <Text style={styles.denyText}>Deny</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.allowButton} onPress={handleAllow} activeOpacity={0.8}>
          <Text style={styles.allowText}>Allow</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// Agent type icon — SVG logo or colored letter fallback
function AgentIcon({ type, size = 28 }: { type: AgentType; size?: number }) {
  const BRAND: Record<string, { color: string; bg: string; letter: string }> = {
    claude:   { color: '#D97757', bg: '#FFFFFF', letter: 'C' },
    codex:    { color: '#111111', bg: '#FFFFFF', letter: 'X' },
    opencode: { color: '#3B82F6', bg: '#FFFFFF', letter: 'O' },
  };
  const brand = BRAND[type] || { color: '#888', bg: 'rgba(136,136,136,0.15)', letter: '?' };
  const iconSize = size * 0.58;

  return (
    <View style={[styles.agentIcon, { width: size, height: size, backgroundColor: brand.bg }]}>
      {type === 'claude' ? (
        <Svg width={iconSize} height={iconSize} viewBox="0 0 24 24">
          <Path d={CLAUDE_LOGO_PATH} fill={brand.color} fillRule="nonzero" />
        </Svg>
      ) : type === 'codex' ? (
        <Svg width={iconSize} height={iconSize} viewBox="0 0 24 24">
          <Path d={OPENAI_LOGO_PATH} fill={brand.color} fillRule="evenodd" />
        </Svg>
      ) : (
        <Text style={[styles.agentIconLetter, { color: brand.color, fontSize: size * 0.48 }]}>
          {brand.letter}
        </Text>
      )}
    </View>
  );
}

export function AgentDetailScreen({
  agentId,
  connectionStatus,
  projects,
  skills = [],
  onBack,
  onSendMessage,
  onStopAgent,
  onRespondPermission,
  onSetAutoApprove,
  onResetPingTimer,
  onRequestGitStatus,
  onRequestGitDiff,
  gitStatus = null,
  gitDiff = null,
  gitLoading = false,
  gitDiffLoading = false,
}: AgentDetailScreenProps) {
  const agent = useAgent(agentId);
  const { dispatch } = useAgentState();
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [activeTab, setActiveTab] = useState<DetailTab>('chat');
  const tabScrollRef = useRef<ScrollView>(null);
  const INITIAL_MESSAGE_WINDOW = 30;
  const [messageWindow, setMessageWindow] = useState(INITIAL_MESSAGE_WINDOW);
  const [showPlusModal, setShowPlusModal] = useState(false);
  const [showSkillPicker, setShowSkillPicker] = useState(false);

  // Swipe-from-left-edge to go back (only on Chat tab)
  const swipeX = useRef(new Animated.Value(0)).current;
  const activeTabRef = useRef<DetailTab>('chat');
  activeTabRef.current = activeTab;

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_evt, gesture) => {
        // Only respond on Chat tab — other tabs use horizontal ScrollView for swiping
        if (activeTabRef.current !== 'chat') return false;
        // Only respond to horizontal swipes starting near the left edge
        return (
          gesture.x0 < EDGE_WIDTH &&
          gesture.dx > 10 &&
          Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.5
        );
      },
      onPanResponderMove: (_evt, gesture) => {
        if (gesture.dx > 0) {
          swipeX.setValue(gesture.dx);
        }
      },
      onPanResponderRelease: (_evt, gesture) => {
        if (gesture.dx > SWIPE_THRESHOLD) {
          Animated.timing(swipeX, {
            toValue: SCREEN_WIDTH,
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
        Animated.spring(swipeX, {
          toValue: 0,
          useNativeDriver: true,
        }).start();
      },
    }),
  ).current;

  // Track keyboard height directly — more reliable than KeyboardAvoidingView
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const showListener = Keyboard.addListener(showEvent, (e) => {
      if (Platform.OS === 'ios') {
        LayoutAnimation.configureNext({
          duration: e.duration,
          update: { type: LayoutAnimation.Types.keyboard },
        });
      }
      setKeyboardHeight(e.endCoordinates.height);
    });

    const hideListener = Keyboard.addListener(hideEvent, (e) => {
      if (Platform.OS === 'ios') {
        LayoutAnimation.configureNext({
          duration: e.duration,
          update: { type: LayoutAnimation.Types.keyboard },
        });
      }
      setKeyboardHeight(0);
    });

    return () => {
      showListener.remove();
      hideListener.remove();
    };
  }, []);

  // Animate slide-out then call onBack (used by both back button and swipe)
  const animateBack = useCallback(() => {
    Animated.timing(swipeX, {
      toValue: SCREEN_WIDTH,
      duration: 250,
      useNativeDriver: true,
    }).start(() => onBack());
  }, [swipeX, onBack]);

  // Backdrop dims the dashboard underneath during swipe
  const backdropOpacity = swipeX.interpolate({
    inputRange: [0, SCREEN_WIDTH],
    outputRange: [0.5, 0],
    extrapolate: 'clamp',
  });

  const handleSend = useCallback((text: string) => {
    onSendMessage(agentId, text);
    // Clear draft after sending
    dispatch({ type: 'SET_DRAFT', agentId, text: '' });
  }, [agentId, onSendMessage, dispatch]);

  const handleStop = useCallback(() => {
    onStopAgent?.(agentId);
  }, [agentId, onStopAgent]);

  const handleDraftChange = useCallback((text: string) => {
    dispatch({ type: 'SET_DRAFT', agentId, text });
  }, [agentId, dispatch]);

  // Voice input
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [voiceText, setVoiceText] = useState('');
  const { settings } = useSettings();
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

  const handleVoiceOpen = useCallback(async () => {
    Keyboard.dismiss();
    setVoiceOpen(true);
    setVoiceText('');
    clearTranscript();
    const started = await startListening();
    if (!started) {
      setVoiceOpen(false);
    }
  }, [startListening, clearTranscript]);

  const handleVoiceSend = useCallback(() => {
    const trimmed = voiceText.trim();
    if (!trimmed) return;
    stopListening();
    onSendMessage(agentId, trimmed);
    clearTranscript();
    setVoiceText('');
    setVoiceOpen(false);
  }, [voiceText, stopListening, onSendMessage, agentId, clearTranscript]);

  const handleVoiceDismiss = useCallback(() => {
    abortListening();
    setVoiceText('');
    setVoiceOpen(false);
  }, [abortListening]);

  const canSendVoice = voiceText.trim().length > 0 && connectionStatus === 'connected';

  // Match agent to a project (for icon and name)
  const matchedProject = useMemo(() => {
    if (!projects?.length || !agent) return null;
    if (agent.cwd) {
      for (const p of projects) {
        if (agent.cwd === p.path) return p;
        if (p.worktrees?.some(wt => agent.cwd === wt.path)) return p;
      }
    }
    if (agent.projectName) {
      return projects.find(p => p.name === agent.projectName) || null;
    }
    return null;
  }, [agent, projects]);

  // Git request callbacks
  const handleRequestGitStatus = useCallback(() => {
    onRequestGitStatus?.(agentId);
  }, [agentId, onRequestGitStatus]);

  const handleRequestGitDiff = useCallback((filePath: string) => {
    onRequestGitDiff?.(agentId, filePath);
  }, [agentId, onRequestGitDiff]);

  // Tab switching — taps and swipes both go through here
  const handleTabSwitch = useCallback((tab: DetailTab) => {
    if (tab !== activeTab) {
      if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setActiveTab(tab);
      const idx = DETAIL_TABS.indexOf(tab);
      tabScrollRef.current?.scrollTo({ x: idx * SCREEN_WIDTH, animated: true });
    }
  }, [activeTab]);

  // Sync tab state from horizontal scroll (swipe between tabs)
  const handleTabScroll = useCallback((event: import('react-native').NativeSyntheticEvent<import('react-native').NativeScrollEvent>) => {
    const offsetX = event.nativeEvent.contentOffset.x;
    const page = Math.round(offsetX / SCREEN_WIDTH);
    const tab = DETAIL_TABS[page];
    if (tab && tab !== activeTab) {
      if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setActiveTab(tab);
    }
  }, [activeTab]);

  // Count artifact URLs for badge
  const artifactCount = useMemo(() => {
    if (!agent) return 0;
    const urlRegex = /https?:\/\/[^\s<>)"'\]*_`~]+/g;
    const seen = new Set<string>();
    const stringifyVal = (val: unknown): string => {
      if (typeof val === 'string') return val;
      if (val == null || typeof val === 'boolean' || typeof val === 'number') return '';
      if (Array.isArray(val)) return val.map(stringifyVal).join('\n');
      if (typeof val === 'object') return Object.values(val as Record<string, unknown>).map(stringifyVal).join('\n');
      return '';
    };
    for (const msg of agent.messages) {
      let text = '';
      if (typeof msg.content === 'string') text = msg.content;
      else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text' || block.type === 'thinking') {
            text += block.text + '\n';
          } else if (block.type === 'tool_use') {
            text += stringifyVal(block.input) + '\n';
          } else if (block.type === 'tool_result') {
            text += stringifyVal(block.content) + '\n';
          }
        }
      }
      const matches = text.match(urlRegex);
      if (matches) matches.forEach(u => seen.add(u.replace(/[.,;:!?)\]}>]+$/, '')));
    }
    return seen.size;
  }, [agent]);

  // Build a global toolUseId → result map across ALL messages
  const toolResultMap = useMemo(
    () => agent ? buildToolResultMap(agent.messages) : new Map(),
    [agent],
  );

  // Only render the last N messages for performance
  const visibleMessages = useMemo(() => {
    if (!agent) return [];
    const msgs = agent.messages;
    if (msgs.length <= messageWindow) return msgs;
    return msgs.slice(msgs.length - messageWindow);
  }, [agent, messageWindow]);
  const hasHiddenMessages = agent ? agent.messages.length > messageWindow : false;

  if (!agent) {
    return (
      <View style={styles.overlay}>
        <Animated.View style={[styles.backdrop, { opacity: backdropOpacity }]} pointerEvents="none" />
        <View style={styles.container}>
          <View style={styles.header}>
            <TouchableOpacity onPress={animateBack} style={styles.backButton}>
              <BackArrow />
            </TouchableOpacity>
          </View>
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyText}>Agent not found</Text>
          </View>
        </View>
      </View>
    );
  }

  const isDisabled = connectionStatus !== 'connected' || agent.status === 'exited';
  const permissions = Array.from(agent.pendingPermissions.values());
  const modelDisplayName = formatModelName(agent.model, agent.type);

  // Build project/branch subtitle
  const subtitle = agent.projectName
    ? agent.gitBranch
      ? `${agent.projectName} · ${agent.gitBranch}`
      : agent.projectName
    : null;

  // Header icon: project favicon → project letter → agent type icon
  const iconSize = 30;
  const iconElement = matchedProject ? (
    matchedProject.icon ? (
      <Image
        source={{ uri: matchedProject.icon }}
        style={{ width: iconSize, height: iconSize, borderRadius: iconSize * 0.22 }}
      />
    ) : (
      <View style={[styles.agentIcon, { width: iconSize, height: iconSize, backgroundColor: 'rgba(255,255,255,0.06)' }]}>
        <Text style={[styles.agentIconLetter, { color: '#888', fontSize: iconSize * 0.48 }]}>
          {matchedProject.name.charAt(0).toUpperCase()}
        </Text>
      </View>
    )
  ) : (
    <AgentIcon type={agent.type} size={iconSize} />
  );

  return (
    <View style={styles.overlay}>
      {/* Dim backdrop over dashboard during swipe */}
      <Animated.View style={[styles.backdrop, { opacity: backdropOpacity }]} pointerEvents="none" />

      {/* Sliding detail content */}
      <Animated.View
        style={[styles.container, { transform: [{ translateX: swipeX }] }]}
        {...panResponder.panHandlers}
      >
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={animateBack} style={styles.backButton} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <BackArrow />
          </TouchableOpacity>

          {iconElement}

          <View style={styles.headerInfo}>
            <Text style={styles.headerTitle} numberOfLines={1}>
              {subtitle || agent.sessionName}
            </Text>
            <Text style={styles.headerSubtitle} numberOfLines={1}>{modelDisplayName}</Text>
          </View>

          {/* Ask / Auto permission toggle */}
          {agent.status !== 'exited' && (
            <View style={styles.modeToggle}>
              <TouchableOpacity
                style={[styles.modeOption, !agent.autoApprove && styles.modeOptionActive]}
                onPress={() => {
                  if (agent.autoApprove && onSetAutoApprove) {
                    if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    onSetAutoApprove(agentId, false);
                  }
                }}
                activeOpacity={0.7}
              >
                <Text style={[styles.modeText, !agent.autoApprove && styles.modeTextActive]}>Ask</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modeOption, agent.autoApprove && styles.modeOptionAuto]}
                onPress={() => {
                  if (!agent.autoApprove && onSetAutoApprove) {
                    if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    onSetAutoApprove(agentId, true);
                  }
                }}
                activeOpacity={0.7}
              >
                <Text style={[styles.modeText, agent.autoApprove && styles.modeTextAuto]}>Auto</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>

        {/* Tab bar */}
        <View style={styles.tabBar}>
          <TouchableOpacity
            style={[styles.tab, activeTab === 'chat' && styles.tabActive]}
            onPress={() => handleTabSwitch('chat')}
            activeOpacity={0.7}
          >
            <Text style={[styles.tabText, activeTab === 'chat' && styles.tabTextActive]}>Chat</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.tab, activeTab === 'git' && styles.tabActive]}
            onPress={() => handleTabSwitch('git')}
            activeOpacity={0.7}
          >
            <Text style={[styles.tabText, activeTab === 'git' && styles.tabTextActive]}>Git</Text>
            {gitStatus && gitStatus.files.length > 0 && (
              <View style={[styles.tabBadgeCircle, activeTab === 'git' && styles.tabBadgeCircleActive]}>
                <Text style={[styles.tabBadgeText, activeTab === 'git' && styles.tabBadgeTextActive]}>{gitStatus.files.length}</Text>
              </View>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.tab, activeTab === 'artifacts' && styles.tabActive]}
            onPress={() => handleTabSwitch('artifacts')}
            activeOpacity={0.7}
          >
            <Text style={[styles.tabText, activeTab === 'artifacts' && styles.tabTextActive]}>Artifacts</Text>
            {artifactCount > 0 && (
              <View style={[styles.tabBadgeCircle, activeTab === 'artifacts' && styles.tabBadgeCircleActive]}>
                <Text style={[styles.tabBadgeText, activeTab === 'artifacts' && styles.tabBadgeTextActive]}>{artifactCount}</Text>
              </View>
            )}
          </TouchableOpacity>

          {/* Compact stats inline */}
          {(agent.totalCost > 0 || agent.outputTokens > 0) && (
            <View style={styles.tabStats}>
              <Text style={styles.tabStatText}>{formatCost(agent.totalCost)}</Text>
              {agent.contextUsedPercent > 0 && (
                <View style={styles.tabContextBar}>
                  <View
                    style={[
                      styles.contextFill,
                      {
                        width: `${Math.min(agent.contextUsedPercent, 100)}%`,
                        backgroundColor: agent.contextUsedPercent > 80 ? '#ef4444' :
                                         agent.contextUsedPercent > 50 ? '#f59e0b' : '#22c55e',
                      },
                    ]}
                  />
                </View>
              )}
            </View>
          )}
        </View>

        {/* Tab content — horizontal paging ScrollView for swipe between tabs */}
        <View style={styles.main}>
          <ScrollView
            ref={tabScrollRef}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            onMomentumScrollEnd={handleTabScroll}
            scrollEventThrottle={16}
            keyboardShouldPersistTaps="handled"
          >
            {/* Chat tab */}
            <View style={[styles.tabPage, activeTab === 'chat' && keyboardHeight > 0 && { paddingBottom: keyboardHeight }]}>
              <KeyboardScrollView style={styles.chatArea} contentContainerStyle={styles.chatContent}>
                {agent.messages.length === 0 ? (
                  <Text style={styles.placeholder}>Send a message to start...</Text>
                ) : (
                  <>
                    {hasHiddenMessages && (
                      <TouchableOpacity
                        style={styles.loadMoreBtn}
                        onPress={() => setMessageWindow(w => w + 50)}
                      >
                        <Text style={styles.loadMoreText}>
                          Load earlier messages ({agent.messages.length - messageWindow} hidden)
                        </Text>
                      </TouchableOpacity>
                    )}
                    {visibleMessages.map((msg, idx) => (
                      <MessageBubble
                        key={`${msg.id}-${idx}`}
                        message={msg}
                        toolResultMap={toolResultMap}
                        animateThinking={agent.status === 'running' && idx === visibleMessages.length - 1}
                      />
                    ))}
                  </>
                )}

                {/* Pending permissions */}
                {permissions.map((perm) => (
                  <PermissionCard
                    key={perm.requestId}
                    permission={perm}
                    onAllow={() => onRespondPermission(agentId, perm.requestId, 'allow')}
                    onDeny={() => onRespondPermission(agentId, perm.requestId, 'deny')}
                  />
                ))}
              </KeyboardScrollView>

              {voiceOpen ? (
                <View style={[styles.voiceOverlay, keyboardHeight === 0 && styles.voiceOverlaySafeArea]}>
                  <View style={styles.voiceHeader}>
                    <Text style={styles.voiceLabel} numberOfLines={1}>
                      Send to: {agent.projectName ? (
                        <>
                          <Text style={settings.colorfulGitLabels ? styles.voiceProjectName : undefined}>{agent.projectName}</Text>
                          {agent.gitBranch ? <Text style={settings.colorfulGitLabels ? styles.voiceGitText : undefined}> git:(<Text style={settings.colorfulGitLabels ? styles.voiceBranchName : undefined}>{agent.gitBranch}</Text>)</Text> : null}
                        </>
                      ) : agent.sessionName}
                    </Text>
                    <TouchableOpacity onPress={handleVoiceDismiss} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                      <Text style={styles.voiceCancelText}>Cancel</Text>
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
                      <View style={[styles.voiceListeningDot, isListening && styles.voiceListeningDotActive]} />
                      <Text style={styles.voiceListeningStatusText}>{isListening ? 'Listening' : 'Stopped'}</Text>
                    </View>
                    <TouchableOpacity
                      style={[styles.voiceSendBtn, canSendVoice && styles.voiceSendBtnActive]}
                      onPress={handleVoiceSend}
                      disabled={!canSendVoice}
                      activeOpacity={0.7}
                    >
                      <View style={styles.voiceSendIcon}>
                        <View style={[styles.voiceArrowStem, { backgroundColor: canSendVoice ? '#000' : '#555' }]} />
                        <View style={[styles.voiceArrowHead, { borderBottomColor: canSendVoice ? '#000' : '#555' }]} />
                      </View>
                    </TouchableOpacity>
                  </View>
                </View>
              ) : (
                <InputBar
                  onSend={handleSend}
                  onStop={handleStop}
                  showStop={agent.status === 'running'}
                  onVoice={handleVoiceOpen}
                  onPlus={() => setShowPlusModal(true)}
                  disabled={isDisabled || permissions.length > 0}
                  placeholder={agent.status === 'running' ? 'Agent is working...' : 'Ask anything...'}
                  shimmer={agent.status === 'running'}
                  onActivity={onResetPingTimer}
                  initialValue={agent.draftText}
                  onDraftChange={handleDraftChange}
                />
              )}
            </View>

            {/* Git tab */}
            <View style={styles.tabPage}>
              <GitTabContent
                agentStatus={agent.status}
                gitStatus={gitStatus}
                gitDiff={gitDiff}
                loading={gitLoading}
                diffLoading={gitDiffLoading}
                onRequestStatus={handleRequestGitStatus}
                onRequestDiff={handleRequestGitDiff}
              />
            </View>

            {/* Artifacts tab */}
            <View style={styles.tabPage}>
              <ArtifactsTabContent messages={agent.messages} />
            </View>
          </ScrollView>
        </View>
      </Animated.View>

      {/* Plus button modal — actions */}
      <BottomModal isVisible={showPlusModal} onClose={() => setShowPlusModal(false)} title="Actions">
        <View style={plusModalStyles.list}>
          <TouchableOpacity
            style={plusModalStyles.row}
            activeOpacity={0.7}
            onPress={() => {
              setShowPlusModal(false);
              setShowSkillPicker(true);
            }}
          >
            <View style={plusModalStyles.icon}>
              <Svg width={16} height={16} viewBox="0 0 24 24" fill="none">
                <Path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" stroke="#ccc" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
              </Svg>
            </View>
            <View style={plusModalStyles.rowContent}>
              <Text style={plusModalStyles.label}>Use Skill</Text>
              <Text style={plusModalStyles.description}>Run an installed skill in this chat</Text>
            </View>
          </TouchableOpacity>
        </View>
      </BottomModal>

      {/* Skill picker modal */}
      <BottomModal isVisible={showSkillPicker} onClose={() => setShowSkillPicker(false)} title="Choose Skill">
        <ScrollView style={plusModalStyles.scrollList} contentContainerStyle={plusModalStyles.list}>
          {skills.filter(s => s.source !== 'builtin').length === 0 ? (
            <Text style={plusModalStyles.emptyText}>No skills installed</Text>
          ) : (
            skills.filter(s => s.source !== 'builtin').map(skill => (
              <TouchableOpacity
                key={skill.name}
                style={plusModalStyles.row}
                activeOpacity={0.7}
                onPress={() => {
                  setShowSkillPicker(false);
                  onSendMessage(agentId, skill.body);
                }}
              >
                <View style={plusModalStyles.icon}>
                  {skill.icon === 'commit' ? (
                    <Svg width={16} height={16} viewBox="0 0 24 24" fill="none">
                      <Path d="M12 16a4 4 0 100-8 4 4 0 000 8zM12 3v5M12 16v5" stroke="#ccc" strokeWidth={2} strokeLinecap="round" />
                    </Svg>
                  ) : skill.icon === 'vercel' ? (
                    <Svg width={16} height={16} viewBox="0 0 24 24" fill="none">
                      <Path d="M12 2L2 22h20L12 2z" fill="#ccc" />
                    </Svg>
                  ) : (
                    <Svg width={16} height={16} viewBox="0 0 24 24" fill="none">
                      <Path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" stroke="#ccc" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
                    </Svg>
                  )}
                </View>
                <View style={plusModalStyles.rowContent}>
                  <Text style={plusModalStyles.label}>{skill.name}</Text>
                  <Text style={plusModalStyles.description} numberOfLines={2}>{skill.description}</Text>
                </View>
              </TouchableOpacity>
            ))
          )}
        </ScrollView>
      </BottomModal>
    </View>
  );
}

// Simple back chevron using a single bordered View
function BackArrow() {
  return (
    <View style={styles.arrowContainer}>
      <View style={styles.arrowChevron} />
    </View>
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
  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    marginTop: -8,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a1a',
    gap: 10,
  },
  backButton: {
    paddingRight: 4,
  },
  headerInfo: {
    flex: 1,
  },
  headerTitle: {
    color: '#fafafa',
    fontSize: 15,
    fontWeight: '600',
  },
  headerSubtitle: {
    color: '#555',
    fontSize: 12,
    marginTop: 1,
  },
  // Agent icon
  agentIcon: {
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  agentIconLetter: {
    fontWeight: '700',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  // Ask/Auto toggle
  modeToggle: {
    flexDirection: 'row',
    backgroundColor: '#1a1a1a',
    borderRadius: 8,
    padding: 2,
  },
  modeOption: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
  },
  modeOptionActive: {
    backgroundColor: '#2a2a2a',
  },
  modeOptionAuto: {
    backgroundColor: 'rgba(245,158,11,0.2)',
  },
  modeText: {
    color: '#555',
    fontSize: 11,
    fontWeight: '600',
  },
  modeTextActive: {
    color: '#ccc',
  },
  modeTextAuto: {
    color: '#f59e0b',
  },
  // Tab bar
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
    gap: 4,
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
  tabBadgeCircle: {
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: '#2a2a2a',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 5,
  },
  tabBadgeCircleActive: {
    backgroundColor: '#fff',
  },
  tabBadgeText: {
    color: '#666',
    fontSize: 10,
    fontWeight: '700',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  tabBadgeTextActive: {
    color: '#000',
  },
  tabStats: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 6,
    paddingRight: 8,
  },
  tabStatText: {
    color: '#444',
    fontSize: 10,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  tabContextBar: {
    width: 30,
    height: 2,
    backgroundColor: '#1f1f1f',
    borderRadius: 1,
    overflow: 'hidden',
  },
  contextFill: {
    height: '100%',
    borderRadius: 2,
  },
  // Main
  main: {
    flex: 1,
  },
  tabPage: {
    width: SCREEN_WIDTH,
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
  loadMoreBtn: {
    alignSelf: 'center',
    paddingVertical: 8,
    paddingHorizontal: 16,
    marginBottom: 12,
  },
  loadMoreText: {
    color: '#666',
    fontSize: 13,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyText: {
    color: '#555',
    fontSize: 14,
  },
  // Permission card
  permissionCard: {
    backgroundColor: '#141414',
    borderRadius: 8,
    padding: 16,
    marginVertical: 8,
    borderWidth: 1,
    borderColor: '#2a2a2a',
  },
  permissionTitle: {
    color: '#fafafa',
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 8,
  },
  permissionToolName: {
    color: '#e5e5e5',
    fontSize: 13,
    fontWeight: '500',
    marginBottom: 8,
  },
  permissionInput: {
    marginBottom: 12,
  },
  permissionButtons: {
    flexDirection: 'row',
    gap: 12,
  },
  denyButton: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 6,
    alignItems: 'center',
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: '#333',
  },
  denyText: {
    color: '#888',
    fontWeight: '500',
    fontSize: 14,
  },
  allowButton: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 6,
    alignItems: 'center',
    backgroundColor: '#fff',
  },
  allowText: {
    color: '#000',
    fontWeight: '600',
    fontSize: 14,
  },
  // Diff view
  diffScroll: {
    maxHeight: 300,
    borderRadius: 6,
    backgroundColor: '#0f0f0f',
    padding: 8,
  },
  diffHeader: {
    color: '#666',
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    marginBottom: 8,
  },
  diffLineRemoved: {
    flexDirection: 'row',
    backgroundColor: 'rgba(239,68,68,0.08)',
    paddingVertical: 1,
    paddingHorizontal: 4,
  },
  diffLineAdded: {
    flexDirection: 'row',
    backgroundColor: 'rgba(34,197,94,0.08)',
    paddingVertical: 1,
    paddingHorizontal: 4,
  },
  diffPrefix: {
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    lineHeight: 16,
    width: 14,
    color: '#888',
  },
  diffTextRemoved: {
    color: '#ef4444',
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    lineHeight: 16,
    flex: 1,
  },
  diffTextAdded: {
    color: '#22c55e',
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    lineHeight: 16,
    flex: 1,
  },
  // Back chevron
  arrowContainer: {
    width: 16,
    height: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  arrowChevron: {
    width: 10,
    height: 10,
    borderLeftWidth: 2,
    borderBottomWidth: 2,
    borderColor: '#888',
    transform: [{ rotate: '45deg' }],
    marginLeft: 3,
  },
  // Voice overlay
  voiceOverlay: {
    backgroundColor: '#0a0a0a',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.1)',
  },
  voiceOverlaySafeArea: {
    paddingBottom: 34,
  },
  voiceHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  voiceLabel: {
    color: '#888',
    fontSize: 13,
    flex: 1,
    marginRight: 12,
  },
  voiceProjectName: {
    color: '#17c6b2',
    fontWeight: '500',
  },
  voiceGitText: {
    color: '#5fa2f9',
    fontWeight: '500',
  },
  voiceBranchName: {
    color: '#ec605f',
    fontWeight: '500',
  },
  voiceCancelText: {
    color: '#ef4444',
    fontSize: 13,
    fontWeight: '500',
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
  voiceListeningStatusText: {
    color: '#777',
    fontSize: 12,
    fontWeight: '500',
  },
  voiceSendBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  voiceSendBtnActive: {
    backgroundColor: '#fff',
  },
  voiceSendIcon: {
    width: 18,
    height: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  voiceArrowStem: {
    width: 2.5,
    height: 10,
    borderRadius: 1,
    marginTop: 4,
  },
  voiceArrowHead: {
    position: 'absolute',
    top: 0,
    width: 0,
    height: 0,
    borderLeftWidth: 5,
    borderRightWidth: 5,
    borderBottomWidth: 6,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
  },
});

const plusModalStyles = StyleSheet.create({
  scrollList: {
    maxHeight: 400,
  },
  list: {
    paddingBottom: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 16,
    gap: 12,
  },
  icon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.06)',
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
  description: {
    color: '#666',
    fontSize: 12,
    marginTop: 2,
  },
  emptyText: {
    color: '#555',
    fontSize: 14,
    textAlign: 'center',
    paddingVertical: 20,
  },
});
