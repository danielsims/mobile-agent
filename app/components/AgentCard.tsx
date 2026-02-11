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

// --- Agent type branding ---

const AGENT_BRAND: Record<string, { color: string; bg: string; fallbackLetter: string }> = {
  claude:   { color: '#D97757', bg: '#FFFFFF', fallbackLetter: 'C' },
  codex:    { color: '#111111', bg: '#FFFFFF', fallbackLetter: 'X' },
  opencode: { color: '#3B82F6', bg: '#FFFFFF', fallbackLetter: 'O' },
};

function getAgentBrand(type: AgentType) {
  return AGENT_BRAND[type] || { color: '#888', bg: 'rgba(136,136,136,0.15)', fallbackLetter: type[0]?.toUpperCase() || '?' };
}

// SVG path data for agent type logos
const CLAUDE_LOGO_PATH = 'M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z';
const OPENAI_LOGO_PATH = 'M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z';

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

// Agent type icon — SVG logo or colored letter fallback
function AgentIcon({ type, size = 28 }: { type: AgentType; size?: number }) {
  const brand = getAgentBrand(type);
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
          {brand.fallbackLetter}
        </Text>
      )}
    </View>
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
  const matchedProject = useMemo(() => {
    if (!projects?.length) return null;
    // Match by cwd against project path and worktree paths
    if (agent.cwd) {
      for (const p of projects) {
        if (agent.cwd === p.path) return p;
        if (p.worktrees?.some(wt => agent.cwd === wt.path)) return p;
      }
    }
    // Fallback: match by projectName (handles main worktree case)
    if (agent.projectName) {
      return projects.find(p => p.name === agent.projectName) || null;
    }
    return null;
  }, [agent.cwd, agent.projectName, projects]);

  const iconSize = isFull ? 32 : 28;
  const iconElement = matchedProject ? (
    matchedProject.icon ? (
      <Image
        source={{ uri: matchedProject.icon }}
        style={{ width: iconSize, height: iconSize, borderRadius: iconSize * 0.22, marginRight: 8 }}
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
