import React, { useCallback, useEffect, useRef, useMemo, useState } from 'react';
import {
  View,
  Text,
  Image,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Platform,
  Animated,
  Alert,
  type ViewStyle,
} from 'react-native';
import Svg, { Path, Rect, Line } from 'react-native-svg';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { useSettings } from '../state/SettingsContext';
import type { AgentState, AgentStatus, AgentType, AgentMessage, ContentBlock, Project } from '../state/types';

export type CardLayout = 'full' | 'grid' | 'page';

interface AgentCardProps {
  agent: AgentState;
  projects?: Project[];
  onPress: () => void;
  onLongPress: () => void;
  onDestroy?: () => void;
  onChat?: () => void;
  onVoice?: () => void;
  layout?: CardLayout;
}


// --- Status config ---

const STATUS_COLORS: Record<AgentStatus, string> = {
  starting: '#f59e0b',
  connected: '#22c55e',
  idle: '#6b7280',
  running: '#3b82f6',
  awaiting_permission: '#f59e0b',
  error: '#ef4444',
  exited: '#4b5563',
};

const STATUS_LABELS: Record<AgentStatus, string> = {
  starting: 'Starting',
  connected: 'Connected',
  idle: 'Idle',
  running: 'Running',
  awaiting_permission: 'Needs input',
  error: 'Error',
  exited: 'Exited',
};

// Format raw model ID to display name
// e.g. "claude-opus-4-6-20250801" → "Claude Opus 4.6"
// e.g. "claude-sonnet-4-5-20250929" → "Claude Sonnet 4.5"
function formatModelName(model: string | null, type: AgentType): string {
  if (!model) {
    return type.charAt(0).toUpperCase() + type.slice(1);
  }

  // Try to parse Claude model IDs
  const claudeMatch = model.match(/^claude-(\w+)-(\d+)-(\d+)/);
  if (claudeMatch) {
    const variant = claudeMatch[1].charAt(0).toUpperCase() + claudeMatch[1].slice(1);
    return `Claude ${variant} ${claudeMatch[2]}.${claudeMatch[3]}`;
  }

  // Fallback: capitalize first letter, truncate long IDs
  if (model.length > 30) return model.slice(0, 30) + '...';
  return model;
}

function extractMessageBody(msg: AgentMessage): string {
  if (msg.type === 'user') {
    return typeof msg.content === 'string' ? msg.content : '';
  }
  if (msg.type === 'assistant') {
    const parts: string[] = [];
    if (typeof msg.content === 'string') {
      parts.push(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const b of msg.content as ContentBlock[]) {
        if (b.type === 'text' && 'text' in b) {
          parts.push(b.text);
        } else if (b.type === 'tool_use' && 'name' in b) {
          parts.push(`\x00${b.name}`);
        }
      }
    }
    return parts.join('\n');
  }
  return '';
}

interface PreviewLine {
  text: string;
  isHeader: boolean;
  isToolUse?: boolean;
}

const CARD_MESSAGE_WINDOW = 30;

function buildTerminalPreview(messages: AgentMessage[], maxMessages: number): PreviewLine[] {
  const startIdx = Math.max(0, messages.length - maxMessages);
  const lines: PreviewLine[] = [];
  let prevType: string | null = null;
  for (let i = startIdx; i < messages.length; i++) {
    const msg = messages[i];
    const body = extractMessageBody(msg);
    if (!body) continue;
    // Only show header when the sender changes
    if (msg.type !== prevType) {
      const header = msg.type === 'user' ? '❯ You' : '❯ Assistant';
      lines.push({ text: header, isHeader: true });
      prevType = msg.type;
    }
    const bodyLines = body.split('\n').filter(l => l.trim());
    for (const line of bodyLines) {
      if (line.startsWith('\x00')) {
        lines.push({ text: line.slice(1), isHeader: false, isToolUse: true });
      } else {
        lines.push({ text: line, isHeader: false });
      }
    }
  }
  return lines;
}

// Animated pulsing dot for active statuses
function StatusDot({ status, size = 6 }: { status: AgentStatus; size?: number }) {
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const isActive = status === 'running' || status === 'starting';

  useEffect(() => {
    if (isActive) {
      const animation = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 0.3, duration: 800, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 800, useNativeDriver: true }),
        ]),
      );
      animation.start();
      return () => animation.stop();
    } else {
      pulseAnim.setValue(1);
      return undefined;
    }
  }, [isActive, pulseAnim]);

  return (
    <Animated.View
      style={[
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: STATUS_COLORS[status],
          opacity: pulseAnim,
        },
      ]}
    />
  );
}

