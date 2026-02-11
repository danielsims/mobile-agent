import React, { useState } from 'react';
import { View, Text, ScrollView, StyleSheet, Platform, TouchableOpacity } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { StreamdownRN } from 'streamdown-rn';
import type { AgentMessage, ContentBlock } from '../state/types';
import { ShimmerText } from './ShimmerText';

interface MessageBubbleProps {
  message: AgentMessage;
  toolResultMap?: Map<string, string>;
  animateThinking?: boolean;
}

// Extract markdown string from content blocks
function blocksToMarkdown(blocks: ContentBlock[]): string {
  return blocks
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n\n');
}

// Format tool name: "Read" → "Read", "Bash" → "Bash", "mcp__ide__getDiagnostics" → "getDiagnostics"
function formatToolName(name: string): string {
  if (name.includes('__')) {
    const parts = name.split('__');
    return parts[parts.length - 1];
  }
  return name;
}

// Minimal tool icon — two horizontal bars (terminal/code style)
function ToolIcon({ size = 11, color = '#666' }: { size?: number; color?: string }) {
  const barH = Math.max(1.5, size * 0.15);
  return (
    <View style={{ width: size, height: size, justifyContent: 'center', gap: size * 0.22 }}>
      <View style={{ width: size * 0.55, height: barH, backgroundColor: color, borderRadius: barH / 2 }} />
      <View style={{ width: size * 0.85, height: barH, backgroundColor: color, borderRadius: barH / 2 }} />
    </View>
  );
}

// Extract a short description from tool input for the card header.
// Checks common field names across tools (Bash, Read, Write, Grep, Glob, Task, etc.)
function extractToolDescription(input: Record<string, unknown>): string | null {
  const candidates = ['description', 'file_path', 'command', 'pattern', 'query', 'url', 'prompt', 'subject'];
  for (const key of candidates) {
    const val = input[key];
    if (typeof val === 'string' && val.length > 0) {
      // Trim to a reasonable header length
      return val.length > 80 ? val.slice(0, 80) + '...' : val;
    }
  }
  return null;
}

// Diff view for Edit tool — shows old_string/new_string as red/green lines
function DiffView({ filePath, oldStr, newStr }: { filePath?: string; oldStr: string; newStr: string }) {
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');

  return (
    <View>
      {filePath && (
        <Text style={styles.diffHeader} numberOfLines={1}>{filePath}</Text>
      )}
      {oldLines.map((line, i) => (
        <View key={`r${i}`} style={styles.diffLineRemoved}>
          <Text style={styles.diffPrefixRemoved}>-</Text>
          <Text style={styles.diffTextRemoved}>{line}</Text>
        </View>
      ))}
      {newLines.map((line, i) => (
        <View key={`a${i}`} style={styles.diffLineAdded}>
          <Text style={styles.diffPrefixAdded}>+</Text>
          <Text style={styles.diffTextAdded}>{line}</Text>
        </View>
      ))}
    </View>
  );
}

// Check if a tool_use block is an Edit with old_string/new_string
function isEditWithDiff(name: string, input: Record<string, unknown>): boolean {
  return name === 'Edit' && typeof input.old_string === 'string' && typeof input.new_string === 'string';
}

