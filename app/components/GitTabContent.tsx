import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Platform,
  ActivityIndicator,
} from 'react-native';
import Svg, { Path } from 'react-native-svg';
import * as Haptics from 'expo-haptics';
import { FileTypeIcon } from './FileTypeIcon';
import type { AgentStatus } from '../state/types';

export interface GitFile {
  file: string;
  status: string;
}

export interface GitStatusData {
  branch: string;
  ahead: number;
  behind: number;
  files: GitFile[];
}

interface GitTabContentProps {
  agentId: string;
  agentStatus: AgentStatus;
  gitStatus: GitStatusData | null;
  gitDiff: string | null;
  loading: boolean;
  diffLoading: boolean;
  onRequestStatus: () => void;
  onRequestDiff: (filePath: string) => void;
}

// VS Code git decoration colors
const STATUS_COLORS: Record<string, string> = {
  M: '#e2c08d',  // Modified
  A: '#73c991',  // Added (staged)
  D: '#c74e39',  // Deleted
  R: '#73c991',  // Renamed
  U: '#73c991',  // Untracked
  C: '#e4676b',  // Conflict / unmerged
};

// Normalize raw status codes (handles legacy ?? and other multi-char codes)
function normalizeStatus(raw: string): string {
  if (raw === '??' || raw === '?') return 'U';
  if (raw === 'UU' || raw === 'AA' || raw === 'DD' || raw === 'AU' || raw === 'UA') return 'C';
  if (raw.length === 2) {
    const y = raw[1];
    if (y !== ' ') return y;
    return raw[0];
  }
  return raw;
}

function getStatusColor(status: string): string {
  const s = normalizeStatus(status);
  return STATUS_COLORS[s] || '#888';
}

function getStatusLabel(status: string): string {
  const s = normalizeStatus(status);
  const labels: Record<string, string> = {
    M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed',
    U: 'Untracked', C: 'Conflict',
  };
  return labels[s] || s;
}

function getStatusLetter(status: string): string {
  return normalizeStatus(status);
}

interface DiffLine {
  type: 'header' | 'added' | 'removed' | 'context';
  text: string;
}

function parseDiff(raw: string): DiffLine[] {
  if (!raw) return [];
  return raw.split('\n').map(line => {
    if (line.startsWith('@@')) return { type: 'header' as const, text: line };
    if (line.startsWith('+')) return { type: 'added' as const, text: line };
    if (line.startsWith('-')) return { type: 'removed' as const, text: line };
    return { type: 'context' as const, text: line };
  });
}

