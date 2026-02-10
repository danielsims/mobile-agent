import React, { useCallback, useState, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Platform,
  Keyboard,
  LayoutAnimation,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { useAgent, useAgentState } from '../state/AgentContext';
import type { ConnectionStatus, PermissionRequest } from '../types';
import { KeyboardScrollView } from './KeyboardScrollView';
import { MessageBubble } from './MessageBubble';
import { InputBar } from './InputBar';
import { CodeBlock } from './CodeBlock';

interface AgentDetailScreenProps {
  agentId: string;
  connectionStatus: ConnectionStatus;
  onBack: () => void;
  onSendMessage: (agentId: string, text: string) => void;
  onRespondPermission: (agentId: string, requestId: string, behavior: 'allow' | 'deny') => void;
  onResetPingTimer: () => void;
}

function formatCost(cost: number): string {
  if (cost === 0) return '$0.00';
  if (cost < 0.01) return '<$0.01';
  return `$${cost.toFixed(2)}`;
}

function formatTokens(tokens: number): string {
  if (tokens === 0) return '0';
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return String(tokens);
}

// Individual permission prompt for structured tool data
function PermissionCard({
  permission,
  onAllow,
  onDeny,
}: {
  permission: PermissionRequest;
  onAllow: () => void;
  onDeny: () => void;
}) {
  const handleAllow = () => {
    if (Platform.OS === 'ios') {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
    onAllow();
  };

  const handleDeny = () => {
    if (Platform.OS === 'ios') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    onDeny();
  };

  return (
    <View style={styles.permissionCard}>
      <Text style={styles.permissionTitle}>Permission Required</Text>
      <Text style={styles.permissionToolName}>{permission.toolName}</Text>
      {Object.keys(permission.toolInput).length > 0 && (
        <View style={styles.permissionInput}>
          <CodeBlock
            code={JSON.stringify(permission.toolInput, null, 2)}
            language="json"
          />
        </View>
      )}
      <View style={styles.permissionButtons}>
        <TouchableOpacity style={styles.denyButton} onPress={handleDeny} activeOpacity={0.7}>
          <Text style={styles.denyText}>Deny</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.allowButton} onPress={handleAllow} activeOpacity={0.8}>
          <Text style={styles.allowText}>Allow</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

export function AgentDetailScreen({
  agentId,
  connectionStatus,
  onBack,
  onSendMessage,
  onRespondPermission,
  onResetPingTimer,
}: AgentDetailScreenProps) {
  const agent = useAgent(agentId);
  const { dispatch } = useAgentState();
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  // Track keyboard height directly — more reliable than KeyboardAvoidingView
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const showListener = Keyboard.addListener(showEvent, (e) => {
      if (Platform.OS === 'ios') {
        LayoutAnimation.configureNext({
          duration: e.duration,
          update: { type: LayoutAnimation.Types.keyboard },
        });
      }
      setKeyboardHeight(e.endCoordinates.height);
    });

    const hideListener = Keyboard.addListener(hideEvent, (e) => {
      if (Platform.OS === 'ios') {
        LayoutAnimation.configureNext({
          duration: e.duration,
          update: { type: LayoutAnimation.Types.keyboard },
        });
      }
      setKeyboardHeight(0);
    });

    return () => {
      showListener.remove();
      hideListener.remove();
    };
  }, []);

  const handleSend = useCallback((text: string) => {
    onSendMessage(agentId, text);
    // Clear draft after sending
    dispatch({ type: 'SET_DRAFT', agentId, text: '' });
  }, [agentId, onSendMessage, dispatch]);

  const handleDraftChange = useCallback((text: string) => {
    dispatch({ type: 'SET_DRAFT', agentId, text });
  }, [agentId, dispatch]);

  if (!agent) {
    return (
      <View style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity onPress={onBack} style={styles.backButton}>
            <BackArrow />
            <Text style={styles.backText}>Agents</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyText}>Agent not found</Text>
        </View>
      </View>
    );
  }

  const isDisabled = connectionStatus !== 'connected' || agent.status === 'exited';
  const permissions = Array.from(agent.pendingPermissions.values());

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.backButton}>
          <BackArrow />
          <Text style={styles.backText}>Agents</Text>
        </TouchableOpacity>

        <View style={styles.headerCenter}>
          <Text style={styles.sessionName} numberOfLines={1}>{agent.sessionName}</Text>
          <Text style={styles.modelName}>{agent.model || 'loading...'}</Text>
        </View>

        <View style={styles.headerRight}>
          <StatusIndicator status={agent.status} />
        </View>
      </View>

      {/* Stats bar */}
      {(agent.totalCost > 0 || agent.outputTokens > 0) && (
        <View style={styles.statsBar}>
          <Text style={styles.statItem}>Cost: {formatCost(agent.totalCost)}</Text>
          <Text style={styles.statItem}>Tokens: {formatTokens(agent.outputTokens)}</Text>
          {agent.contextUsedPercent > 0 && (
            <View style={styles.contextStat}>
              <Text style={styles.statItem}>Context: {Math.round(agent.contextUsedPercent)}%</Text>
              <View style={styles.contextBarLarge}>
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
            </View>
          )}
        </View>
      )}

      {/* Chat */}
      <View style={[styles.main, keyboardHeight > 0 && { paddingBottom: keyboardHeight }]}>
        <KeyboardScrollView style={styles.chatArea} contentContainerStyle={styles.chatContent}>
          {agent.messages.length === 0 ? (
            <Text style={styles.placeholder}>Send a message to start...</Text>
          ) : (
            agent.messages.map((msg) => (
              <MessageBubble key={msg.id} message={msg} />
            ))
          )}

          {/* Pending permissions */}
          {permissions.map((perm) => (
            <PermissionCard
              key={perm.requestId}
              permission={perm}
              onAllow={() => onRespondPermission(agentId, perm.requestId, 'allow')}
              onDeny={() => onRespondPermission(agentId, perm.requestId, 'deny')}
            />
          ))}
        </KeyboardScrollView>

        <InputBar
          onSend={handleSend}
          disabled={isDisabled || permissions.length > 0}
          placeholder={agent.status === 'running' ? 'Agent is working...' : 'Ask anything...'}
          onActivity={onResetPingTimer}
          initialValue={agent.draftText}
          onDraftChange={handleDraftChange}
        />
      </View>
    </View>
  );
}

