import React from 'react';
import { View, Text, StyleSheet, ScrollView, Platform } from 'react-native';

interface CodeBlockProps {
  code: string;
  language?: string;
}

// Simple syntax highlighting for common patterns
function highlightCode(code: string): React.ReactNode[] {
  const lines = code.split('\n');

  return lines.map((line, i) => (
    <Text key={i} style={styles.line}>
      <Text style={styles.lineNumber}>{String(i + 1).padStart(3, ' ')}  </Text>
      {highlightLine(line)}
    </Text>
  ));
}

function highlightLine(line: string): React.ReactNode {
  // Keywords
  const keywords = /\b(const|let|var|function|return|if|else|for|while|import|export|from|class|extends|async|await|try|catch|throw|new|this|typeof|interface|type)\b/g;
  // Strings
  const strings = /(["'`])(?:(?!\1)[^\\]|\\.)*?\1/g;
  // Comments
  const comments = /(\/\/.*$|\/\*[\s\S]*?\*\/)/g;
  // Numbers
  const numbers = /\b(\d+\.?\d*)\b/g;

  let result = line;
  const parts: { start: number; end: number; style: 'keyword' | 'string' | 'comment' | 'number' }[] = [];

  // Find all matches
  let match;
  while ((match = keywords.exec(line)) !== null) {
    parts.push({ start: match.index, end: match.index + match[0].length, style: 'keyword' });
  }
  while ((match = strings.exec(line)) !== null) {
    parts.push({ start: match.index, end: match.index + match[0].length, style: 'string' });
  }
  while ((match = comments.exec(line)) !== null) {
    parts.push({ start: match.index, end: match.index + match[0].length, style: 'comment' });
  }
  while ((match = numbers.exec(line)) !== null) {
    parts.push({ start: match.index, end: match.index + match[0].length, style: 'number' });
  }

  // Sort by start position
  parts.sort((a, b) => a.start - b.start);

  // Remove overlapping parts (keep first)
  const filtered: typeof parts = [];
  for (const part of parts) {
    if (filtered.length === 0 || part.start >= filtered[filtered.length - 1].end) {
      filtered.push(part);
    }
  }

  // Build result
  if (filtered.length === 0) {
    return <Text style={styles.code}>{line}</Text>;
  }

  const nodes: React.ReactNode[] = [];
  let lastEnd = 0;

  for (const part of filtered) {
    if (part.start > lastEnd) {
      nodes.push(<Text key={lastEnd} style={styles.code}>{line.slice(lastEnd, part.start)}</Text>);
    }
    const style = part.style === 'keyword' ? styles.keyword
      : part.style === 'string' ? styles.string
      : part.style === 'comment' ? styles.comment
      : styles.number;
    nodes.push(<Text key={part.start} style={style}>{line.slice(part.start, part.end)}</Text>);
    lastEnd = part.end;
  }

  if (lastEnd < line.length) {
    nodes.push(<Text key={lastEnd} style={styles.code}>{line.slice(lastEnd)}</Text>);
  }

  return <>{nodes}</>;
}

export function CodeBlock({ code, language }: CodeBlockProps) {
  return (
    <View style={styles.container}>
      {language && (
        <View style={styles.header}>
          <Text style={styles.language}>{language}</Text>
        </View>
      )}
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={styles.codeContainer}>
          {highlightCode(code)}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#1a1a1a',
    borderRadius: 8,
    marginVertical: 8,
    overflow: 'hidden',
  },
  header: {
    backgroundColor: '#252525',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#333',
  },
  language: {
    color: '#888',
    fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  codeContainer: {
    padding: 12,
  },
  line: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 13,
    lineHeight: 20,
  },
  lineNumber: {
    color: '#555',
  },
  code: {
    color: '#e5e5e5',
  },
  keyword: {
    color: '#c678dd',
  },
  string: {
    color: '#98c379',
  },
  comment: {
    color: '#5c6370',
    fontStyle: 'italic',
  },
  number: {
    color: '#d19a66',
  },
});
