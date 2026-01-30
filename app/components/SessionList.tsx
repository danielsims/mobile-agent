import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { Session } from '../types';

interface SessionListProps {
  sessions: Session[];
  loading: boolean;
  onSelect: (session: Session) => void;
  onNewChat: () => void;
  onBack: () => void;
}

export function SessionList({
  sessions,
  loading,
  onSelect,
  onNewChat,
  onBack,
}: SessionListProps) {
  const formatDate = (dateStr?: string) => {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  };

  const renderSession = ({ item }: { item: Session }) => (
    <TouchableOpacity style={styles.sessionItem} onPress={() => onSelect(item)}>
      <Text style={styles.sessionName} numberOfLines={2}>
        {item.name || `Session ${item.id.slice(0, 8)}`}
      </Text>
      <View style={styles.sessionMeta}>
        {item.messageCount && (
          <Text style={styles.messageCount}>{item.messageCount} messages</Text>
        )}
        <Text style={styles.timestamp}>{formatDate(item.modified)}</Text>
      </View>
      {item.projectPath && (
        <Text style={styles.projectPath} numberOfLines={1}>
          {item.projectPath.replace(process.env.HOME || '/Users', '~')}
        </Text>
      )}
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack}>
          <Text style={styles.backBtn}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Sessions</Text>
        <TouchableOpacity onPress={onNewChat}>
          <Text style={styles.newBtn}>+ New</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.loading}>
          <ActivityIndicator color="#fff" />
          <Text style={styles.loadingText}>Loading sessions...</Text>
        </View>
      ) : sessions.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>No previous sessions</Text>
          <TouchableOpacity style={styles.startBtn} onPress={onNewChat}>
            <Text style={styles.startBtnText}>Start a new chat</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={sessions}
          keyExtractor={(item) => item.id}
          renderItem={renderSession}
          contentContainerStyle={styles.list}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0a0a0a',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a1a',
  },
  backBtn: {
    color: '#0a84ff',
    fontSize: 16,
  },
  title: {
    color: '#fafafa',
    fontSize: 17,
    fontWeight: '600',
  },
  newBtn: {
    color: '#30d158',
    fontSize: 16,
    fontWeight: '500',
  },
  list: {
    padding: 16,
  },
  sessionItem: {
    backgroundColor: '#1c1c1e',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#2c2c2e',
  },
  sessionName: {
    color: '#fafafa',
    fontSize: 15,
    fontWeight: '500',
    marginBottom: 6,
    lineHeight: 20,
  },
  sessionMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  messageCount: {
    color: '#666',
    fontSize: 12,
  },
  timestamp: {
    color: '#555',
    fontSize: 12,
  },
  projectPath: {
    color: '#444',
    fontSize: 11,
    marginTop: 6,
  },
  loading: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    color: '#888',
    marginTop: 12,
  },
  empty: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  emptyText: {
    color: '#888',
    fontSize: 16,
    marginBottom: 16,
  },
  startBtn: {
    backgroundColor: '#fff',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  startBtnText: {
    color: '#000',
    fontWeight: '600',
  },
});
