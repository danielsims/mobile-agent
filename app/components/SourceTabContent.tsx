import React, { useEffect, useMemo } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  Platform,
  ActivityIndicator,
  Image,
} from 'react-native';
import Svg, { Circle, Line, Path } from 'react-native-svg';
import type { Project, GitLogCommit } from '../state/types';

interface SourceTabContentProps {
  projects: Project[];
  gitLogMap: Map<string, GitLogCommit[]>;
  gitLogLoading: Set<string>;
  onRequestGitLog: (projectPath: string) => void;
}

// --- Graph types ---

interface GraphNode {
  commit: GitLogCommit;
  lane: number;
  y: number;
}

interface GraphEdge {
  fromLane: number;
  fromY: number;
  toLane: number;
  toY: number;
  color: string;
}

// --- Constants ---

const ROW_HEIGHT = 40;
const LANE_WIDTH = 16;
const LANE_OFFSET = 14;
const NODE_RADIUS = 4;
const LANE_COLORS = [
  '#3b82f6', '#22c55e', '#f59e0b', '#ef4444',
  '#8b5cf6', '#ec4899', '#06b6d4', '#f97316',
];

// --- Ref classification (same as CommitsTabContent) ---

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

// --- ProjectIcon (same pattern as CommitsTabContent) ---

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

// --- Graph algorithm ---

function laneColor(lane: number): string {
  return LANE_COLORS[lane % LANE_COLORS.length];
}

function laneX(lane: number): number {
  return LANE_OFFSET + lane * LANE_WIDTH;
}

function computeGraph(commits: GitLogCommit[]): { nodes: GraphNode[]; edges: GraphEdge[]; maxLane: number } {
  if (commits.length === 0) {
    return { nodes: [], edges: [], maxLane: 0 };
  }

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  // activeLanes[i] = hash of the commit expected next in that lane, or null if lane is free
  const activeLanes: (string | null)[] = [];

  // Map from commit hash to its node index (for linking edges to parents already placed)
  const hashToNodeIndex = new Map<string, number>();

  // Track which lane each hash is expected in (for fast lookup)
  const hashToLane = new Map<string, number>();

  function findOrCreateLane(hash: string): number {
    // Check if a lane already expects this hash
    const existing = hashToLane.get(hash);
    if (existing !== undefined && activeLanes[existing] === hash) {
      return existing;
    }
    // Find first free lane
    for (let i = 0; i < activeLanes.length; i++) {
      if (activeLanes[i] === null) {
        activeLanes[i] = hash;
        hashToLane.set(hash, i);
        return i;
      }
    }
    // Push a new lane
    const lane = activeLanes.length;
    activeLanes.push(hash);
    hashToLane.set(hash, lane);
    return lane;
  }

  for (let i = 0; i < commits.length; i++) {
    const commit = commits[i];
    const y = i * ROW_HEIGHT + ROW_HEIGHT / 2;

    // Step a: Find which lane expects this commit
    let lane = -1;
    for (let l = 0; l < activeLanes.length; l++) {
      if (activeLanes[l] === commit.hash) {
        lane = l;
        break;
      }
    }

    if (lane === -1) {
      // No lane expects this commit; find first null slot or push new
      lane = findOrCreateLane(commit.hash);
    }

    // Step b: Place node
    const node: GraphNode = { commit, lane, y };
    nodes.push(node);
    hashToNodeIndex.set(commit.hash, i);

    const parents = commit.parents || [];

    // Step c & d: Handle parents
    if (parents.length === 0) {
      // Root commit — no parents, free the lane
      activeLanes[lane] = null;
      hashToLane.delete(commit.hash);
    } else {
      // First parent: keep lane pointing to that parent
      const firstParent = parents[0];
      activeLanes[lane] = firstParent;
      hashToLane.set(firstParent, lane);

      // Additional parents (merges): find or create lanes for them
      for (let p = 1; p < parents.length; p++) {
        const parentHash = parents[p];
        // Only create a new lane if no lane already expects this parent
        let parentLane = -1;
        for (let l = 0; l < activeLanes.length; l++) {
          if (activeLanes[l] === parentHash) {
            parentLane = l;
            break;
          }
        }
        if (parentLane === -1) {
          parentLane = findOrCreateLane(parentHash);
        }
      }
    }

    // Clean up any lanes that were expecting this commit hash (besides the one we used)
    // This handles convergence: multiple lanes pointing to same commit
    for (let l = 0; l < activeLanes.length; l++) {
      if (l !== lane && activeLanes[l] === commit.hash) {
        activeLanes[l] = null;
      }
    }
  }

  // Step 3: Generate edges
  const totalHeight = commits.length * ROW_HEIGHT;

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const parents = node.commit.parents || [];

    for (let p = 0; p < parents.length; p++) {
      const parentHash = parents[p];
      const parentIdx = hashToNodeIndex.get(parentHash);

      if (parentIdx !== undefined) {
        // Parent is in the list
        const parentNode = nodes[parentIdx];
        edges.push({
          fromLane: node.lane,
          fromY: node.y,
          toLane: parentNode.lane,
          toY: parentNode.y,
          color: p === 0 ? laneColor(node.lane) : laneColor(parentNode.lane),
        });
      } else {
        // Parent is not in the visible list; draw edge to bottom
        // Determine which lane the parent would be in
        let parentLane = node.lane;
        if (p > 0) {
          // For merge parents that weren't placed, use a different lane
          // Try to find if any active lane was assigned to this parent
          const assignedLane = hashToLane.get(parentHash);
          if (assignedLane !== undefined) {
            parentLane = assignedLane;
          } else {
            parentLane = node.lane + p;
          }
        }
        edges.push({
          fromLane: node.lane,
          fromY: node.y,
          toLane: parentLane,
          toY: totalHeight,
          color: p === 0 ? laneColor(node.lane) : laneColor(parentLane),
        });
      }
    }
  }

  let maxLane = 0;
  for (const n of nodes) {
    if (n.lane > maxLane) maxLane = n.lane;
  }
  for (const e of edges) {
    if (e.fromLane > maxLane) maxLane = e.fromLane;
    if (e.toLane > maxLane) maxLane = e.toLane;
  }

  return { nodes, edges, maxLane };
}

