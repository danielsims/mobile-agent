import React from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  Platform,
  ActivityIndicator,
  Image,
} from 'react-native';
import type { Project, GitLogCommit } from '../state/types';

interface CommitsTabContentProps {
  projects: Project[];
  gitLogMap: Map<string, GitLogCommit[]>;
  gitLogLoading: Set<string>;
}

// --- Ref parsing & classification ---

interface ParsedRef {
  label: string;
  kind: 'head' | 'tag' | 'remote' | 'local';
}

function parseRefs(refs: string[]): ParsedRef[] {
  const result: ParsedRef[] = [];
  for (const raw of refs) {
    // "HEAD -> feat/branch" → HEAD badge + local branch badge
    if (raw.startsWith('HEAD -> ')) {
      result.push({ label: 'HEAD', kind: 'head' });
      result.push({ label: raw.slice(8), kind: 'local' });
    } else if (raw === 'HEAD') {
      result.push({ label: 'HEAD', kind: 'head' });
    } else if (raw.startsWith('tag: ')) {
      result.push({ label: raw.slice(5), kind: 'tag' });
    } else if (raw.startsWith('origin/')) {
      result.push({ label: raw, kind: 'remote' });
    } else {
      result.push({ label: raw, kind: 'local' });
    }
  }
  return result;
}

const REF_COLORS: Record<ParsedRef['kind'], { bg: string; fg: string }> = {
  local:  { bg: 'rgba(34,197,94,0.15)',  fg: '#22c55e' },
  remote: { bg: 'rgba(59,130,246,0.15)', fg: '#3b82f6' },
  tag:    { bg: 'rgba(245,158,11,0.15)', fg: '#f59e0b' },
  head:   { bg: 'rgba(168,85,247,0.15)', fg: '#a855f7' },
};

// --- Author avatar colors (deterministic from name) ---

const AVATAR_COLORS = [
  '#3b82f6', '#22c55e', '#f59e0b', '#ef4444',
  '#8b5cf6', '#ec4899', '#06b6d4', '#f97316',
];

function avatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function authorInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

// --- Timeline constants ---

const TIMELINE_WIDTH = 28;
const DOT_RADIUS = 3.5;
const ROW_MIN_HEIGHT = 52;

// --- ProjectIcon ---

function ProjectIcon({ project, size = 24 }: { project: Project; size?: number }) {
  if (project.icon) {
    return (
      <Image
        source={{ uri: project.icon }}
        style={{ width: size, height: size, borderRadius: size * 0.22 }}
      />
    );
  }
  return (
    <View style={[styles.projectIconFallback, { width: size, height: size, borderRadius: size * 0.22 }]}>
      <Text style={[styles.projectIconLetter, { fontSize: size * 0.48 }]}>
        {project.name.charAt(0).toUpperCase()}
      </Text>
    </View>
  );
}

// --- CommitRow ---

function CommitRow({ commit, isFirst, isLast }: { commit: GitLogCommit; isFirst: boolean; isLast: boolean }) {
  const refs = parseRefs(commit.refs);
  const color = avatarColor(commit.author);
  const initials = authorInitials(commit.author);
  const isMerge = commit.parents.length > 1;

  const dotSize = isMerge ? (DOT_RADIUS + 1) * 2 : DOT_RADIUS * 2;

  return (
    <View style={styles.commitRow}>
      {/* Timeline column — flex-based: top line, dot, bottom line */}
      <View style={styles.timelineCol}>
        <View style={[styles.timelineSeg, !isFirst && styles.timelineSegVisible]} />
        <View style={[
          styles.timelineDot,
          { width: dotSize, height: dotSize, borderRadius: dotSize / 2 },
          isMerge
            ? { backgroundColor: '#0a0a0a', borderWidth: 1.5, borderColor: '#555' }
            : { backgroundColor: '#555' },
        ]} />
        <View style={[styles.timelineSeg, !isLast && styles.timelineSegVisible]} />
      </View>

      {/* Content */}
      <View style={styles.commitContent}>
        {/* Subject + inline refs */}
        <View style={styles.subjectRow}>
          <Text style={styles.commitSubject} numberOfLines={1}>
            {commit.subject}
          </Text>
        </View>
        {refs.length > 0 && (
          <View style={styles.refRow}>
            {refs.map((r, j) => {
              const c = REF_COLORS[r.kind];
              return (
                <View key={`${r.label}-${j}`} style={[styles.refBadge, { backgroundColor: c.bg }]}>
                  <Text style={[styles.refText, { color: c.fg }]}>{r.label}</Text>
                </View>
              );
            })}
          </View>
        )}

        {/* Meta row: author avatar + name + hash + time */}
        <View style={styles.metaRow}>
          <View style={[styles.authorAvatar, { backgroundColor: color }]}>
            <Text style={styles.authorInitials}>{initials}</Text>
          </View>
          <Text style={styles.authorName} numberOfLines={1}>{commit.author}</Text>
          <Text style={styles.metaSeparator}> · </Text>
          <Text style={styles.commitHash}>{commit.abbrevHash}</Text>
          <Text style={styles.metaSeparator}> · </Text>
          <Text style={styles.commitTime}>{commit.relativeTime}</Text>
        </View>
      </View>
    </View>
  );
}