// Collapsible tool invocation card
function ToolUseCard({ block, result }: { block: ContentBlock & { type: 'tool_use' }; result?: string | null }) {
  const [expanded, setExpanded] = useState(false);
  const fallbackName = formatToolName(block.name);
  const title = extractToolDescription(block.input) || fallbackName;
  const isCompleted = result != null;

  return (
    <View style={styles.toolCard}>
      <TouchableOpacity
        style={styles.toolHeader}
        onPress={() => setExpanded(!expanded)}
        activeOpacity={0.7}
      >
        <View style={styles.toolHeaderLeft}>
          <ToolIcon size={11} color="#666" />
          <Text style={styles.toolName} numberOfLines={1}>{title}</Text>
          <View style={[styles.toolBadge, !isCompleted && styles.toolBadgeRunning]}>
            <View style={[styles.toolBadgeDot, !isCompleted && styles.toolBadgeDotRunning]} />
            <Text style={[styles.toolBadgeText, !isCompleted && styles.toolBadgeTextRunning]}>
              {isCompleted ? 'Completed' : 'Running'}
            </Text>
          </View>
        </View>
        <View style={[styles.toolChevronBox, expanded && styles.toolChevronBoxOpen]}>
          <View style={styles.toolChevronArrow} />
        </View>
      </TouchableOpacity>

      {expanded && (
        <View style={styles.toolBody}>
          {isEditWithDiff(block.name, block.input) ? (
            <>
              <Text style={styles.toolSectionLabel}>DIFF</Text>
              <ScrollView style={styles.toolCodeScroll} nestedScrollEnabled>
                <View style={styles.toolCodeBlock}>
                  <DiffView
                    filePath={typeof block.input.file_path === 'string' ? block.input.file_path : undefined}
                    oldStr={block.input.old_string as string}
                    newStr={block.input.new_string as string}
                  />
                </View>
              </ScrollView>
            </>
          ) : (
            <>
              <Text style={styles.toolSectionLabel}>INPUT</Text>
              <ScrollView style={styles.toolCodeScroll} nestedScrollEnabled>
                <View style={styles.toolCodeBlock}>
                  <Text style={styles.toolCodeText}>
                    {JSON.stringify(block.input, null, 2)}
                  </Text>
                </View>
              </ScrollView>
            </>
          )}
          {result != null && (
            <>
              <Text style={[styles.toolSectionLabel, { marginTop: 10 }]}>OUTPUT</Text>
              <ScrollView style={styles.toolCodeScroll} nestedScrollEnabled>
                <View style={styles.toolCodeBlock}>
                  <Text style={styles.toolCodeText}>
                    {result}
                  </Text>
                </View>
              </ScrollView>
            </>
          )}
        </View>
      )}
    </View>
  );
}

// Build a map from tool_use id → tool_result content string across all messages
export function buildToolResultMap(messages: AgentMessage[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const msg of messages) {
    if (typeof msg.content === 'string') continue;
    for (const b of msg.content) {
      if (b.type === 'tool_result') {
        const content = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
        map.set(b.toolUseId, content);
      }
    }
  }
  return map;
}

// Render a single ContentBlock (tool_result handled inline with tool_use)
function ContentBlockView({
  block,
  resultMap,
  animateThinking = false,
}: {
  block: ContentBlock;
  resultMap?: Map<string, string>;
  animateThinking?: boolean;
}) {
  const [expanded, setExpanded] = useState(block.type === 'thinking');

  switch (block.type) {
    case 'text':
      return null; // Text blocks are rendered together via StreamdownRN

    case 'tool_use': {
      const result = resultMap?.get(block.id) ?? null;
      return <ToolUseCard block={block as ContentBlock & { type: 'tool_use' }} result={result} />;
    }

    case 'tool_result':
      return null; // Rendered inline within the matching ToolUseCard

    case 'thinking':
      if (!block.text || !block.text.trim()) return null;
      return (
        <View style={styles.thinkingContainer}>
          <TouchableOpacity
            style={styles.thinkingHeader}
            onPress={() => setExpanded(!expanded)}
            activeOpacity={0.7}
          >
            {animateThinking ? (
              <ShimmerText text="Thinking" style={styles.thinkingLabel} duration={1700} />
            ) : (
              <Text style={styles.thinkingLabelStatic}>Thinking</Text>
            )}
            <MaterialIcons
              name="expand-more"
              size={16}
              color="#6f6f6f"
              style={[styles.thinkingChevron, expanded && styles.thinkingChevronOpen]}
            />
          </TouchableOpacity>
          {expanded && <Text style={styles.thinkingText}>{block.text}</Text>}
        </View>
      );

    default:
      return null;
  }
}

