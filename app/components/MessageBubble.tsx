import React from 'react';
import { View, Text, StyleSheet, Platform, Linking } from 'react-native';
import { Message } from '../types';
import { CodeBlock } from './CodeBlock';

interface MessageBubbleProps {
  message: Message;
}

// URL regex pattern
const urlRegex = /(https?:\/\/[^\s<>"\])}]+)/g;

// Parse text for URLs and make them clickable
function parseTextWithLinks(text: string, baseKey: number): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match;
  let key = baseKey;

  // Reset regex
  urlRegex.lastIndex = 0;

  while ((match = urlRegex.exec(text)) !== null) {
    // Text before URL
    if (match.index > lastIndex) {
      parts.push(
        <Text key={key++} style={styles.text}>
          {text.slice(lastIndex, match.index)}
        </Text>
      );
    }

    // URL - make it clickable
    const url = match[1];
    parts.push(
      <Text
        key={key++}
        style={styles.link}
        onPress={() => Linking.openURL(url)}
      >
        {url}
      </Text>
    );

    lastIndex = match.index + match[0].length;
  }

  // Remaining text
  if (lastIndex < text.length) {
    parts.push(
      <Text key={key++} style={styles.text}>
        {text.slice(lastIndex)}
      </Text>
    );
  }

  return parts;
}

// Parse content for code blocks and links
function parseContent(content: string): React.ReactNode[] {
  const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match;
  let key = 0;

  while ((match = codeBlockRegex.exec(content)) !== null) {
    // Text before code block (with link parsing)
    if (match.index > lastIndex) {
      const text = content.slice(lastIndex, match.index).trim();
      if (text) {
        const textParts = parseTextWithLinks(text, key);
        parts.push(
          <Text key={key++} style={styles.text}>
            {textParts}
          </Text>
        );
        key += textParts.length;
      }
    }

    // Code block
    parts.push(
      <CodeBlock key={key++} language={match[1]} code={match[2].trim()} />
    );

    lastIndex = match.index + match[0].length;
  }

  // Remaining text (with link parsing)
  if (lastIndex < content.length) {
    const text = content.slice(lastIndex).trim();
    if (text) {
      const textParts = parseTextWithLinks(text, key);
      parts.push(
        <Text key={key++} style={styles.text}>
          {textParts}
        </Text>
      );
    }
  }

  if (parts.length === 0) {
    const textParts = parseTextWithLinks(content, 0);
    return [<Text key={0} style={styles.text}>{textParts}</Text>];
  }

  return parts;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.type === 'user';
  const isSystem = message.type === 'system';
  const isTool = message.type === 'tool';

  if (isSystem) {
    return (
      <View style={styles.systemContainer}>
        <Text style={styles.systemText}>{message.content}</Text>
      </View>
    );
  }

  if (isTool) {
    return (
      <View style={styles.toolContainer}>
        <Text style={styles.toolName}>{message.toolName || 'Tool'}</Text>
        {message.toolInput && (
          <CodeBlock code={message.toolInput} language="json" />
        )}
        {message.content && (
          <Text style={styles.toolResult}>{message.content}</Text>
        )}
      </View>
    );
  }

  return (
    <View style={styles.messageContainer}>
      <Text style={[styles.sender, isUser && styles.senderUser]}>
        {isUser ? 'You' : 'Claude'}
      </Text>
      {isUser ? (
        <Text style={styles.userText}>{message.content}</Text>
      ) : (
        <View style={styles.bubble}>
          {parseContent(message.content)}
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
  bubble: {
    // No background, just the content
  },
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
  toolContainer: {
    marginBottom: 16,
  },
  toolName: {
    color: '#888',
    fontSize: 12,
    fontWeight: '500',
    marginBottom: 8,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  toolResult: {
    color: '#666',
    fontSize: 13,
    marginTop: 8,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
});