// Pulsing placeholder shown while the agent is loading (no model icon needed)
function PulsingIcon({ size = 28 }: { size?: number }) {
  const opacity = useRef(new Animated.Value(0.08)).current;

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.18, duration: 1000, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.08, duration: 1000, useNativeDriver: true }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [opacity]);

  return (
    <Animated.View
      style={[styles.agentIcon, { width: size, height: size, backgroundColor: '#fff', opacity, marginRight: 8 }]}
    />
  );
}

// Chevron arrow for "Open" button
function ChevronRight({ size = 12, color = '#555' }: { size?: number; color?: string }) {
  return (
    <View style={{ width: size, height: size, justifyContent: 'center', alignItems: 'center' }}>
      <View style={{
        width: size * 0.5,
        height: size * 0.5,
        borderRightWidth: 1.5,
        borderBottomWidth: 1.5,
        borderColor: color,
        transform: [{ rotate: '-45deg' }],
        marginLeft: -size * 0.15,
      }} />
    </View>
  );
}

// Keyboard icon for text message button
function KeyboardIcon({ size = 14, color = '#666' }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size * 0.75} viewBox="0 0 24 18" fill="none">
      <Rect x={1} y={1} width={22} height={16} rx={2} stroke={color} strokeWidth={1.5} fill="none" />
      <Rect x={4} y={4} width={2} height={2} rx={0.5} fill={color} />
      <Rect x={8} y={4} width={2} height={2} rx={0.5} fill={color} />
      <Rect x={12} y={4} width={2} height={2} rx={0.5} fill={color} />
      <Rect x={16} y={4} width={4} height={2} rx={0.5} fill={color} />
      <Rect x={4} y={8} width={2} height={2} rx={0.5} fill={color} />
      <Rect x={8} y={8} width={2} height={2} rx={0.5} fill={color} />
      <Rect x={12} y={8} width={2} height={2} rx={0.5} fill={color} />
      <Rect x={16} y={8} width={4} height={2} rx={0.5} fill={color} />
      <Rect x={6} y={12} width={12} height={2} rx={0.5} fill={color} />
    </Svg>
  );
}

// Microphone icon for voice input button
function MicIcon({ size = 14, color = '#666' }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M12 2a3.5 3.5 0 00-3.5 3.5v5a3.5 3.5 0 007 0v-5A3.5 3.5 0 0012 2z"
        fill={color}
      />
      <Path
        d="M19 10v1a7 7 0 01-14 0v-1"
        stroke={color}
        strokeWidth={1.8}
        strokeLinecap="round"
      />
      <Line x1={12} y1={18} x2={12} y2={22} stroke={color} strokeWidth={1.8} strokeLinecap="round" />
      <Line x1={9} y1={22} x2={15} y2={22} stroke={color} strokeWidth={1.8} strokeLinecap="round" />
    </Svg>
  );
}

