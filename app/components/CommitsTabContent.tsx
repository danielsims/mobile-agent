import React, { useEffect } from 'react';
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
  onRequestGitLog: (projectPath: string) => void;
}

function classifyRef(ref: string): 'head' | 'tag' | 'remote' | 'local' {
  if (ref === 'HEAD') return 'head';
  if (ref.startsWith('tag:')) return 'tag';
  if (ref.startsWith('origin/')) return 'remote';
  return 'local';
}

const REF_STYLES: Record<ReturnType<typeof classifyRef>, { backgroundColor: string; color: string }> = {
  local:  { backgroundColor: 'rgba(34,197,94,0.15)',  color: '#22c55e' },
  remote: { backgroundColor: 'rgba(59,130,246,0.15)', color: '#3b82f6' },
  tag:    { backgroundColor: 'rgba(245,158,11,0.15)', color: '#f59e0b' },
  head:   { backgroundColor: 'rgba(168,85,247,0.15)', color: '#a855f7' },
};

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

export function CommitsTabContent({
  projects,
  gitLogMap,
  gitLogLoading,
  onRequestGitLog,
}: CommitsTabContentProps) {
  // Request git log for each project on mount
  useEffect(() => {
    for (const project of projects) {
      onRequestGitLog(project.path);
    }
  }, []); // Only on mount

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
                <View key={`${commit.hash}-${i}`} style={styles.commitRow}>
                  <Text style={styles.commitHash}>{commit.abbrevHash}</Text>
                  <View style={styles.commitInfo}>
                    <Text style={styles.commitSubject} numberOfLines={1}>
                      {commit.subject}
                    </Text>
                    <Text style={styles.commitMeta}>
                      {commit.author} · {commit.relativeTime}
                    </Text>
                    {commit.refs.length > 0 && (
                      <View style={styles.refRow}>
                        {commit.refs.map((ref, j) => {
                          const kind = classifyRef(ref);
                          const refStyle = REF_STYLES[kind];
                          return (
                            <View
                              key={`${ref}-${j}`}
                              style={[styles.refBadge, { backgroundColor: refStyle.backgroundColor }]}
                            >
                              <Text style={[styles.refText, { color: refStyle.color }]}>
                                {ref}
                              </Text>
                            </View>
                          );
                        })}
                      </View>
                    )}
                  </View>
                </View>
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
  commitRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.04)',
    gap: 10,
  },
  commitHash: {
    color: '#555',
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    marginTop: 2,
  },
  commitInfo: {
    flex: 1,
  },
  commitSubject: {
    color: '#ccc',
    fontSize: 13,
  },
  commitMeta: {
    color: '#555',
    fontSize: 11,
    marginTop: 2,
  },
  refRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    marginTop: 4,
  },
  refBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    overflow: 'hidden',
  },
  refText: {
    fontSize: 10,
    fontWeight: '600',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
});
