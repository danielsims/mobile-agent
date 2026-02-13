import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, Platform, TouchableOpacity, Image } from 'react-native';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import { StreamdownRN } from 'streamdown-rn';
import type { AgentMessage, ContentBlock, AgentType } from '../state/types';
import { ShimmerText } from './ShimmerText';
import { getCanonicalToolKey, getToolRendererKind, isQuestionTool } from '../utils/toolRegistry';

interface MessageBubbleProps {
  message: AgentMessage;
  agentType?: AgentType;
  toolResultMap?: Map<string, string>;
  animateThinking?: boolean;
  pendingPermissionToolNames?: Set<string>;
  onRespondQuestion?: (answers: Record<string, string>, toolInput: Record<string, unknown>) => void;
  onDenyQuestion?: () => void;
}

// Check if a message has any content that will actually render visibly.
// Prevents empty "Assistant" headers for messages where all blocks render null
// (e.g. TodoWriteCard with empty input, or tool_result-only messages).
function hasVisibleContent(message: AgentMessage, agentType?: AgentType): boolean {
  if (typeof message.content === 'string') {
    return message.content.trim().length > 0;
  }
  return message.content.some(block => {
    switch (block.type) {
      case 'text':
        return block.text.trim().length > 0;
      case 'thinking':
        return !!block.text?.trim();
      case 'tool_use': {
        const rendererKind = getToolRendererKind(agentType, block.name);
        if (rendererKind === 'todo') {
          const input = block.input as Record<string, unknown> | undefined;
          const todos = Array.isArray(input?.todos)
            ? input!.todos
            : Array.isArray(input?.items)
              ? input!.items
              : [];
          return todos.length > 0;
        }
        return true;
      }
      case 'tool_result':
        return false; // rendered inline with tool_use
      default:
        return false;
    }
  });
}

function getCopyableMessageText(message: AgentMessage): string {
  if (typeof message.content === 'string') {
    return message.content.trim();
  }

  const textParts: string[] = [];
  for (const block of message.content) {
    if (block.type === 'text' && block.text.trim()) {
      textParts.push(block.text.trim());
    }
  }

  return textParts.join('\n\n').trim();
}

function getMessageImageUri(message: AgentMessage): string | null {
  const image = message.imageData;
  if (!image) return null;
  if (typeof image.uri === 'string' && image.uri) return image.uri;
  if (typeof image.base64 === 'string' && image.base64) {
    const mimeType = image.mimeType || 'image/jpeg';
    return `data:${mimeType};base64,${image.base64}`;
  }
  return null;
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

function pickString(input: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    if (typeof input[key] === 'string' && input[key]) return input[key] as string;
  }
  return '';
}