export function GitTabContent({
  agentId,
  agentStatus,
  gitStatus,
  gitDiff,
  loading,
  diffLoading,
  onRequestStatus,
  onRequestDiff,
}: GitTabContentProps) {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const prevStatus = useRef<AgentStatus>(agentStatus);

  // Fetch on mount
  useEffect(() => {
    onRequestStatus();
  }, [onRequestStatus]);

  // Auto-refresh when agent finishes a turn
  useEffect(() => {
    if (prevStatus.current === 'running' && agentStatus === 'idle') {
      onRequestStatus();
    }
    prevStatus.current = agentStatus;
  }, [agentStatus, onRequestStatus]);

  const handleRefresh = () => {
    if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onRequestStatus();
  };

  const handleFilePress = (file: string) => {
    if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSelectedFile(file);
    onRequestDiff(file);
  };

  const handleBackToList = () => {
    if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSelectedFile(null);
  };

  // Diff view
  if (selectedFile) {
    const diffLines = parseDiff(gitDiff || '');

    return (
      <View style={styles.container}>
        <View style={styles.diffHeader}>
          <TouchableOpacity onPress={handleBackToList} style={styles.backBtn}>
            <View style={styles.backChevron} />
            <Text style={styles.backText}>Files</Text>
          </TouchableOpacity>
          <FileTypeIcon filename={selectedFile} size={14} />
          <Text style={styles.diffFilePath} numberOfLines={1}>{selectedFile}</Text>
        </View>

        {diffLoading ? (
          <View style={styles.centered}>
            <ActivityIndicator color="#555" size="small" />
          </View>
        ) : diffLines.length === 0 ? (
          <View style={styles.centered}>
            <Text style={styles.emptyText}>No diff available</Text>
            <Text style={styles.emptySubtext}>File may be untracked or binary</Text>
          </View>
        ) : (
          <ScrollView style={styles.diffScroll}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View style={styles.diffContent}>
                {diffLines.map((line, i) => (
                  <View
                    key={i}
                    style={[
                      styles.diffLine,
                      line.type === 'added' && styles.diffLineAdded,
                      line.type === 'removed' && styles.diffLineRemoved,
                      line.type === 'header' && styles.diffLineHunk,
                    ]}
                  >
                    <Text
                      style={[
                        styles.diffLineText,
                        line.type === 'added' && styles.diffTextAdded,
                        line.type === 'removed' && styles.diffTextRemoved,
                        line.type === 'header' && styles.diffTextHunk,
                      ]}
                    >
                      {line.text}
                    </Text>
                  </View>
                ))}
              </View>
            </ScrollView>
          </ScrollView>
        )}
      </View>
    );
  }

  // File list view
  const files = gitStatus?.files || [];
  const branch = gitStatus?.branch || '';
  const ahead = gitStatus?.ahead || 0;
  const behind = gitStatus?.behind || 0;

  return (
    <View style={styles.container}>
      <View style={styles.branchHeader}>
        <View style={styles.branchInfo}>
          <GitBranchIcon />
          <Text style={styles.branchName}>{branch || '...'}</Text>
          {(ahead > 0 || behind > 0) && (
            <Text style={styles.aheadBehind}>
              {ahead > 0 ? `↑${ahead}` : ''}{ahead > 0 && behind > 0 ? ' ' : ''}{behind > 0 ? `↓${behind}` : ''}
            </Text>
          )}
        </View>
        <TouchableOpacity onPress={handleRefresh} style={styles.refreshBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <RefreshIcon />
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator color="#555" size="small" />
        </View>
      ) : files.length === 0 ? (
        <View style={styles.centered}>
          <Text style={styles.emptyText}>No changes</Text>
          <Text style={styles.emptySubtext}>Working tree is clean</Text>
        </View>
      ) : (
        <ScrollView style={styles.fileList}>
          <Text style={styles.fileCount}>{files.length} changed file{files.length !== 1 ? 's' : ''}</Text>
          {files.map((f, i) => (
            <TouchableOpacity
              key={`${f.file}-${i}`}
              style={styles.fileRow}
              onPress={() => handleFilePress(f.file)}
              activeOpacity={0.6}
            >
              <FileTypeIcon filename={f.file} size={18} />
              <View style={styles.fileInfo}>
                <Text style={styles.fileName} numberOfLines={1}>{f.file}</Text>
                <Text style={styles.fileStatusLabel}>{getStatusLabel(f.status)}</Text>
              </View>
              <Text style={[styles.fileStatus, { color: getStatusColor(f.status) }]}>
                {getStatusLetter(f.status)}
              </Text>
              <View style={styles.fileChevronWrap}>
                <View style={styles.fileChevronIcon} />
              </View>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

function GitBranchIcon() {
  return (
    <Svg width={14} height={14} viewBox="0 0 24 24" fill="none">
      <Path
        d="M6 3v12M18 9a3 3 0 100-6 3 3 0 000 6zM6 21a3 3 0 100-6 3 3 0 000 6zM18 9a9 9 0 01-9 9"
        stroke="#888"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

function RefreshIcon() {
  return (
    <Svg width={16} height={16} viewBox="0 0 24 24" fill="none">
      <Path
        d="M23 4v6h-6M1 20v-6h6"
        stroke="#888"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"
        stroke="#888"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  branchHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#1a1a1a',
  },
  branchInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  branchName: {
    color: '#e5e5e5',
    fontSize: 14,
    fontWeight: '600',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  aheadBehind: {
    color: '#888',
    fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  refreshBtn: {
    padding: 4,
  },
  fileList: {
    flex: 1,
  },
  fileCount: {
    color: '#555',
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
  },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.04)',
    gap: 8,
  },
  fileStatus: {
    fontSize: 12,
    fontWeight: '600',
    textAlign: 'right',
  },
  fileInfo: {
    flex: 1,
  },
  fileName: {
    color: '#ccc',
    fontSize: 13,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  fileStatusLabel: {
    color: '#555',
    fontSize: 11,
    marginTop: 2,
  },
  fileChevronWrap: {
    marginLeft: 8,
  },
  fileChevronIcon: {
    width: 7,
    height: 7,
    borderRightWidth: 1.5,
    borderTopWidth: 1.5,
    borderColor: '#444',
    transform: [{ rotate: '45deg' }],
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyText: {
    color: '#555',
    fontSize: 15,
    fontWeight: '500',
  },
  emptySubtext: {
    color: '#3a3a3a',
    fontSize: 12,
    marginTop: 4,
  },
  diffHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#1a1a1a',
    gap: 8,
  },
  backBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingRight: 4,
  },
  backChevron: {
    width: 8,
    height: 8,
    borderLeftWidth: 1.5,
    borderBottomWidth: 1.5,
    borderColor: '#888',
    transform: [{ rotate: '45deg' }],
    marginLeft: 2,
  },
  backText: {
    color: '#888',
    fontSize: 13,
  },
  diffFilePath: {
    flex: 1,
    color: '#ccc',
    fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  diffScroll: {
    flex: 1,
  },
  diffContent: {
    paddingVertical: 4,
    minWidth: '100%',
  },
  diffLine: {
    paddingHorizontal: 12,
    paddingVertical: 1,
  },
  diffLineAdded: {
    backgroundColor: 'rgba(34,197,94,0.08)',
  },
  diffLineRemoved: {
    backgroundColor: 'rgba(239,68,68,0.08)',
  },
  diffLineHunk: {
    backgroundColor: 'rgba(59,130,246,0.06)',
    marginTop: 4,
    paddingVertical: 3,
  },
  diffLineText: {
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    lineHeight: 16,
    color: '#999',
  },
  diffTextAdded: {
    color: '#22c55e',
  },
  diffTextRemoved: {
    color: '#ef4444',
  },
  diffTextHunk: {
    color: '#3b82f6',
  },
});
