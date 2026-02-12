import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  TextInput,
  ScrollView,
  ActivityIndicator,
  Alert,
  Image,
  StyleSheet,
  Platform,
  Keyboard,
} from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { BottomModal } from './BottomModal';
import type { AgentType, Project, ProviderModelOption } from '../state/types';

interface CreateAgentModalProps {
  visible: boolean;
  projects: Project[];
  projectsLoading: boolean;
  modelsByType: Record<string, ProviderModelOption[]>;
  modelsLoadingType: AgentType | null;
  onClose: () => void;
  onSubmit: (config: {
    agentType: AgentType;
    model?: string;
    projectId?: string;
    worktreePath?: string;
  }) => void;
  onRequestProjects: () => void;
  onRequestModels: (type: AgentType) => void;
  onCreateWorktree: (projectId: string, branchName: string) => void;
  onUnregisterProject: (projectId: string) => void;
  /** Pre-select a project+worktree — selecting a type will immediately submit */
  initialProjectId?: string;
  initialWorktreePath?: string;
}

type Step = 'type' | 'model' | 'project';

// Agent type options with branding
const AGENT_TYPES: Array<{
  type: AgentType;
  label: string;
  color: string;
  bg: string;
}> = [
  { type: 'claude', label: 'Claude Code', color: '#D97757', bg: '#FFFFFF' },
  { type: 'codex', label: 'Codex', color: '#111111', bg: '#FFFFFF' },
  { type: 'opencode', label: 'OpenCode', color: '#3B82F6', bg: '#FFFFFF' },
];

const CLAUDE_LOGO_PATH = 'M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z';
const OPENAI_LOGO_PATH = 'M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z';

// Project icon component — favicon image or neutral letter fallback
function ProjectIcon({ project, size = 32 }: { project: Project; size?: number }) {
  if (project.icon) {
    return (
      <Image
        source={{ uri: project.icon }}
        style={{ width: size, height: size, borderRadius: size * 0.22 }}
      />
    );
  }

  const letter = project.name.charAt(0).toUpperCase();

  return (
    <View style={[styles.projectIconFallback, {
      width: size,
      height: size,
      borderRadius: size * 0.22,
    }]}>
      <Text style={[styles.projectIconLetter, { fontSize: size * 0.48 }]}>
        {letter}
      </Text>
    </View>
  );
}

