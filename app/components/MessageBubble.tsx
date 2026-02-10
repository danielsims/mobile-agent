import React, { useState } from 'react';
import { View, Text, StyleSheet, Platform, Linking, TouchableOpacity } from 'react-native';
import type { AgentMessage, ContentBlock } from '../state/types';
import { CodeBlock } from './CodeBlock';

interface MessageBubbleProps {
  message: AgentMessage;
}

// URL regex pattern
const urlRegex = /(https?:\/\/[^\s<>"\])}]+)/g;

// Parse text for URLs and make them clickable
function parseTextWithLinks(text: string, baseKey: number): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match;
  let key = baseKey;

  urlRegex.lastIndex = 0;
  while ((match = urlRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(
        <Text key={key++} style={styles.text}>
          {text.slice(lastIndex, match.index)}
        </Text>,
      );
    }
    const url = match[1];
    parts.push(
      <Text key={key++} style={styles.link} onPress={() => Linking.openURL(url)}>
        {url}
      </Text>,
    );
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    parts.push(
      <Text key={key++} style={styles.text}>
        {text.slice(lastIndex)}
      </Text>,
    );
  }
  return parts;
}

// Parse markdown-ish content with code blocks and links
function parseContent(content: string): React.ReactNode[] {
  const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match;
  let key = 0;

  while ((match = codeBlockRegex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      const text = content.slice(lastIndex, match.index).trim();
      if (text) {
        const textParts = parseTextWithLinks(text, key);
        parts.push(<Text key={key++} style={styles.text}>{textParts}</Text>);
        key += textParts.length;
      }
    }
    parts.push(<CodeBlock key={key++} language={match[1]} code={match[2].trim()} />);
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < content.length) {
    const text = content.slice(lastIndex).trim();
    if (text) {
      const textParts = parseTextWithLinks(text, key);
      parts.push(<Text key={key++} style={styles.text}>{textParts}</Text>);
    }
  }

  if (parts.length === 0) {
    const textParts = parseTextWithLinks(content, 0);
    return [<Text key={0} style={styles.text}>{textParts}</Text>];
  }

  return parts;
}

// Render a single ContentBlock
function ContentBlockView({ block, index }: { block: ContentBlock; index: number }) {
  const [expanded, setExpanded] = useState(false);

  switch (block.type) {
    case 'text':
      return <View key={index}>{parseContent(block.text)}</View>;

    case 'tool_use':
      return (
        <TouchableOpacity
          key={index}
          style={styles.toolUseContainer}
          onPress={() => setExpanded(!expanded)}
          activeOpacity={0.7}
        >
          <View style={styles.toolUseHeader}>
            <Text style={styles.toolUseName}>{block.name}</Text>
            <Text style={[styles.toolUseChevron, !expanded && styles.toolUseChevronDown]}>{'\u2303'}</Text>
          </View>
          {expanded && (
            <CodeBlock code={JSON.stringify(block.input, null, 2)} language="json" />
          )}
        </TouchableOpacity>
      );

    case 'tool_result':
      return (
        <View key={index} style={styles.toolResultContainer}>
          <Text style={styles.toolResultText}>
            {typeof block.content === 'string' ? block.content : JSON.stringify(block.content)}
          </Text>
        </View>
      );

    case 'thinking':
      return (
        <TouchableOpacity
          key={index}
          style={styles.thinkingContainer}
          onPress={() => setExpanded(!expanded)}
          activeOpacity={0.7}
        >
          <Text style={styles.thinkingLabel}>
            Thinking {expanded ? '\u25B4' : '\u25BE'}
          </Text>
          {expanded && <Text style={styles.thinkingText}>{block.text}</Text>}
        </TouchableOpacity>
      );

    default:
      return null;
  }
}

export function MessageBubble({ message }: MessageBubbleProps) {
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
      return <View style={styles.bubble}>{parseContent(message.content)}</View>;
    }

    // ContentBlock array
    return (
      <View style={styles.bubble}>
        {message.content.map((block, i) => (
          <ContentBlockView key={i} block={block} index={i} />
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
  text: {
    color: '#e5e5e5',
    fontSize: 15,
    lineHeight: 22,
  },
  link: {
    color: '#60a5fa',
    fontSize: 15,
    lineHeight: 22,
    textDecorationLine: 'underline',
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
  // Tool use blocks
  toolUseContainer: {
    backgroundColor: '#141414',
    borderRadius: 8,
    padding: 12,
    marginVertical: 4,
    borderWidth: 1,
    borderColor: '#2a2a2a',
  },
  toolUseHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  toolUseName: {
    color: '#e5e5e5',
    fontSize: 13,
    fontWeight: '500',
  },
  toolUseChevron: {
    color: '#888',
    fontSize: 16,
  },
  toolUseChevronDown: {
    transform: [{ rotate: '180deg' }],
  },
  // Tool result blocks
  toolResultContainer: {
    marginVertical: 4,
    paddingLeft: 10,
    borderLeftWidth: 2,
    borderLeftColor: '#2a2a2a',
  },
  toolResultText: {
    color: '#666',
    fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    lineHeight: 18,
  },
  // Thinking blocks
  thinkingContainer: {
    backgroundColor: 'rgba(139,92,246,0.06)',
    borderRadius: 6,
    padding: 10,
    marginVertical: 4,
    borderLeftWidth: 2,
    borderLeftColor: '#8b5cf6',
  },
  thinkingLabel: {
    color: '#8b5cf6',
    fontSize: 12,
    fontWeight: '500',
  },
  thinkingText: {
    color: '#a78bfa',
    fontSize: 13,
    lineHeight: 20,
    marginTop: 6,
  },
});
