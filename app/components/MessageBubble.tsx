import React, { useState } from 'react';
import { View, Text, ScrollView, StyleSheet, Platform, TouchableOpacity } from 'react-native';
import * as Haptics from 'expo-haptics';
import { StreamdownRN } from 'streamdown-rn';
import type { AgentMessage, ContentBlock } from '../state/types';
import { ShimmerText } from './ShimmerText';

interface MessageBubbleProps {
  message: AgentMessage;
  toolResultMap?: Map<string, string>;
  animateThinking?: boolean;
  pendingPermissionToolNames?: Set<string>;
  onRespondQuestion?: (answers: Record<string, string>, toolInput: Record<string, unknown>) => void;
  onDenyQuestion?: () => void;
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

// Shorten a file path to just filename or parent/filename
function shortPath(filePath: string): string {
  const parts = filePath.split('/').filter(Boolean);
  if (parts.length <= 2) return parts.join('/');
  return parts.slice(-2).join('/');
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + '\u2026' : str;
}

// Tool display config — maps tool names to label + title
function getToolDisplay(name: string, input: Record<string, unknown>): { label: string; title: string } {
  const str = (key: string) => typeof input[key] === 'string' ? input[key] as string : '';

  switch (name) {
    case 'Read':
      return { label: 'Read', title: shortPath(str('file_path')) };
    case 'Write':
      return { label: 'Write', title: shortPath(str('file_path')) };
    case 'Edit':
      return { label: 'Edit', title: shortPath(str('file_path')) };
    case 'Bash':
      return { label: 'Run', title: str('description') || truncate(str('command'), 60) };
    case 'Grep':
      return { label: 'Search', title: truncate(str('pattern'), 50) };
    case 'Glob':
      return { label: 'Find files', title: truncate(str('pattern'), 50) };
    case 'WebSearch':
      return { label: 'Web', title: truncate(str('query'), 60) };
    case 'WebFetch':
      return { label: 'Fetch', title: truncate(str('url'), 50) };
    case 'Task':
      return { label: 'Agent', title: str('description') || truncate(str('prompt') || 'Subagent', 50) };
    default: {
      const formatted = formatToolName(name);
      const candidates = ['description', 'file_path', 'command', 'pattern', 'query', 'url', 'prompt'];
      for (const key of candidates) {
        if (str(key)) return { label: formatted, title: truncate(str(key), 60) };
      }
      return { label: formatted, title: formatted };
    }
  }
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

// --- TodoWrite card: renders todo items as a checklist ---
function TodoWriteCard({ block }: { block: ContentBlock & { type: 'tool_use' } }) {
  const todos: Array<{ content: string; status: string; activeForm?: string }> =
    Array.isArray(block.input?.todos) ? (block.input.todos as Array<{ content: string; status: string; activeForm?: string }>) : [];

  if (todos.length === 0) return null;

  return (
    <View style={styles.todoCard}>
      <Text style={styles.todoTitle}>Tasks</Text>
      {todos.map((todo, i) => {
        const isComplete = todo.status === 'completed';
        const isActive = todo.status === 'in_progress';
        return (
          <View key={i} style={styles.todoRow}>
            <View style={[
              styles.todoCircle,
              isComplete && styles.todoCircleComplete,
            ]}>
              {isComplete && (
                <View style={styles.todoCheck}>
                  <View style={styles.todoCheckShort} />
                  <View style={styles.todoCheckLong} />
                </View>
              )}
            </View>
            <Text style={[
              styles.todoText,
              isComplete && styles.todoTextComplete,
              !isComplete && !isActive && styles.todoTextPending,
            ]} numberOfLines={2}>
              {isActive ? (todo.activeForm || todo.content) : todo.content}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

// --- AskUserQuestion card: renders question options as tappable buttons ---
// Interactive when pending (onRespond provided), read-only when answered.
function AskUserQuestionCard({
  block,
  result,
  onRespond,
  onDeny,
}: {
  block: ContentBlock & { type: 'tool_use' };
  result?: string | null;
  onRespond?: (answers: Record<string, string>) => void;
  onDeny?: () => void;
}) {
  const questions: Array<{
    question: string;
    header?: string;
    options: Array<{ label: string; description?: string }>;
    multiSelect?: boolean;
  }> = Array.isArray(block.input?.questions) ? (block.input.questions as any[]) : [];

  const [selections, setSelections] = useState<Record<number, Set<number>>>({});
  const [submitted, setSubmitted] = useState(false);
  const interactive = !!onRespond && !submitted;

  if (questions.length === 0) return null;

  // Parse the user's answer from the result string (for read-only mode)
  const answerText = result ?? '';

  const handleTapOption = (qi: number, oi: number, multiSelect?: boolean) => {
    if (!interactive) return;
    if (Platform.OS === 'ios') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    setSelections(prev => {
      const updated = { ...prev };
      if (multiSelect) {
        const current = new Set(prev[qi] || []);
        if (current.has(oi)) current.delete(oi);
        else current.add(oi);
        updated[qi] = current;
      } else {
        updated[qi] = new Set([oi]);
        const answers: Record<string, string> = {};
        questions.forEach((q, qIdx) => {
          const selected = qIdx === qi ? new Set([oi]) : (prev[qIdx] || new Set());
          const labels = Array.from(selected).map(idx => q.options[idx]?.label).filter(Boolean);
          if (labels.length > 0) {
            answers[q.question] = labels.join(', ');
          }
        });
        setSubmitted(true);
        setTimeout(() => {
          if (Platform.OS === 'ios') {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          }
          onRespond!(answers);
        }, 150);
      }
      return updated;
    });
  };

  const handleSubmitMulti = () => {
    if (!onRespond) return;
    const answers: Record<string, string> = {};
    questions.forEach((q, qi) => {
      const selected = selections[qi] || new Set();
      const labels = Array.from(selected).map(idx => q.options[idx]?.label).filter(Boolean);
      if (labels.length > 0) {
        answers[q.question] = labels.join(', ');
      }
    });
    if (Platform.OS === 'ios') {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
    setSubmitted(true);
    onRespond(answers);
  };

  const handleDeny = () => {
    if (!onDeny) return;
    if (Platform.OS === 'ios') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    onDeny();
  };

  const hasMultiSelect = questions.some(q => q.multiSelect);

  return (
    <View style={styles.questionCard}>
      {interactive && (
        <TouchableOpacity style={styles.questionDismissBtn} onPress={handleDeny} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} activeOpacity={0.5}>
          <Text style={styles.questionDismissX}>{'\u00D7'}</Text>
        </TouchableOpacity>
      )}
      {questions.map((q, qi) => {
        return (
          <View key={qi} style={qi > 0 ? { marginTop: 16 } : undefined}>
            <Text style={styles.questionText}>{q.question}</Text>
            <View style={styles.questionOptions}>
              {q.options.map((opt, oi) => {
                const isSelected = interactive
                  ? (selections[qi]?.has(oi) ?? false)
                  : answerText.includes(opt.label);
                const Wrapper = interactive ? TouchableOpacity : View;
                return (
                  <Wrapper
                    key={oi}
                    style={[
                      styles.questionOption,
                      isSelected && styles.questionOptionSelected,
                    ]}
                    {...(interactive ? { onPress: () => handleTapOption(qi, oi, q.multiSelect), activeOpacity: 0.7 } : {})}
                  >
                    <Text style={[
                      styles.questionOptionLabel,
                      isSelected && styles.questionOptionLabelSelected,
                    ]}>{opt.label}</Text>
                    {opt.description && (
                      <Text style={[
                        styles.questionOptionDesc,
                        isSelected && styles.questionOptionDescSelected,
                      ]}>{opt.description}</Text>
                    )}
                  </Wrapper>
                );
              })}
            </View>
          </View>
        );
      })}
      {interactive && hasMultiSelect && (
        <TouchableOpacity style={styles.questionSubmitButton} onPress={handleSubmitMulti} activeOpacity={0.8}>
          <Text style={styles.questionSubmitText}>Submit</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

// Tool card — consistent collapsed card, tappable to expand details
function ToolUseCard({ block, result }: { block: ContentBlock & { type: 'tool_use' }; result?: string | null }) {
  const [expanded, setExpanded] = useState(false);
  const display = getToolDisplay(block.name, block.input as Record<string, unknown>);
  const isCompleted = result != null;
  const hasDiff = isEditWithDiff(block.name, block.input);

  return (
    <View style={styles.toolCard}>
      <TouchableOpacity
        style={styles.toolHeader}
        onPress={() => setExpanded(!expanded)}
        activeOpacity={0.7}
      >
        <View style={styles.toolHeaderLeft}>
          <Text style={styles.toolLabel}>{display.label}</Text>
          {isCompleted ? (
            <Text style={styles.toolTitle} numberOfLines={1}>{display.title}</Text>
          ) : (
            <ShimmerText text={display.title} style={styles.toolTitle} duration={1700} />
          )}
        </View>
        <View style={styles.toolHeaderRight}>
          <View style={[styles.toolBadge, !isCompleted && styles.toolBadgeRunning]}>
            <View style={[styles.toolBadgeDot, !isCompleted && styles.toolBadgeDotRunning]} />
          </View>
          <View style={[styles.toolChevron, expanded && styles.toolChevronOpen]}>
            <View style={styles.toolChevronArrow} />
          </View>
        </View>
      </TouchableOpacity>

      {expanded && (
        <View style={styles.toolBody}>
          {hasDiff && (
            <ScrollView style={styles.toolDetailScroll} nestedScrollEnabled>
              <DiffView
                oldStr={block.input.old_string as string}
                newStr={block.input.new_string as string}
              />
            </ScrollView>
          )}
          {!hasDiff && (
            <ScrollView style={styles.toolDetailScroll} nestedScrollEnabled>
              <Text style={styles.toolDetailText}>
                {JSON.stringify(block.input, null, 2)}
              </Text>
            </ScrollView>
          )}
          {result != null && (
            <ScrollView style={[styles.toolDetailScroll, { marginTop: 8 }]} nestedScrollEnabled>
              <Text style={styles.toolDetailText}>{result}</Text>
            </ScrollView>
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
  pendingPermissionToolNames,
  onRespondQuestion,
  onDenyQuestion,
}: {
  block: ContentBlock;
  resultMap?: Map<string, string>;
  animateThinking?: boolean;
  pendingPermissionToolNames?: Set<string>;
  onRespondQuestion?: (answers: Record<string, string>, toolInput: Record<string, unknown>) => void;
  onDenyQuestion?: () => void;
}) {
  const [expanded, setExpanded] = useState(block.type === 'thinking');

  switch (block.type) {
    case 'text':
      return null; // Text blocks are rendered together via StreamdownRN

    case 'tool_use': {
      const typedBlock = block as ContentBlock & { type: 'tool_use' };
      const result = resultMap?.get(block.id) ?? null;

      if (typedBlock.name === 'TodoWrite') {
        return <TodoWriteCard block={typedBlock} />;
      }
      if (typedBlock.name === 'AskUserQuestion') {
        const isPending = pendingPermissionToolNames?.has('AskUserQuestion');
        return (
          <AskUserQuestionCard
            block={typedBlock}
            result={result}
            onRespond={isPending ? (answers) => onRespondQuestion?.(answers, typedBlock.input as Record<string, unknown>) : undefined}
            onDeny={isPending ? onDenyQuestion : undefined}
          />
        );
      }

      return <ToolUseCard block={typedBlock} result={result} />;
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
            <View style={[styles.thinkingChevron, expanded && styles.thinkingChevronOpen]}>
              <View style={styles.thinkingChevronArrow} />
            </View>
          </TouchableOpacity>
          {expanded && <Text style={styles.thinkingText}>{block.text}</Text>}
        </View>
      );

    default:
      return null;
  }
}

export function MessageBubble({ message, toolResultMap, animateThinking = false, pendingPermissionToolNames, onRespondQuestion, onDenyQuestion }: MessageBubbleProps) {
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
            pendingPermissionToolNames={pendingPermissionToolNames}
            onRespondQuestion={onRespondQuestion}
            onDenyQuestion={onDenyQuestion}
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
    backgroundColor: '#141414',
    borderRadius: 8,
    marginVertical: 6,
    borderWidth: 1,
    borderColor: '#2a2a2a',
    overflow: 'hidden',
  },
  toolHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 14,
    gap: 10,
  },
  toolHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
    minWidth: 0,
  },
  toolLabel: {
    color: '#555',
    fontSize: 12,
    fontWeight: '600',
  },
  toolTitle: {
    color: '#e5e5e5',
    fontSize: 13,
    fontWeight: '500',
    flexShrink: 1,
  },
  toolHeaderRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  toolBadge: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: 'rgba(34,197,94,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  toolBadgeRunning: {
    backgroundColor: 'rgba(245,158,11,0.15)',
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
  toolChevron: {
    width: 16,
    height: 16,
    justifyContent: 'center',
    alignItems: 'center',
  },
  toolChevronOpen: {
    transform: [{ rotate: '180deg' }],
  },
  toolChevronArrow: {
    width: 6,
    height: 6,
    borderRightWidth: 1.5,
    borderBottomWidth: 1.5,
    borderColor: '#444',
    transform: [{ rotate: '45deg' }],
    marginTop: -3,
  },
  toolBody: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#2a2a2a',
    padding: 14,
    paddingTop: 12,
  },
  toolDetailScroll: {
    maxHeight: 200,
    backgroundColor: '#0f0f0f',
    borderRadius: 6,
    padding: 10,
  },
  toolDetailText: {
    color: '#777',
    fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    lineHeight: 18,
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
    width: 14,
    height: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 2,
    marginRight: -1,
    marginTop: 1,
  },
  thinkingChevronOpen: {
    transform: [{ rotate: '180deg' }],
  },
  thinkingChevronArrow: {
    width: 6,
    height: 6,
    borderRightWidth: 1.5,
    borderBottomWidth: 1.5,
    borderColor: '#6f6f6f',
    transform: [{ rotate: '45deg' }],
    marginTop: -2,
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

  // --- TodoWrite card ---
  todoCard: {
    backgroundColor: '#141414',
    borderRadius: 8,
    padding: 16,
    marginVertical: 6,
    borderWidth: 1,
    borderColor: '#2a2a2a',
  },
  todoTitle: {
    color: '#fafafa',
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 12,
  },
  todoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    gap: 10,
  },
  todoCircle: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1.5,
    borderColor: '#333',
    alignItems: 'center',
    justifyContent: 'center',
  },
  todoCircleComplete: {
    backgroundColor: '#fff',
    borderColor: '#fff',
  },
  todoCheck: {
    width: 10,
    height: 8,
    position: 'relative',
    marginTop: 1,
  },
  todoCheckShort: {
    position: 'absolute',
    top: 4,
    left: 0,
    width: 4,
    height: 1.5,
    backgroundColor: '#000',
    borderRadius: 1,
    transform: [{ rotate: '45deg' }],
  },
  todoCheckLong: {
    position: 'absolute',
    top: 3,
    left: 2,
    width: 8,
    height: 1.5,
    backgroundColor: '#000',
    borderRadius: 1,
    transform: [{ rotate: '-45deg' }],
  },
  todoText: {
    color: '#e5e5e5',
    fontSize: 13,
    fontWeight: '500',
    flex: 1,
  },
  todoTextComplete: {
    color: '#555',
    textDecorationLine: 'line-through',
  },
  todoTextPending: {
    color: '#666',
  },

  // --- AskUserQuestion card ---
  questionCard: {
    backgroundColor: '#141414',
    borderRadius: 8,
    padding: 16,
    marginVertical: 6,
    borderWidth: 1,
    borderColor: '#2a2a2a',
  },
  questionText: {
    color: '#fafafa',
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 16,
  },
  questionOptions: {
    gap: 8,
  },
  questionOption: {
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 6,
    paddingVertical: 10,
    paddingHorizontal: 14,
    backgroundColor: 'transparent',
  },
  questionOptionSelected: {
    backgroundColor: '#fff',
    borderColor: '#fff',
  },
  questionOptionLabel: {
    color: '#e5e5e5',
    fontSize: 14,
    fontWeight: '500',
  },
  questionOptionLabelSelected: {
    color: '#000',
    fontWeight: '600',
  },
  questionOptionDesc: {
    color: '#888',
    fontSize: 12,
    marginTop: 2,
    lineHeight: 17,
  },
  questionOptionDescSelected: {
    color: '#444',
  },
  questionDismissBtn: {
    position: 'absolute',
    top: -8,
    right: -8,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1,
  },
  questionDismissX: {
    color: '#000',
    fontSize: 16,
    lineHeight: 17,
    fontWeight: '600',
  },
  questionSubmitButton: {
    marginTop: 12,
    paddingVertical: 10,
    borderRadius: 6,
    alignItems: 'center',
    backgroundColor: '#fff',
  },
  questionSubmitText: {
    color: '#000',
    fontWeight: '600',
    fontSize: 14,
  },
});