// --- CommitGraph component ---

function CommitGraph({ commits }: { commits: GitLogCommit[] }) {
  const { nodes, edges, maxLane } = useMemo(() => computeGraph(commits), [commits]);

  if (nodes.length === 0) return null;

  const svgWidth = LANE_OFFSET * 2 + (maxLane + 1) * LANE_WIDTH;
  const svgHeight = commits.length * ROW_HEIGHT;

  return (
    <ScrollView style={styles.graphScroll} showsVerticalScrollIndicator={false}>
      <View style={styles.graphRow}>
        {/* Left column: SVG graph */}
        <Svg width={svgWidth} height={svgHeight}>
          {/* Render edges */}
          {edges.map((edge, i) => {
            if (edge.fromLane === edge.toLane) {
              // Straight vertical line (same lane)
              const x = laneX(edge.fromLane);
              return (
                <Line
                  key={`edge-${i}`}
                  x1={x}
                  y1={edge.fromY}
                  x2={x}
                  y2={edge.toY}
                  stroke={edge.color}
                  strokeWidth={1.5}
                />
              );
            } else {
              // Curved path between different lanes (merge / branch)
              const x1 = laneX(edge.fromLane);
              const y1 = edge.fromY;
              const x2 = laneX(edge.toLane);
              const y2 = edge.toY;
              const midY = (y1 + y2) / 2;
              const d = `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;
              return (
                <Path
                  key={`edge-${i}`}
                  d={d}
                  stroke={edge.color}
                  strokeWidth={1.5}
                  fill="none"
                />
              );
            }
          })}

          {/* Render nodes on top of edges */}
          {nodes.map((node, i) => {
            const cx = laneX(node.lane);
            const cy = node.y;
            const color = laneColor(node.lane);
            return (
              <Circle
                key={`node-${i}`}
                cx={cx}
                cy={cy}
                r={NODE_RADIUS}
                fill={color}
                stroke="#0a0a0a"
                strokeWidth={1.5}
              />
            );
          })}
        </Svg>

        {/* Right column: commit metadata */}
        <View style={[styles.metadataColumn, { height: svgHeight }]}>
          {nodes.map((node, i) => {
            const commit = node.commit;
            const refs = commit.refs || [];
            return (
              <View
                key={`meta-${i}`}
                style={[
                  styles.metadataRow,
                  { top: i * ROW_HEIGHT, height: ROW_HEIGHT },
                ]}
              >
                <Text style={styles.commitSubject} numberOfLines={1}>
                  {commit.subject}
                </Text>
                <View style={styles.commitMetaRow}>
                  <Text style={styles.commitHash}>{commit.abbrevHash}</Text>
                  <Text style={styles.commitSeparator}> · </Text>
                  <Text style={styles.commitTime}>{commit.relativeTime}</Text>
                  {refs.length > 0 && refs.map((ref, j) => {
                    const kind = classifyRef(ref);
                    const refStyle = REF_STYLES[kind];
                    return (
                      <View
                        key={`ref-${j}`}
                        style={[styles.refBadge, { backgroundColor: refStyle.backgroundColor, marginLeft: 4 }]}
                      >
                        <Text style={[styles.refText, { color: refStyle.color }]}>
                          {ref}
                        </Text>
                      </View>
                    );
                  })}
                </View>
              </View>
            );
          })}
        </View>
      </View>
    </ScrollView>
  );
}

// --- Main export ---

export function SourceTabContent({
  projects,
  gitLogMap,
  gitLogLoading,
  onRequestGitLog,
}: SourceTabContentProps) {
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
        <Text style={styles.emptySubtext}>Commit graph will appear here</Text>
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
              <CommitGraph commits={commits} />
            )}
          </View>
        );
      })}
    </ScrollView>
  );
}

// --- Styles ---

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
  // Graph layout
  graphScroll: {
    flex: 1,
  },
  graphRow: {
    flexDirection: 'row',
  },
  metadataColumn: {
    flex: 1,
    position: 'relative',
  },
  metadataRow: {
    position: 'absolute',
    left: 0,
    right: 0,
    justifyContent: 'center',
    paddingLeft: 6,
    paddingRight: 16,
  },
  commitSubject: {
    color: '#ccc',
    fontSize: 12,
    lineHeight: 16,
  },
  commitMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 1,
  },
  commitHash: {
    color: '#555',
    fontSize: 10,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  commitSeparator: {
    color: '#555',
    fontSize: 10,
  },
  commitTime: {
    color: '#555',
    fontSize: 10,
  },
  refBadge: {
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 3,
    overflow: 'hidden',
  },
  refText: {
    fontSize: 9,
    fontWeight: '600',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
});
