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
} from 'react-native';
import Svg, { Path } from 'react-native-svg';
import * as Haptics from 'expo-haptics';
import { useAgentState } from '../state/AgentContext';
import { useSettings } from '../state/SettingsContext';
import { AgentCard } from './AgentCard';
import { FileTypeIcon } from './FileTypeIcon';
import { useSpeechRecognition } from '../hooks/useSpeechRecognition';
import type { Project, AgentState, AgentType } from '../state/types';

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
  onSelectAgent: (agentId: string) => void;
  onDestroyAgent?: (agentId: string) => void;
  onSendMessage?: (agentId: string, text: string) => void;
  gitDataMap: Map<string, AgentGitData>;
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

const AGENT_BRAND: Record<string, { color: string; bg: string; letter: string }> = {
  claude:   { color: '#D97757', bg: 'rgba(217,119,87,0.25)', letter: 'C' },
  codex:    { color: '#10A37F', bg: 'rgba(16,163,127,0.25)', letter: 'X' },
  opencode: { color: '#3B82F6', bg: 'rgba(59,130,246,0.25)', letter: 'O' },
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

export function GitScreen({ onBack, onRequestGitStatus, onSelectAgent, onDestroyAgent, onSendMessage, gitDataMap, loadingAgentIds, projects }: GitScreenProps) {
  const { state } = useAgentState();
  const { settings } = useSettings();
  const [expandedWorktree, setExpandedWorktree] = useState<string | null>(null);

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

  // Slide in from the LEFT
  const swipeX = useRef(new Animated.Value(-SCREEN_WIDTH)).current;

  useEffect(() => {
    Animated.timing(swipeX, {
      toValue: 0,
      duration: 250,
      useNativeDriver: true,
    }).start();
  }, [swipeX]);

  // Request git status for all agents on mount
  useEffect(() => {
    const agents = Array.from(state.agents.values());
    for (const agent of agents) {
      if (agent.cwd || agent.gitBranch) {
        onRequestGitStatus(agent.id);
      }
    }
  }, []); // Only on mount

  // Swipe from right edge to dismiss (slide back left)
  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_evt, gesture) => {
        return (
          gesture.x0 > SCREEN_WIDTH - EDGE_WIDTH &&
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

        <ScrollView style={styles.content} contentContainerStyle={styles.contentInner}>
          {projects.length === 0 ? (
            <View style={styles.emptyContainer}>
              <Text style={styles.emptyText}>No projects registered</Text>
              <Text style={styles.emptySubtext}>Register a project to see git status here</Text>
            </View>
          ) : (
            projects.map(project => (
              <View key={project.id} style={styles.projectSection}>
                <View style={styles.sectionHeader}>
                  <ProjectIcon project={project} />
                  <Text style={styles.sectionName}>{project.name}</Text>
                </View>

                {project.worktrees.map(wt => {
                  const agents = cwdToAgents.get(wt.path) || [];
                  const hasAgents = agents.length > 0;
                  // Use first agent for git data (all share the same worktree)
                  const primaryAgent = agents[0] || null;
                  const gitData = primaryAgent ? gitDataMap.get(primaryAgent.id) : null;
                  const isLoading = agents.some(a => loadingAgentIds.has(a.id));
                  const files = gitData?.files || [];
                  const isExpanded = expandedWorktree === wt.path;

                  return (
                    <View key={wt.path}>
                      <TouchableOpacity
                        style={[styles.worktreeRow, isExpanded && styles.worktreeRowExpanded]}
                        activeOpacity={hasAgents ? 0.7 : 1}
                        onPress={() => {
                          if (!hasAgents) return;
                          if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                          if (agents.length === 1) {
                            // Single agent: navigate directly
                            animateBack();
                            setTimeout(() => onSelectAgent(agents[0].id), 300);
                          } else {
                            // Multiple agents: toggle expanded space
                            setExpandedWorktree(isExpanded ? null : wt.path);
                          }
                        }}
                      >
                        <View style={[styles.branchDot, wt.isMain && styles.branchDotMain, !hasAgents && styles.branchDotInactive]} />
                        <Text style={[styles.branchName, !hasAgents && styles.branchNameInactive]} numberOfLines={1}>
                          {wt.branch}
                        </Text>
                        {wt.isMain && <Text style={styles.mainBadge}>main</Text>}
                        <View style={styles.worktreeRight}>
                          {hasAgents && <StackedAgentAvatars agents={agents} size={20} />}
                          {isLoading ? (
                            <ActivityIndicator color="#333" size="small" />
                          ) : hasAgents ? (
                            <Text style={styles.fileCountBadge}>
                              {files.length > 0 ? `${files.length} file${files.length !== 1 ? 's' : ''}` : 'clean'}
                            </Text>
                          ) : (
                            <Text style={styles.noAgentBadge}>no agent</Text>
                          )}
                        </View>
                      </TouchableOpacity>

                      {isExpanded && agents.length > 1 && (
                        <View style={styles.spaceContainer}>
                          <View style={agents.length <= 2 ? styles.spaceStack : styles.spaceGrid}>
                            {agents.map(agent => (
                              <View key={agent.id} style={agents.length <= 2 ? styles.spaceCardStacked : styles.spaceCardGrid}>
                                <AgentCard
                                  agent={agent}
                                  projects={projects}
                                  layout="page"
                                  onPress={() => {
                                    animateBack();
                                    setTimeout(() => onSelectAgent(agent.id), 300);
                                  }}
                                  onLongPress={() => {}}
                                  onDestroy={onDestroyAgent ? () => onDestroyAgent(agent.id) : undefined}
                                  onChat={onSendMessage ? () => handleChatOpen(agent.id) : undefined}
                                  onVoice={onSendMessage ? () => handleVoiceOpen(agent.id) : undefined}
                                />
                              </View>
                            ))}
                          </View>
                        </View>
                      )}

                      {!isExpanded && files.length > 0 && (
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
              </View>
            ))
          )}
        </ScrollView>

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
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a1a',
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
  branchDotMain: {
    backgroundColor: '#22c55e',
  },
  branchDotInactive: {
    backgroundColor: '#333',
  },
  branchName: {
    color: '#ccc',
    fontSize: 14,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    flex: 1,
  },
  branchNameInactive: {
    color: '#444',
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
  worktreeRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginLeft: 'auto',
  },
  agentAvatar: {
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: '#1a1a1a',
  },
  fileCountBadge: {
    color: '#555',
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  noAgentBadge: {
    color: '#333',
    fontSize: 11,
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