// Tool display config — maps tool names to label + title
function getToolDisplay(name: string, input: Record<string, unknown>): { label: string; title: string } {
  const key = getCanonicalToolKey(name);

  switch (key) {
    case 'read':
      return { label: 'Read', title: shortPath(pickString(input, 'file_path', 'path', 'file')) };
    case 'write':
      return { label: 'Write', title: shortPath(pickString(input, 'file_path', 'path', 'file')) };
    case 'edit':
      return { label: 'Edit', title: shortPath(pickString(input, 'file_path', 'path', 'file')) };
    case 'bash':
      return { label: 'Run', title: pickString(input, 'description') || truncate(pickString(input, 'command'), 60) };
    case 'grep':
      return { label: 'Search', title: truncate(pickString(input, 'pattern', 'query'), 50) };
    case 'glob':
      return { label: 'Find files', title: truncate(pickString(input, 'pattern', 'path'), 50) };
    case 'websearch':
      return { label: 'Web', title: truncate(pickString(input, 'query'), 60) };
    case 'codesearch':
      return { label: 'Code', title: truncate(pickString(input, 'query'), 60) };
    case 'webfetch':
      return { label: 'Fetch', title: truncate(pickString(input, 'url'), 50) };
    case 'task':
      return { label: 'Agent', title: pickString(input, 'description') || truncate(pickString(input, 'prompt') || 'Subagent', 50) };
    case 'skill':
      return { label: 'Skill', title: truncate(pickString(input, 'name', 'description'), 60) || 'Skill' };
    case 'question': {
      const questions = Array.isArray(input.questions) ? input.questions : [];
      const first = questions.find((q) => q && typeof q === 'object' && typeof (q as { question?: unknown }).question === 'string') as { question: string } | undefined;
      return { label: 'Question', title: first?.question ? truncate(first.question, 60) : 'Awaiting input' };
    }
    case 'todowrite':
    case 'todoread': {
      const todos = Array.isArray(input.todos) ? input.todos : [];
      return { label: 'Tasks', title: todos.length > 0 ? `${todos.length} items` : 'Task list' };
    }
    default: {
      const formatted = formatToolName(name);
      const candidates = ['description', 'file_path', 'command', 'pattern', 'query', 'url', 'prompt'];
      for (const key of candidates) {
        const value = pickString(input, key);
        if (value) return { label: formatted, title: truncate(value, 60) };
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

function CopyButtonIcon({ copied }: { copied: boolean }) {
  if (copied) {
    return (
      <View style={styles.copyCheckIcon} accessibilityElementsHidden importantForAccessibility="no">
        <View style={styles.copyCheckShort} />
        <View style={styles.copyCheckLong} />
      </View>
    );
  }

  return (
    <View style={styles.copyIconFrame} accessibilityElementsHidden importantForAccessibility="no">
      <View style={styles.copyIconBack} />
      <View style={styles.copyIconFront} />
    </View>
  );
}

// Check if a tool_use block is an Edit with old_string/new_string
function isEditWithDiff(name: string, input: Record<string, unknown>): boolean {
  return getCanonicalToolKey(name) === 'edit'
    && typeof input.old_string === 'string'
    && typeof input.new_string === 'string';
}

// --- TodoWrite card: renders todo items as a checklist ---
function TodoWriteCard({ block }: { block: ContentBlock & { type: 'tool_use' } }) {
  const rawTodos = Array.isArray(block.input?.todos)
    ? block.input.todos
    : Array.isArray(block.input?.items)
      ? block.input.items
      : [];

  const todos = rawTodos
    .filter((todo): todo is Record<string, unknown> => !!todo && typeof todo === 'object')
    .map((todo) => ({
      content: pickString(todo, 'content', 'text', 'title', 'label') || 'Task',
      status: pickString(todo, 'status', 'state') || 'pending',
      activeForm: pickString(todo, 'activeForm', 'active_form'),
    })) as Array<{ content: string; status: string; activeForm?: string }>;

  if (todos.length === 0) return null;

  return (
    <View style={styles.todoCard}>
      <Text style={styles.todoTitle}>Tasks</Text>
      {todos.map((todo, i) => {
        const normalizedStatus = todo.status.toLowerCase();
        const isComplete = normalizedStatus === 'completed' || normalizedStatus === 'done';
        const isActive = normalizedStatus === 'in_progress' || normalizedStatus === 'active';
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
                filePath={pickString(block.input as Record<string, unknown>, 'file_path', 'path', 'file') || undefined}
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
  agentType,
  resultMap,
  animateThinking = false,
  pendingPermissionToolNames,
  onRespondQuestion,
  onDenyQuestion,
}: {
  block: ContentBlock;
  agentType?: AgentType;
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
      const rendererKind = getToolRendererKind(agentType, typedBlock.name);

      if (rendererKind === 'todo') {
        return <TodoWriteCard block={typedBlock} />;
      }
      if (rendererKind === 'question') {
        const isPending = Array.from(pendingPermissionToolNames || []).some((name) => isQuestionTool(agentType, name));
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

export function MessageBubble({ message, agentType, toolResultMap, animateThinking = false, pendingPermissionToolNames, onRespondQuestion, onDenyQuestion }: MessageBubbleProps) {
  const isUser = message.type === 'user';
  const isSystem = message.type === 'system';
  const [copied, setCopied] = useState(false);
  const copiedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyText = useMemo(() => getCopyableMessageText(message), [message]);
  const imageUri = useMemo(() => getMessageImageUri(message), [message]);
  const shouldShowCopyButton = copyText.length > 0 && !isUser;

  useEffect(() => {
    return () => {
      if (copiedTimeoutRef.current) {
        clearTimeout(copiedTimeoutRef.current);
      }
    };
  }, []);

  if (isSystem) {
    return (
      <View style={styles.systemContainer}>
        <Text style={styles.systemText}>
          {typeof message.content === 'string' ? message.content : ''}
        </Text>
      </View>
    );
  }

  // Skip assistant messages where all blocks render as null (e.g. empty TodoWriteCard)
  if (!isUser && !hasVisibleContent(message, agentType)) {
    return null;
  }

  const handleCopy = async () => {
    if (!copyText) return;

    await Clipboard.setStringAsync(copyText);
    if (Platform.OS === 'ios') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    setCopied(true);

    if (copiedTimeoutRef.current) {
      clearTimeout(copiedTimeoutRef.current);
    }
    copiedTimeoutRef.current = setTimeout(() => setCopied(false), 1300);
  };

  // Content can be string (streaming) or ContentBlock[] (structured)
  const renderContent = () => {
    if (typeof message.content === 'string') {
      if (isUser) {
        const userText = message.content.trim();
        if (!userText) return null;
        return <Text style={styles.userText}>{message.content}</Text>;
      }
      // Assistant streaming text — render as markdown
      return (
        <View style={styles.bubble}>
          <StreamdownRN theme="dark">{message.content}</StreamdownRN>
        </View>
      );
    }

    // ContentBlock array — render in original order, grouping adjacent
    // text blocks into markdown sections so thinking/tool blocks appear
    // in the correct position relative to text.
    const renderGroups: Array<{ kind: 'markdown'; text: string } | { kind: 'block'; block: ContentBlock }> = [];
    let textAccum: string[] = [];

    for (const block of message.content) {
      if (block.type === 'text') {
        if (block.text.trim()) textAccum.push(block.text);
      } else if (block.type === 'tool_result') {
        continue; // rendered inline with tool_use
      } else if (block.type === 'thinking' && (!block.text || !block.text.trim())) {
        continue; // skip empty thinking
      } else {
        // Non-text block — flush any accumulated text first
        if (textAccum.length > 0) {
          renderGroups.push({ kind: 'markdown', text: textAccum.join('\n\n') });
          textAccum = [];
        }
        renderGroups.push({ kind: 'block', block });
      }
    }
    if (textAccum.length > 0) {
      renderGroups.push({ kind: 'markdown', text: textAccum.join('\n\n') });
    }

    return (
      <View style={styles.bubble}>
        {renderGroups.map((group, i) => {
          if (group.kind === 'markdown') {
            return <StreamdownRN key={i} theme="dark">{group.text}</StreamdownRN>;
          }
          return (
            <ContentBlockView
              key={i}
              block={group.block}
              agentType={agentType}
              resultMap={toolResultMap}
              animateThinking={animateThinking}
              pendingPermissionToolNames={pendingPermissionToolNames}
              onRespondQuestion={onRespondQuestion}
              onDenyQuestion={onDenyQuestion}
            />
          );
        })}
      </View>
    );
  };

  return (
    <View style={styles.messageContainer}>
      <Text style={[styles.sender, isUser && styles.senderUser]}>
        {isUser ? 'You' : 'Assistant'}
      </Text>
      {renderContent()}
      {isUser && imageUri && (
        <Image
          source={{ uri: imageUri }}
          style={styles.userImage}
          resizeMode="cover"
        />
      )}
      {shouldShowCopyButton && (
        <View style={styles.messageActions}>
          <TouchableOpacity
            style={[
              styles.copyButton,
              !copyText && styles.copyButtonDisabled,
              copied && styles.copyButtonCopied,
            ]}
            onPress={handleCopy}
            disabled={!copyText}
            activeOpacity={0.7}
            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            accessibilityRole="button"
            accessibilityLabel={copied ? 'Message copied' : 'Copy message'}
          >
            <CopyButtonIcon copied={copied} />
          </TouchableOpacity>
        </View>
      )}
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
  userImage: {
    width: 220,
    height: 220,
    marginTop: 10,
    borderRadius: 12,
    backgroundColor: '#1d1d1d',
  },
  messageActions: {
    flexDirection: 'row',
    marginTop: 4,
    marginBottom: 2,
  },
  copyButton: {
    alignSelf: 'flex-start',
    paddingVertical: 2,
    paddingHorizontal: 4,
  },
  copyButtonDisabled: {
    opacity: 0.4,
  },
  copyButtonCopied: {
    opacity: 0.95,
  },
  copyIconFrame: {
    width: 16,
    height: 16,
    position: 'relative',
  },
  copyIconBack: {
    position: 'absolute',
    width: 10,
    height: 10,
    borderWidth: 1.2,
    borderColor: '#5d5d5d',
    borderRadius: 2,
    top: 1,
    left: 1,
  },
  copyIconFront: {
    position: 'absolute',
    width: 10,
    height: 10,
    borderWidth: 1.2,
    borderColor: '#9a9a9a',
    borderRadius: 2,
    top: 5,
    left: 5,
    backgroundColor: '#0f0f0f',
  },
  copyCheckIcon: {
    width: 16,
    height: 16,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  copyCheckShort: {
    position: 'absolute',
    width: 5,
    height: 1.8,
    backgroundColor: '#7edc95',
    borderRadius: 1,
    transform: [{ rotate: '45deg' }],
    top: 9,
    left: 3,
  },
  copyCheckLong: {
    position: 'absolute',
    width: 8,
    height: 1.8,
    backgroundColor: '#7edc95',
    borderRadius: 1,
    transform: [{ rotate: '-45deg' }],
    top: 7,
    left: 6,
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
    marginTop: 5,
    marginBottom: 10,
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