// Simple back arrow using View transforms
function BackArrow() {
  return (
    <View style={styles.arrowContainer}>
      <View style={styles.arrowLine1} />
      <View style={styles.arrowLine2} />
    </View>
  );
}

// Status indicator with colored dot
function StatusIndicator({ status }: { status: string }) {
  const color =
    status === 'running' ? '#3b82f6' :
    status === 'idle' || status === 'connected' ? '#22c55e' :
    status === 'awaiting_permission' || status === 'starting' ? '#f59e0b' :
    status === 'error' ? '#ef4444' :
    '#6b7280';

  return (
    <View style={styles.statusContainer}>
      <View style={[styles.statusDot, { backgroundColor: color }]} />
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
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a1a',
  },
  backButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingRight: 12,
  },
  backText: {
    color: '#60a5fa',
    fontSize: 16,
    marginLeft: 4,
  },
  headerCenter: {
    flex: 1,
    alignItems: 'center',
  },
  sessionName: {
    color: '#fafafa',
    fontSize: 15,
    fontWeight: '600',
  },
  modelName: {
    color: '#666',
    fontSize: 11,
    marginTop: 1,
  },
  headerRight: {
    width: 50,
    alignItems: 'flex-end',
  },
  // Status
  statusContainer: {
    padding: 4,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  // Stats bar
  statsBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 6,
    backgroundColor: '#0f0f0f',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#1a1a1a',
    gap: 16,
  },
  statItem: {
    color: '#555',
    fontSize: 11,
  },
  contextStat: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  contextBarLarge: {
    width: 40,
    height: 3,
    backgroundColor: '#1f1f1f',
    borderRadius: 2,
    overflow: 'hidden',
  },
  contextFill: {
    height: '100%',
    borderRadius: 2,
  },
  // Main
  main: {
    flex: 1,
  },
  chatArea: {
    flex: 1,
  },
  chatContent: {
    padding: 16,
    paddingBottom: 16,
  },
  placeholder: {
    color: '#555',
    fontSize: 14,
    textAlign: 'center',
    marginTop: 40,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyText: {
    color: '#555',
    fontSize: 14,
  },
  // Permission card
  permissionCard: {
    backgroundColor: '#141414',
    borderRadius: 8,
    padding: 16,
    marginVertical: 8,
    borderWidth: 1,
    borderColor: '#2a2a2a',
  },
  permissionTitle: {
    color: '#fafafa',
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 8,
  },
  permissionToolName: {
    color: '#e5e5e5',
    fontSize: 13,
    fontWeight: '500',
    marginBottom: 8,
  },
  permissionInput: {
    marginBottom: 12,
  },
  permissionButtons: {
    flexDirection: 'row',
    gap: 12,
  },
  denyButton: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 6,
    alignItems: 'center',
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: '#333',
  },
  denyText: {
    color: '#888',
    fontWeight: '500',
    fontSize: 14,
  },
  allowButton: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 6,
    alignItems: 'center',
    backgroundColor: '#fff',
  },
  allowText: {
    color: '#000',
    fontWeight: '600',
    fontSize: 14,
  },
  // Back arrow
  arrowContainer: {
    width: 12,
    height: 20,
    justifyContent: 'center',
  },
  arrowLine1: {
    position: 'absolute',
    width: 10,
    height: 2,
    backgroundColor: '#60a5fa',
    borderRadius: 1,
    transform: [{ rotate: '-45deg' }, { translateY: -3 }],
  },
  arrowLine2: {
    position: 'absolute',
    width: 10,
    height: 2,
    backgroundColor: '#60a5fa',
    borderRadius: 1,
    transform: [{ rotate: '45deg' }, { translateY: 3 }],
  },
});