export function CreateAgentModal({
  visible,
  projects,
  projectsLoading,
  modelsByType,
  modelsLoadingType,
  onClose,
  onSubmit,
  onRequestProjects,
  onRequestModels,
  onCreateWorktree,
  onUnregisterProject,
  initialProjectId,
  initialWorktreePath,
}: CreateAgentModalProps) {
  const [step, setStep] = useState<Step>('type');
  const [selectedType, setSelectedType] = useState<AgentType>('claude');
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [expandedNewWorktree, setExpandedNewWorktree] = useState<string | null>(null);
  const [newBranchName, setNewBranchName] = useState('');
  const [menuProjectId, setMenuProjectId] = useState<string | null>(null);

  // Reset internal state — called after the Drawer's close animation completes
  const handleDrawerClose = useCallback(() => {
    setStep('type');
    setSelectedType('claude');
    setSelectedModel('');
    setExpandedNewWorktree(null);
    setNewBranchName('');
    setMenuProjectId(null);
    onClose();
  }, [onClose]);

  const handleTypeSelect = useCallback((type: AgentType) => {
    if (initialProjectId && initialWorktreePath) {
      onSubmit({ agentType: type, projectId: initialProjectId, worktreePath: initialWorktreePath });
      onClose();
      return;
    }
    setSelectedType(type);
    setSelectedModel('');
    onRequestModels(type);
    setStep('model');
  }, [initialProjectId, initialWorktreePath, onSubmit, onClose, onRequestModels]);

  const handleModelSelect = useCallback((model: string) => {
    setSelectedModel(model);
    setStep('project');
    onRequestProjects();
  }, [onRequestProjects]);

  const handleWorktreeSelect = useCallback((projectId: string, worktreePath: string) => {
    onSubmit({
      agentType: selectedType,
      model: selectedModel || undefined,
      projectId,
      worktreePath,
    });
    onClose();
  }, [selectedType, selectedModel, onSubmit, onClose]);

  const handleNoProject = useCallback(() => {
    onSubmit({
      agentType: selectedType,
      model: selectedModel || undefined,
    });
    onClose();
  }, [selectedType, selectedModel, onSubmit, onClose]);

  const handleCreateWorktree = useCallback((projectId: string) => {
    const trimmed = newBranchName.trim();
    if (!trimmed) return;
    onCreateWorktree(projectId, trimmed);
    setNewBranchName('');
    setExpandedNewWorktree(null);
    Keyboard.dismiss();
  }, [newBranchName, onCreateWorktree]);

  const handleBack = useCallback(() => {
    if (step === 'project') {
      setStep('model');
    } else {
      setStep('type');
    }
    setExpandedNewWorktree(null);
    setNewBranchName('');
    setMenuProjectId(null);
  }, [step]);

  const handleUnregister = useCallback((projectId: string, projectName: string) => {
    setMenuProjectId(null);
    Alert.alert(
      'Unregister Project',
      `Remove "${projectName}" from the project list? This won't delete any files.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Unregister',
          style: 'destructive',
          onPress: () => onUnregisterProject(projectId),
        },
      ],
    );
  }, [onUnregisterProject]);

  const stepTitle = step === 'type' ? 'New Agent'
    : step === 'model' ? 'Select Model'
    : 'Select Project';

  const models = modelsByType[selectedType] || [];
  const modelsLoading = modelsLoadingType === selectedType
    && (!modelsByType[selectedType] || modelsByType[selectedType].length === 0);

  return (
    <BottomModal
      isVisible={visible}
      onClose={handleDrawerClose}
      showCloseButton={false}
    >
      {/* Header — Back | Title | Cancel */}
      <View style={styles.sheetHeader}>
        <View style={styles.headerSide}>
          {step !== 'type' && (
            <TouchableOpacity onPress={handleBack} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={styles.backButton}>Back</Text>
            </TouchableOpacity>
          )}
        </View>
        <Text style={styles.sheetTitle}>{stepTitle}</Text>
        <View style={[styles.headerSide, styles.headerSideRight]}>
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Text style={styles.cancelButton}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Step 1: Agent Type */}
      {step === 'type' && (
        <>
          <Text style={styles.stepLabel}>Select agent type</Text>

          {AGENT_TYPES.map(({ type, label, color, bg }) => (
            <TouchableOpacity
              key={type}
              style={styles.typeRow}
              onPress={() => handleTypeSelect(type)}
              activeOpacity={0.7}
            >
              <View style={[styles.typeIcon, { backgroundColor: bg }]}>
                {type === 'claude' ? (
                  <Svg width={16} height={16} viewBox="0 0 24 24">
                    <Path d={CLAUDE_LOGO_PATH} fill={color} fillRule="nonzero" />
                  </Svg>
                ) : type === 'codex' ? (
                  <Svg width={16} height={16} viewBox="0 0 24 24">
                    <Path d={OPENAI_LOGO_PATH} fill={color} fillRule="evenodd" />
                  </Svg>
                ) : (
                  <Text style={[styles.typeIconLetter, { color }]}>
                    {type.charAt(0).toUpperCase()}
                  </Text>
                )}
              </View>
              <Text style={styles.typeLabel}>{label}</Text>
              <View style={styles.chevron}>
                <View style={[styles.chevronArrow, { borderColor: '#444' }]} />
              </View>
            </TouchableOpacity>
          ))}
        </>
      )}

      {/* Step 2: Model */}
      {step === 'model' && (
        <>
          <Text style={styles.stepLabel}>Select model</Text>

          {modelsLoading ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator color="#555" size="small" />
              <Text style={styles.loadingText}>Loading models...</Text>
            </View>
          ) : models.length === 0 ? (
            <View style={styles.emptyContainer}>
              <Text style={styles.emptyText}>No models found</Text>
              <TouchableOpacity
                style={styles.retryButton}
                onPress={() => onRequestModels(selectedType)}
                activeOpacity={0.75}
              >
                <Text style={styles.retryButtonText}>Retry</Text>
              </TouchableOpacity>
            </View>
          ) : (
            models.map(({ value, label }) => (
              <TouchableOpacity
                key={value}
                style={styles.typeRow}
                onPress={() => handleModelSelect(value)}
                activeOpacity={0.7}
              >
                <View style={styles.modelRowInfo}>
                  <Text style={styles.typeLabel}>{label}</Text>
                </View>
                <View style={styles.chevron}>
                  <View style={[styles.chevronArrow, { borderColor: '#444' }]} />
                </View>
              </TouchableOpacity>
            ))
          )}
        </>
      )}

      {/* Step 3: Project + Worktree */}
      {step === 'project' && (
        <>
          {/* No project option */}
          <TouchableOpacity style={styles.noProjectRow} onPress={handleNoProject} activeOpacity={0.7}>
            <View style={styles.noProjectIcon}>
              <Text style={styles.noProjectIconText}>~</Text>
            </View>
            <View style={styles.noProjectInfo}>
              <Text style={styles.noProjectLabel}>No project</Text>
              <Text style={styles.noProjectHint}>Starts in home directory</Text>
            </View>
          </TouchableOpacity>

          {projectsLoading ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator color="#555" size="small" />
              <Text style={styles.loadingText}>Loading projects...</Text>
            </View>
          ) : projects.length === 0 ? (
            <View style={styles.emptyContainer}>
              <Text style={styles.emptyText}>No projects registered</Text>
              <Text style={styles.emptyHint}>
                Register a project from the terminal:{'\n'}
                node src/launcher.js register /path/to/repo
              </Text>
            </View>
          ) : (
            <ScrollView showsVerticalScrollIndicator={false}>
            {projects.map(project => (
              <View key={project.id} style={styles.projectSection}>
                <View style={styles.sectionHeader}>
                  <ProjectIcon project={project} size={24} />
                  <Text style={styles.sectionName}>{project.name}</Text>
                  <TouchableOpacity
                    style={styles.menuBtn}
                    onPress={() => setMenuProjectId(menuProjectId === project.id ? null : project.id)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Text style={styles.menuBtnText}>···</Text>
                  </TouchableOpacity>
                </View>
                {menuProjectId === project.id && (
                  <View style={styles.menuDropdown}>
                    <TouchableOpacity
                      style={styles.menuItem}
                      onPress={() => handleUnregister(project.id, project.name)}
                      activeOpacity={0.7}
                    >
                      <Text style={styles.menuItemTextDestructive}>Unregister project</Text>
                    </TouchableOpacity>
                  </View>
                )}
                {project.worktrees.map(wt => (
                  <TouchableOpacity
                    key={wt.path}
                    style={styles.worktreeRow}
                    onPress={() => handleWorktreeSelect(project.id, wt.path)}
                    activeOpacity={0.7}
                  >
                    <View style={[styles.branchDot, wt.isMain && styles.branchDotMain]} />
                    <Text style={styles.branchName}>{wt.branch}</Text>
                    {wt.isMain && <Text style={styles.mainBadge}>main</Text>}
                  </TouchableOpacity>
                ))}
                {expandedNewWorktree === project.id ? (
                  <View style={styles.newWorktreeExpanded}>
                    <TextInput
                      style={styles.newWorktreeInput}
                      value={newBranchName}
                      onChangeText={setNewBranchName}
                      placeholder="branch-name"
                      placeholderTextColor="#444"
                      autoCapitalize="none"
                      autoCorrect={false}
                      autoFocus
                      keyboardAppearance="dark"
                      onSubmitEditing={() => handleCreateWorktree(project.id)}
                      onBlur={() => {
                        setTimeout(() => {
                          setExpandedNewWorktree((cur) => cur === project.id ? null : cur);
                          setNewBranchName('');
                        }, 150);
                      }}
                      returnKeyType="done"
                    />
                    <TouchableOpacity
                      style={[styles.createBtn, newBranchName.trim() && styles.createBtnActive]}
                      onPress={() => handleCreateWorktree(project.id)}
                      disabled={!newBranchName.trim()}
                      activeOpacity={0.7}
                    >
                      <Text style={[styles.createBtnText, newBranchName.trim() && styles.createBtnTextActive]}>
                        Create
                      </Text>
                    </TouchableOpacity>
                  </View>
                ) : (
                  <TouchableOpacity
                    style={styles.worktreeRow}
                    onPress={() => {
                      setExpandedNewWorktree(project.id);
                      setNewBranchName('');
                    }}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.newWorktreeText}>+ New worktree...</Text>
                  </TouchableOpacity>
                )}
              </View>
            ))}
            </ScrollView>
          )}
        </>
      )}
    </BottomModal>
  );
}

const styles = StyleSheet.create({
  sheetHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
  },
  headerSide: {
    width: 60,
  },
  headerSideRight: {
    alignItems: 'flex-end',
  },
  sheetTitle: {
    color: '#e5e5e5',
    fontSize: 17,
    fontWeight: '600',
    flex: 1,
    textAlign: 'center',
  },
  cancelButton: {
    color: '#555',
    fontSize: 15,
  },
  backButton: {
    color: '#555',
    fontSize: 15,
  },
  stepLabel: {
    color: '#666',
    fontSize: 13,
    marginBottom: 12,
  },
  // Agent type selection
  typeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1a1a1a',
    borderRadius: 12,
    padding: 14,
    marginBottom: 8,
  },
  typeIcon: {
    width: 32,
    height: 32,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  typeIconLetter: {
    fontSize: 15,
    fontWeight: '700',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  typeLabel: {
    color: '#e5e5e5',
    fontSize: 16,
    fontWeight: '500',
    flex: 1,
  },
  modelRowInfo: {
    flex: 1,
  },
  chevron: {
    width: 20,
    height: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  chevronArrow: {
    width: 8,
    height: 8,
    borderRightWidth: 1.5,
    borderBottomWidth: 1.5,
    transform: [{ rotate: '-45deg' }],
    marginLeft: -3,
  },
  // No project option
  noProjectRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1a1a1a',
    borderRadius: 12,
    padding: 14,
    marginBottom: 16,
  },
  noProjectIcon: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.06)',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  noProjectIconText: {
    color: '#555',
    fontSize: 16,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  noProjectInfo: {
    flex: 1,
  },
  noProjectLabel: {
    color: '#999',
    fontSize: 14,
    fontWeight: '500',
  },
  noProjectHint: {
    color: '#444',
    fontSize: 11,
    marginTop: 2,
  },
  // Project sections
  projectSection: {
    marginBottom: 12,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    gap: 8,
  },
  sectionName: {
    color: '#aaa',
    fontSize: 14,
    fontWeight: '600',
    flex: 1,
  },
  menuBtn: {
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  menuBtnText: {
    color: '#555',
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 1,
  },
  menuDropdown: {
    backgroundColor: '#222',
    borderRadius: 8,
    marginBottom: 4,
    overflow: 'hidden',
  },
  menuItem: {
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  menuItemTextDestructive: {
    color: '#ef4444',
    fontSize: 13,
    fontWeight: '500',
  },
  // Worktree rows
  worktreeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1a1a1a',
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 1,
    gap: 8,
  },
  branchDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#555',
  },
  branchDotMain: {
    backgroundColor: '#22c55e',
  },
  branchName: {
    color: '#ccc',
    fontSize: 14,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    flex: 1,
  },
  mainBadge: {
    color: '#555',
    fontSize: 10,
    fontWeight: '500',
    backgroundColor: 'rgba(255,255,255,0.06)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    overflow: 'hidden',
  },
  newWorktreeText: {
    color: '#555',
    fontSize: 13,
  },
  // New worktree inline input
  newWorktreeExpanded: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1a1a1a',
    paddingVertical: 8,
    paddingHorizontal: 12,
    marginBottom: 1,
    gap: 8,
  },
  newWorktreeInput: {
    flex: 1,
    color: '#e5e5e5',
    fontSize: 14,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  createBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  createBtnActive: {
    backgroundColor: '#fff',
  },
  createBtnText: {
    color: '#444',
    fontSize: 13,
    fontWeight: '500',
  },
  createBtnTextActive: {
    color: '#000',
  },
  // Loading / empty states
  loadingContainer: {
    alignItems: 'center',
    paddingVertical: 30,
    gap: 8,
  },
  loadingText: {
    color: '#555',
    fontSize: 13,
  },
  retryButton: {
    marginTop: 12,
    backgroundColor: '#242424',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  retryButtonText: {
    color: '#ddd',
    fontSize: 13,
    fontWeight: '600',
  },
  emptyContainer: {
    alignItems: 'center',
    paddingVertical: 30,
  },
  emptyText: {
    color: '#555',
    fontSize: 14,
    fontWeight: '500',
    marginBottom: 8,
  },
  emptyHint: {
    color: '#3a3a3a',
    fontSize: 12,
    textAlign: 'center',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    lineHeight: 18,
  },
  // Project icon fallback
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
});