// --- Main export ---

export function CommitsTabContent({
  projects,
  gitLogMap,
  gitLogLoading,
}: CommitsTabContentProps) {
  const allEmpty = projects.every(p => {
    const commits = gitLogMap.get(p.path);
    return !commits || commits.length === 0;
  });
  const allLoaded = projects.every(p => !gitLogLoading.has(p.path));
  const anyLoading = projects.some(p => gitLogLoading.has(p.path));

  if (anyLoading && allEmpty) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color="#555" size="small" />
      </View>
    );
  }

  if (allLoaded && allEmpty) {
    return (
      <View style={styles.centered}>
        <Text style={styles.emptyText}>No commits</Text>
        <Text style={styles.emptySubtext}>Commit history will appear here</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {projects.map(project => {
        const commits = gitLogMap.get(project.path);
        const isLoading = gitLogLoading.has(project.path);

        if (!commits && !isLoading) return null;

        return (
          <View key={project.id} style={styles.projectSection}>
            <View style={styles.sectionHeader}>
              <ProjectIcon project={project} />
              <Text style={styles.sectionName}>{project.name}</Text>
              {isLoading && <ActivityIndicator color="#444" size="small" />}
            </View>

            {!commits || commits.length === 0 ? (
              isLoading ? null : (
                <View style={styles.emptySectionRow}>
                  <Text style={styles.emptySubtext}>No commits</Text>
                </View>
              )
            ) : (
              commits.map((commit, i) => (
                <CommitRow
                  key={commit.hash}
                  commit={commit}
                  isFirst={i === 0}
                  isLast={i === commits.length - 1}
                />
              ))
            )}
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    paddingBottom: 20,
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
  projectSection: {
    marginTop: 4,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  sectionName: {
    color: '#aaa',
    fontSize: 14,
    fontWeight: '600',
    flex: 1,
  },
  projectIconFallback: {
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  projectIconLetter: {
    color: '#888',
    fontWeight: '600',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  emptySectionRow: {
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  // Commit row
  commitRow: {
    flexDirection: 'row',
    minHeight: ROW_MIN_HEIGHT,
  },
  timelineCol: {
    width: TIMELINE_WIDTH,
    marginLeft: 12,
    alignItems: 'center',
  },
  timelineSeg: {
    flex: 1,
    width: 1.5,
    backgroundColor: 'transparent',
  },
  timelineSegVisible: {
    backgroundColor: '#222',
  },
  timelineDot: {
  },
  commitContent: {
    flex: 1,
    paddingVertical: 8,
    paddingRight: 16,
    paddingLeft: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.04)',
  },
  subjectRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  commitSubject: {
    color: '#ddd',
    fontSize: 13,
    fontWeight: '500',
    flex: 1,
  },
  refRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    marginTop: 4,
  },
  refBadge: {
    paddingHorizontal: 5,
    paddingVertical: 1.5,
    borderRadius: 3,
    overflow: 'hidden',
  },
  refText: {
    fontSize: 9,
    fontWeight: '700',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  // Meta row
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
  },
  authorAvatar: {
    width: 16,
    height: 16,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 5,
  },
  authorInitials: {
    color: '#fff',
    fontSize: 7.5,
    fontWeight: '700',
  },
  authorName: {
    color: '#666',
    fontSize: 11,
    maxWidth: 100,
  },
  commitHash: {
    color: '#555',
    fontSize: 10,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  metaSeparator: {
    color: '#333',
    fontSize: 10,
  },
  commitTime: {
    color: '#444',
    fontSize: 10,
  },
});
