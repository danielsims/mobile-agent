import React, { useCallback, useState, useEffect, useMemo, useRef } from 'react';
import {
  View,
  Text,
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
import type { AgentMessage, AgentType, Project } from '../state/types';
import { KeyboardScrollView } from './KeyboardScrollView';
import { MessageBubble, buildToolResultMap } from './MessageBubble';
import { InputBar } from './InputBar';
import { CodeBlock } from './CodeBlock';

// Claude logo SVG path (shared with AgentCard)
const CLAUDE_LOGO_PATH = 'M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z';

const SCREEN_WIDTH = Dimensions.get('window').width;
const SWIPE_THRESHOLD = SCREEN_WIDTH * 0.25;
const EDGE_WIDTH = 30; // pixels from left edge to start recognizing swipe

interface AgentDetailScreenProps {
  agentId: string;
  connectionStatus: ConnectionStatus;
  projects?: Project[];
  onBack: () => void;
  onSendMessage: (agentId: string, text: string) => void;
  onRespondPermission: (agentId: string, requestId: string, behavior: 'allow' | 'deny') => void;
  onSetAutoApprove?: (agentId: string, enabled: boolean) => void;
  onResetPingTimer: () => void;
}

function formatCost(cost: number): string {
  if (cost === 0) return '$0.00';
  if (cost < 0.01) return '<$0.01';
  return `$${cost.toFixed(2)}`;
}

function formatTokens(tokens: number): string {
  if (tokens === 0) return '0';
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return String(tokens);
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
    claude:   { color: '#D97757', bg: 'rgba(217,119,87,0.15)', letter: 'C' },
    codex:    { color: '#10A37F', bg: 'rgba(16,163,127,0.15)', letter: 'X' },
    opencode: { color: '#3B82F6', bg: 'rgba(59,130,246,0.15)', letter: 'O' },
  };
  const brand = BRAND[type] || { color: '#888', bg: 'rgba(136,136,136,0.15)', letter: '?' };
  const iconSize = size * 0.58;

  return (
    <View style={[styles.agentIcon, { width: size, height: size, backgroundColor: brand.bg }]}>
      {type === 'claude' ? (
        <Svg width={iconSize} height={iconSize} viewBox="0 0 24 24">
          <Path d={CLAUDE_LOGO_PATH} fill={brand.color} fillRule="nonzero" />
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
  onBack,
  onSendMessage,
  onRespondPermission,
  onSetAutoApprove,
  onResetPingTimer,
}: AgentDetailScreenProps) {
  const agent = useAgent(agentId);
  const { dispatch } = useAgentState();
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  // Swipe-from-left-edge to go back
  const swipeX = useRef(new Animated.Value(0)).current;
  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_evt, gesture) => {
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

  const handleDraftChange = useCallback((text: string) => {
    dispatch({ type: 'SET_DRAFT', agentId, text });
  }, [agentId, dispatch]);

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
  }, [agent?.cwd, agent?.projectName, projects]);

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

  // Build a global toolUseId → result map across ALL messages
  const toolResultMap = useMemo(
    () => buildToolResultMap(agent.messages),
    [agent.messages],
  );

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

        {/* Stats bar */}
        {(agent.totalCost > 0 || agent.outputTokens > 0) && (
          <View style={styles.statsBar}>
            <Text style={styles.statItem}>Cost: {formatCost(agent.totalCost)}</Text>
            <Text style={styles.statItem}>Tokens: {formatTokens(agent.outputTokens)}</Text>
            {agent.contextUsedPercent > 0 && (
              <View style={styles.contextStat}>
                <Text style={styles.statItem}>Context: {Math.round(agent.contextUsedPercent)}%</Text>
                <View style={styles.contextBarLarge}>
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
              </View>
            )}
          </View>
        )}

        {/* Chat */}
        <View style={[styles.main, keyboardHeight > 0 && { paddingBottom: keyboardHeight }]}>
          <KeyboardScrollView style={styles.chatArea} contentContainerStyle={styles.chatContent}>
            {agent.messages.length === 0 ? (
              <Text style={styles.placeholder}>Send a message to start...</Text>
            ) : (
              agent.messages.map((msg) => (
                <MessageBubble key={msg.id} message={msg} toolResultMap={toolResultMap} />
              ))
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

          <InputBar
            onSend={handleSend}
            disabled={isDisabled || permissions.length > 0}
            placeholder={agent.status === 'running' ? 'Agent is working...' : 'Ask anything...'}
            onActivity={onResetPingTimer}
            initialValue={agent.draftText}
            onDraftChange={handleDraftChange}
          />
        </View>
      </Animated.View>
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
    paddingTop: 4,
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
  // Stats bar
  statsBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 6,
    backgroundColor: '#0f0f0f',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#1a1a1a',
    gap: 16,
  },
  statItem: {
    color: '#555',
    fontSize: 11,
  },
  contextStat: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  contextBarLarge: {
    width: 40,
    height: 3,
    backgroundColor: '#1f1f1f',
    borderRadius: 2,
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
});