export function MessageBubble({ message, toolResultMap, animateThinking = false }: MessageBubbleProps) {
  const isUser = message.type === 'user';
  const isSystem = message.type === 'system';

  if (isSystem) {
    return (
      <View style={styles.systemContainer}>
        <Text style={styles.systemText}>
          {typeof message.content === 'string' ? message.content : ''}
        </Text>
      </View>
    );
  }

  // Content can be string (streaming) or ContentBlock[] (structured)
  const renderContent = () => {
    if (typeof message.content === 'string') {
      if (isUser) {
        return <Text style={styles.userText}>{message.content}</Text>;
      }
      // Assistant streaming text — render as markdown
      return (
        <View style={styles.bubble}>
          <StreamdownRN theme="dark">{message.content}</StreamdownRN>
        </View>
      );
    }

    // ContentBlock array — render text blocks as unified markdown,
    // non-text blocks (tool_use, thinking) as custom components
    const textMarkdown = blocksToMarkdown(message.content);
    const nonTextBlocks = message.content.filter((b) => {
      if (b.type === 'text' || b.type === 'tool_result') return false;
      if (b.type === 'thinking' && (!b.text || !b.text.trim())) return false;
      return true;
    });

    return (
      <View style={styles.bubble}>
        {textMarkdown.length > 0 && (
          <StreamdownRN theme="dark">{textMarkdown}</StreamdownRN>
        )}
        {nonTextBlocks.map((block, i) => (
          <ContentBlockView
            key={i}
            block={block}
            resultMap={toolResultMap}
            animateThinking={animateThinking}
          />
        ))}
      </View>
    );
  };

  return (
    <View style={styles.messageContainer}>
      <Text style={[styles.sender, isUser && styles.senderUser]}>
        {isUser ? 'You' : 'Assistant'}
      </Text>
      {renderContent()}
    </View>
  );
}

const styles = StyleSheet.create({
  messageContainer: {
    marginBottom: 16,
  },
  sender: {
    color: '#888',
    fontSize: 12,
    fontWeight: '500',
    marginBottom: 6,
  },
  senderUser: {
    color: '#888',
  },
  bubble: {},
  userText: {
    color: '#e5e5e5',
    fontSize: 15,
    lineHeight: 22,
  },
  systemContainer: {
    alignItems: 'center',
    marginVertical: 12,
  },
  systemText: {
    color: '#8e8e93',
    fontSize: 13,
    fontStyle: 'italic',
  },

  // --- Tool use card ---
  toolCard: {
    borderWidth: 1,
    borderColor: '#252525',
    borderRadius: 8,
    marginVertical: 6,
    overflow: 'hidden',
  },
  toolHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  toolHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
  },
  toolName: {
    color: '#ccc',
    fontSize: 13,
    fontWeight: '500',
    flexShrink: 1,
  },
  toolBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(34,197,94,0.1)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    gap: 5,
  },
  toolBadgeRunning: {
    backgroundColor: 'rgba(245,158,11,0.12)',
  },
  toolBadgeDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: '#22c55e',
  },
  toolBadgeDotRunning: {
    backgroundColor: '#f59e0b',
  },
  toolBadgeText: {
    color: '#22c55e',
    fontSize: 10,
    fontWeight: '500',
  },
  toolBadgeTextRunning: {
    color: '#f59e0b',
  },
  toolChevronBox: {
    width: 20,
    height: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  toolChevronBoxOpen: {
    transform: [{ rotate: '180deg' }],
  },
  toolChevronArrow: {
    width: 7,
    height: 7,
    borderRightWidth: 1.5,
    borderBottomWidth: 1.5,
    borderColor: '#555',
    transform: [{ rotate: '45deg' }],
    marginTop: -3,
  },
  toolBody: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#252525',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  toolSectionLabel: {
    color: '#555',
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 1,
    marginBottom: 8,
  },
  toolCodeScroll: {
    maxHeight: 500,
  },
  toolCodeBlock: {
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderRadius: 6,
    padding: 10,
  },
  toolCodeText: {
    color: '#888',
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    lineHeight: 16,
  },

  // --- Diff view ---
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
  diffPrefixRemoved: {
    color: '#ef4444',
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    lineHeight: 16,
    width: 14,
  },
  diffPrefixAdded: {
    color: '#22c55e',
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    lineHeight: 16,
    width: 14,
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

  // --- Thinking ---
  thinkingContainer: {
    marginVertical: 5,
  },
  thinkingHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
  },
  thinkingLabel: {
    color: '#888',
    fontSize: 12,
    fontWeight: '500',
  },
  thinkingLabelStatic: {
    color: '#888',
    fontSize: 12,
    fontWeight: '500',
  },
  thinkingChevron: {
    marginLeft: 2,
    marginRight: -1,
    marginTop: 1,
  },
  thinkingChevronOpen: {
    transform: [{ rotate: '180deg' }],
  },
  thinkingText: {
    color: '#9a9a9a',
    fontSize: 13,
    lineHeight: 20,
    marginTop: 8,
    marginLeft: 6,
    paddingLeft: 10,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: '#353535',
    fontStyle: 'italic',
  },
});
