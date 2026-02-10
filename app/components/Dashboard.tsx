import React, { useMemo } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  Alert,
} from 'react-native';
import { useAgentState } from '../state/AgentContext';
import type { AgentState } from '../state/types';
import type { ConnectionStatus } from '../types';
import { AgentCard, NewAgentCard } from './AgentCard';

interface DashboardProps {
  connectionStatus: ConnectionStatus;
  onSelectAgent: (agentId: string) => void;
  onCreateAgent: () => void;
  onDestroyAgent: (agentId: string) => void;
  onOpenSettings: () => void;
}

type ListItem = { type: 'agent'; agent: AgentState } | { type: 'new' };

export function Dashboard({
  connectionStatus,
  onSelectAgent,
  onCreateAgent,
  onDestroyAgent,
  onOpenSettings,
}: DashboardProps) {
  const { state } = useAgentState();

  // Convert Map to sorted array + append "new agent" card
  const listData = useMemo<ListItem[]>(() => {
    const agents = Array.from(state.agents.values())
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((agent): ListItem => ({ type: 'agent', agent }));
    return [...agents, { type: 'new' }];
  }, [state.agents]);

  const handleLongPress = (agent: AgentState) => {
    Alert.alert(
      'Destroy Agent',
      `End "${agent.sessionName}"? This will terminate the agent process.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Destroy',
          style: 'destructive',
          onPress: () => onDestroyAgent(agent.id),
        },
      ],
    );
  };

  const renderItem = ({ item }: { item: ListItem }) => {
    if (item.type === 'new') {
      return <NewAgentCard onPress={onCreateAgent} />;
    }
    return (
      <AgentCard
        agent={item.agent}
        onPress={() => onSelectAgent(item.agent.id)}
        onLongPress={() => handleLongPress(item.agent)}
      />
    );
  };

  const keyExtractor = (item: ListItem) =>
    item.type === 'new' ? 'new-agent' : item.agent.id;

  const isConnected = connectionStatus === 'connected';

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>Agents</Text>
        <View style={styles.headerRight}>
          <TouchableOpacity onPress={onOpenSettings}>
            <View style={styles.statusPill}>
              <View style={[styles.statusDot, isConnected ? styles.dotGreen : styles.dotRed]} />
              <Text style={styles.statusText}>
                {connectionStatus === 'connected' ? 'Connected' :
                 connectionStatus === 'connecting' ? 'Connecting' : 'Offline'}
              </Text>
            </View>
          </TouchableOpacity>
        </View>
      </View>

      {/* Agent grid */}
      <FlatList
        data={listData}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        numColumns={2}
        contentContainerStyle={styles.grid}
        columnWrapperStyle={styles.row}
        showsVerticalScrollIndicator={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0a0a0a',
  },
  // Header
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a1a',
  },
  title: {
    color: '#fafafa',
    fontSize: 28,
    fontWeight: '700',
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1a1a1a',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 12,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 6,
  },
  dotGreen: {
    backgroundColor: '#22c55e',
  },
  dotRed: {
    backgroundColor: '#ef4444',
  },
  statusText: {
    color: '#888',
    fontSize: 12,
  },
  // Grid
  grid: {
    padding: 8,
    paddingBottom: 40,
  },
  row: {
    justifyContent: 'flex-start',
  },
});