export function AgentCard({ agent, projects, onPress, onLongPress, onDestroy, onChat, onVoice, layout = 'grid' }: AgentCardProps) {
  const isFull = layout === 'full' || layout === 'page';
  const scrollRef = useRef<ScrollView>(null);
  const [bodyHeight, setBodyHeight] = useState(0);
  const [showMenu, setShowMenu] = useState(false);
  const hasPermission = agent.pendingPermissions.size > 0;
  const statusColor = STATUS_COLORS[agent.status];
  const { settings } = useSettings();

  const modelDisplayName = useMemo(
    () => formatModelName(agent.model, agent.type),
    [agent.model, agent.type],
  );

  // Build terminal content preview from the same messages array the detail screen uses.
  // Single source of truth — last N messages, no content truncation.
  const terminalLines = useMemo(() => {
    return buildTerminalPreview(agent.messages, isFull ? CARD_MESSAGE_WINDOW : 4);
  }, [isFull, agent.messages]);

  // Auto-scroll to bottom when content changes
  useEffect(() => {
    if (isFull && scrollRef.current) {
      scrollRef.current.scrollToEnd({ animated: false });
    }
  }, [isFull, terminalLines]);

  const useGlass = isLiquidGlassAvailable();
  const cardStyle: ViewStyle[] = [useGlass ? styles.cardGlass : styles.card];
  if (layout === 'page') {
    cardStyle.push(styles.cardPage);
  } else if (isFull) {
    cardStyle.push(styles.cardFull);
  }

  // Show project favicon if available, otherwise fall back to agent type icon
  const { cwd: agentCwd, projectName: agentProjectName } = agent;
  const matchedProject = useMemo(() => {
    if (!projects?.length) return null;
    // Match by cwd against project path and worktree paths
    if (agentCwd) {
      for (const p of projects) {
        if (agentCwd === p.path) return p;
        if (p.worktrees?.some(wt => agentCwd === wt.path)) return p;
      }
    }
    // Fallback: match by projectName — worktree dirs use the pattern "project--branch"
    // so also check if projectName starts with the project name
    if (agentProjectName) {
      return projects.find(p =>
        p.name === agentProjectName ||
        agentProjectName.startsWith(p.name + '--')
      ) || null;
    }
    return null;
  }, [agentCwd, agentProjectName, projects]);

  const iconSize = isFull ? 32 : 28;
  const [iconLoaded, setIconLoaded] = useState(false);
  const projectIconUrl = matchedProject?.icon || null;

  // Reset loaded state when the icon URL changes
  useEffect(() => {
    setIconLoaded(false);
  }, [projectIconUrl]);

  const iconElement = projectIconUrl ? (
    <View style={{ width: iconSize, height: iconSize, marginRight: 8 }}>
      {!iconLoaded && <PulsingIcon size={iconSize} />}
      <Image
        source={{ uri: projectIconUrl }}
        style={[
          { width: iconSize, height: iconSize, borderRadius: iconSize * 0.22 },
          !iconLoaded && { position: 'absolute', opacity: 0 },
        ]}
        onLoad={() => setIconLoaded(true)}
      />
    </View>
  ) : matchedProject ? (
    <View style={[styles.agentIcon, { width: iconSize, height: iconSize, backgroundColor: 'rgba(255,255,255,0.06)' }]}>
      <Text style={[styles.agentIconLetter, { color: '#888', fontSize: iconSize * 0.48 }]}>
        {matchedProject.name.charAt(0).toUpperCase()}
      </Text>
    </View>
  ) : (
    <PulsingIcon size={iconSize} />
  );

  const headerContent = (
    <View style={styles.header}>
      {iconElement}
      <View style={styles.headerInfo}>
        <Text style={[styles.modelName, isFull && styles.modelNameFull]} numberOfLines={1}>
          {modelDisplayName}
        </Text>
        <View style={styles.statusRow}>
          <StatusDot status={agent.status} size={isFull ? 7 : 6} />
          <Text style={[styles.statusText, { color: statusColor }, isFull && styles.statusTextFull]}>
            {STATUS_LABELS[agent.status]}
          </Text>
          {agent.projectName && (
            <>
              <View style={styles.statusSeparator} />
              <Text style={[styles.cwdText, isFull && styles.cwdTextFull]} numberOfLines={1}>
                <Text style={settings.colorfulGitLabels ? styles.cwdProjectName : undefined}>{agent.projectName}</Text>
                {agent.gitBranch ? (
                  <Text style={settings.colorfulGitLabels ? styles.cwdGit : undefined}> git:(<Text style={settings.colorfulGitLabels ? styles.cwdBranchName : undefined}>{agent.gitBranch}</Text>)</Text>
                ) : null}
              </Text>
            </>
          )}
        </View>
      </View>
    </View>
  );

  const permissionBanner = hasPermission ? (
    <View style={styles.permissionBanner}>
      <Text style={styles.permissionDot}>●</Text>
      <Text style={styles.permissionText}>Permission needed</Text>
    </View>
  ) : null;

  const handleBodyLayout = useCallback((e: { nativeEvent: { layout: { height: number } } }) => {
    const h = e.nativeEvent.layout.height;
    if (h > 0 && h !== bodyHeight) setBodyHeight(h);
  }, [bodyHeight]);

  const renderLine = (line: PreviewLine, i: number) => (
    <Text key={i}>
      {i > 0 ? '\n' : ''}
      {line.isToolUse ? (
        <Text><Text style={styles.previewHeader}>❯ </Text>{line.text}</Text>
      ) : (
        <Text style={line.isHeader ? styles.previewHeader : undefined}>{line.text}</Text>
      )}
    </Text>
  );

  const terminalTextElement = terminalLines.length > 0 ? (
    <Text style={[styles.previewText, isFull && styles.previewTextFull]}>
      {terminalLines.map(renderLine)}
    </Text>
  ) : null;

  const bodyContent = terminalTextElement ? (
    isFull ? (
      <ScrollView
        ref={scrollRef}
        style={bodyHeight > 0 ? { maxHeight: bodyHeight } : styles.terminalScroll}
        showsVerticalScrollIndicator={false}
        nestedScrollEnabled
      >
        {terminalTextElement}
      </ScrollView>
    ) : (
      <Text style={styles.previewText} numberOfLines={4}>
        {terminalLines.map(renderLine)}
      </Text>
    )
  ) : (
    <Text style={[styles.emptyText, isFull && styles.emptyTextFull]}>
      {agent.status === 'idle' ? 'Waiting for prompt...' :
       agent.status === 'starting' ? 'Starting...' :
       agent.status === 'exited' ? 'Session ended' : ''}
    </Text>
  );

  const handleDestroyPress = useCallback(() => {
    setShowMenu(false);
    Alert.alert(
      'Remove Agent',
      `End "${agent.sessionName}"? This will terminate the agent process.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: onDestroy },
      ],
    );
  }, [agent.sessionName, onDestroy]);

  const footerContent = (
    <View style={styles.footer}>
      <View style={styles.footerLeft}>
        {isFull && onDestroy ? (
          <View>
            <TouchableOpacity
              style={styles.ellipsisBtn}
              onPress={() => setShowMenu(prev => !prev)}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Text style={styles.ellipsisText}>···</Text>
            </TouchableOpacity>
            {showMenu && (
              <View style={styles.menuDropdown}>
                <TouchableOpacity style={styles.menuItem} onPress={handleDestroyPress}>
                  <Text style={styles.menuItemDestructive}>Remove agent</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        ) : (
          <>
            {agent.contextUsedPercent > 0 && (
              <View style={[styles.contextBar, isFull && styles.contextBarFull]}>
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
            {agent.totalCost > 0 && (
              <Text style={styles.costText}>${agent.totalCost.toFixed(2)}</Text>
            )}
          </>
        )}
      </View>
      <View style={styles.footerRight}>
        <TouchableOpacity
          style={styles.iconButton}
          onPress={() => onChat ? onChat() : onPress()}
          activeOpacity={0.6}
          hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
        >
          <KeyboardIcon size={16} color="#666" />
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.iconButton}
          onPress={() => onVoice?.()}
          activeOpacity={0.6}
          hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
        >
          <MicIcon size={16} color="#666" />
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.openButton}
          onPress={onPress}
          activeOpacity={0.6}
          hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
        >
          <Text style={styles.openButtonText}>Open</Text>
          <ChevronRight size={10} color="#666" />
        </TouchableOpacity>
      </View>
    </View>
  );

  const CardContainer = useGlass ? GlassView : View;

  // Full mode: no gesture wrappers around ScrollView — scrolling is reliable.
  if (isFull) {
    return (
      <CardContainer style={cardStyle}>
        {headerContent}
        {permissionBanner}

        <View style={styles.body} onLayout={handleBodyLayout}>{bodyContent}</View>
        {footerContent}
      </CardContainer>
    );
  }

  // Grid mode: header + body tappable (no scrolling), footer separate for message button
  return (
    <CardContainer style={cardStyle}>
      <TouchableOpacity style={styles.cardTappable} onPress={onPress} onLongPress={onLongPress} activeOpacity={0.7} delayLongPress={500}>
        {headerContent}
        {permissionBanner}

        <View style={styles.body}>{bodyContent}</View>
      </TouchableOpacity>
      {footerContent}
    </CardContainer>
  );
}

// "New Agent" card (for grid layout)
export function NewAgentCard({ onPress }: { onPress: () => void }) {
  return (
    <TouchableOpacity style={[styles.card, styles.newCard]} onPress={onPress} activeOpacity={0.7}>
      <View style={styles.newCardContent}>
        <View style={styles.plusCircle}>
          <View style={styles.plusH} />
          <View style={styles.plusV} />
        </View>
        <Text style={styles.newCardText}>New Agent</Text>
      </View>
    </TouchableOpacity>
  );
}

// Compact "New Agent" button (for single-column layout)
export function NewAgentButton({ onPress }: { onPress: () => void }) {
  return (
    <TouchableOpacity style={styles.newButton} onPress={onPress} activeOpacity={0.7}>
      <View style={styles.newButtonPlusCircle}>
        <View style={styles.plusH} />
        <View style={styles.plusV} />
      </View>
      <Text style={styles.newButtonText}>New Agent</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  // --- Card base ---
  card: {
    flex: 1,
    minHeight: 180,
    backgroundColor: '#141414',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#1f1f1f',
    padding: 12,
    margin: 4,
    justifyContent: 'space-between',
    overflow: 'hidden',
  },
  cardGlass: {
    flex: 1,
    minHeight: 180,
    borderRadius: 14,
    padding: 12,
    margin: 4,
    justifyContent: 'space-between',
    overflow: 'hidden',
  },
  cardFull: {
    minHeight: 0,
    padding: 16,
    margin: 0,
    marginBottom: 0,
  },
  cardPage: {
    flex: 1,
    minHeight: 0,
    padding: 14,
    margin: 0,
    marginBottom: 6,
  },
  cardTappable: {
    flex: 1,
  },
  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
  },
  agentIcon: {
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 8,
  },
  agentIconLetter: {
    fontSize: 14,
    fontWeight: '700',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  headerInfo: {
    flex: 1,
    justifyContent: 'center',
  },
  modelName: {
    color: '#e5e5e5',
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 2,
  },
  modelNameFull: {
    fontSize: 16,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  statusText: {
    fontSize: 10,
    fontWeight: '500',
  },
  statusTextFull: {
    fontSize: 11,
  },
  statusSeparator: {
    width: 3,
    height: 3,
    borderRadius: 1.5,
    backgroundColor: '#333',
    marginHorizontal: 2,
  },
  cwdText: {
    color: '#555',
    fontSize: 10,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    flex: 1,
  },
  cwdTextFull: {
    fontSize: 11,
  },
  cwdProjectName: {
    color: '#17c6b2',
  },
  cwdGit: {
    color: '#5fa2f9',
  },
  cwdBranchName: {
    color: '#ec605f',
  },
  // Icon buttons (keyboard, mic)
  iconButton: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  // Open button
  openButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  openButtonText: {
    color: '#666',
    fontSize: 11,
    fontWeight: '500',
  },
  // Permission banner
  permissionBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(245,158,11,0.1)',
    borderRadius: 6,
    paddingVertical: 5,
    paddingHorizontal: 8,
    marginBottom: 6,
    gap: 5,
  },
  permissionDot: {
    color: '#f59e0b',
    fontSize: 6,
  },
  permissionText: {
    color: '#f59e0b',
    fontSize: 11,
    fontWeight: '500',
  },
  // Body
  body: {
    flex: 1,
    marginBottom: 8,
    overflow: 'hidden',
  },
  terminalScroll: {
    flex: 1,
  },
  previewText: {
    color: '#777',
    fontSize: 10,
    lineHeight: 15,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  previewTextFull: {
    fontSize: 11,
    lineHeight: 17,
  },
  previewHeader: {
    color: '#e5e5e5',
    fontWeight: '600',
  },
  emptyText: {
    color: '#3a3a3a',
    fontSize: 11,
    fontStyle: 'italic',
  },
  emptyTextFull: {
    fontSize: 12,
  },
  // Footer
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#1f1f1f',
    paddingTop: 8,
  },
  footerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    gap: 8,
  },
  costText: {
    color: '#4a4a4a',
    fontSize: 10,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  footerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  // Ellipsis menu
  ellipsisBtn: {
    paddingVertical: 4,
    paddingHorizontal: 6,
  },
  ellipsisText: {
    color: '#555',
    fontSize: 16,
    fontWeight: '600',
    letterSpacing: 1,
  },
  menuDropdown: {
    position: 'absolute',
    bottom: '100%',
    left: 0,
    backgroundColor: '#1f1f1f',
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#333',
    marginBottom: 4,
    minWidth: 140,
    overflow: 'hidden',
  },
  menuItem: {
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  menuItemDestructive: {
    color: '#ef4444',
    fontSize: 13,
    fontWeight: '500',
  },
  contextBar: {
    width: 28,
    height: 3,
    backgroundColor: '#1f1f1f',
    borderRadius: 2,
    overflow: 'hidden',
  },
  contextBarFull: {
    width: 40,
    height: 4,
  },
  contextFill: {
    height: '100%',
    borderRadius: 2,
  },
  // New card (grid layout)
  newCard: {
    borderStyle: 'dashed',
    borderColor: '#252525',
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#0f0f0f',
  },
  newCardContent: {
    alignItems: 'center',
    gap: 10,
  },
  plusCircle: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.04)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  plusH: {
    position: 'absolute',
    width: 16,
    height: 1.5,
    backgroundColor: '#444',
    borderRadius: 1,
  },
  plusV: {
    position: 'absolute',
    width: 1.5,
    height: 16,
    backgroundColor: '#444',
    borderRadius: 1,
  },
  newCardText: {
    color: '#444',
    fontSize: 13,
    fontWeight: '500',
  },
  // New button (single-column layout)
  newButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#141414',
    borderRadius: 12,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: '#252525',
    paddingVertical: 14,
    gap: 10,
  },
  newButtonPlusCircle: {
    width: 24,
    height: 24,
    borderRadius: 7,
    backgroundColor: 'rgba(255,255,255,0.04)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  newButtonText: {
    color: '#444',
    fontSize: 14,
    fontWeight: '500',
  },
});
