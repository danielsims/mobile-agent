import React, { useRef, useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Animated,
  Dimensions,
  PanResponder,
  Platform,
  KeyboardAvoidingView,
  ActivityIndicator,
} from 'react-native';
import Svg, { Path } from 'react-native-svg';
import * as Haptics from 'expo-haptics';
import * as WebBrowser from 'expo-web-browser';
import { BottomModal } from './BottomModal';
import type { Skill } from '../state/types';

const SCREEN_WIDTH = Dimensions.get('window').width;
const SWIPE_THRESHOLD = SCREEN_WIDTH * 0.25;
const EDGE_WIDTH = 30;

interface SkillsScreenProps {
  onBack: () => void;
  skills: Skill[];
  onUpdateSkill?: (name: string, body: string) => void;
  onInstallSkill?: (packageRef: string) => void;
  onSearchSkills?: (query: string) => void;
  onClearSearchResults?: () => void;
  searchResults?: SkillSearchResult[];
  searchLoading?: boolean;
}

export interface SkillSearchResult {
  name: string;
  description: string;
  packageRef: string;
  url?: string;
}

function SkillIcon({ icon, size = 36 }: { icon: string | null; size?: number }) {
  const iconSize = size * 0.44;
  if (icon === 'commit') {
    return (
      <View style={[iconStyles.circle, { width: size, height: size, borderRadius: size / 2 }]}>
        <Svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill="none">
          <Path d="M12 16a4 4 0 100-8 4 4 0 000 8zM12 3v5M12 16v5" stroke="#ccc" strokeWidth={2} strokeLinecap="round" />
        </Svg>
      </View>
    );
  }
  if (icon === 'vercel') {
    return (
      <View style={[iconStyles.circle, { width: size, height: size, borderRadius: size / 2 }]}>
        <Svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill="none">
          <Path d="M12 2L2 22h20L12 2z" fill="#ccc" />
        </Svg>
      </View>
    );
  }
  return (
    <View style={[iconStyles.circle, { width: size, height: size, borderRadius: size / 2 }]}>
      <Svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill="none">
        <Path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" stroke="#ccc" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      </Svg>
    </View>
  );
}

function ChevronRight({ size = 14, color = '#444' }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M9 18l6-6-6-6" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

// Detail modal can show either an installed Skill or a search result
type SelectedItem =
  | { kind: 'installed'; skill: Skill }
  | { kind: 'search'; result: SkillSearchResult };

export function SkillsScreen({
  onBack,
  skills,
  onUpdateSkill,
  onInstallSkill,
  onSearchSkills,
  onClearSearchResults,
  searchResults = [],
  searchLoading = false,
}: SkillsScreenProps) {
  const swipeX = useRef(new Animated.Value(-SCREEN_WIDTH)).current;
  const [selected, setSelected] = useState<SelectedItem | null>(null);
  const [editBody, setEditBody] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    Animated.timing(swipeX, {
      toValue: 0,
      duration: 250,
      useNativeDriver: true,
    }).start();
  }, [swipeX]);

  const edgeSwipeActive = useRef(false);
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponderCapture: (evt) => {
        const startX = evt.nativeEvent.pageX;
        if (startX > SCREEN_WIDTH - EDGE_WIDTH) {
          edgeSwipeActive.current = true;
          return true;
        }
        edgeSwipeActive.current = false;
        return false;
      },
      onMoveShouldSetPanResponder: (_evt, gesture) =>
        edgeSwipeActive.current && gesture.dx < -10 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.5,
      onMoveShouldSetPanResponderCapture: (_evt, gesture) =>
        edgeSwipeActive.current && gesture.dx < -10 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.5,
      onPanResponderMove: (_evt, gesture) => {
        if (gesture.dx < 0) swipeX.setValue(gesture.dx);
      },
      onPanResponderRelease: (_evt, gesture) => {
        edgeSwipeActive.current = false;
        if (gesture.dx < -SWIPE_THRESHOLD) {
          Animated.timing(swipeX, { toValue: -SCREEN_WIDTH, duration: 150, useNativeDriver: true }).start(() => onBack());
        } else {
          Animated.spring(swipeX, { toValue: 0, useNativeDriver: true, tension: 80, friction: 10 }).start();
        }
      },
      onPanResponderTerminate: () => {
        edgeSwipeActive.current = false;
        Animated.spring(swipeX, { toValue: 0, useNativeDriver: true }).start();
      },
    }),
  ).current;

  const animateBack = useCallback(() => {
    Animated.timing(swipeX, { toValue: -SCREEN_WIDTH, duration: 250, useNativeDriver: true }).start(() => onBack());
  }, [swipeX, onBack]);

  const backdropOpacity = swipeX.interpolate({
    inputRange: [-SCREEN_WIDTH, 0],
    outputRange: [0, 0.5],
    extrapolate: 'clamp',
  });

  // Built-in skills (commit-changes, describe-branch, etc.) are only surfaced
  // in the git page worktree context menu — not shown on the skills page.
  const userSkills = skills.filter(s => s.source === 'user');

  const handleSkillPress = (skill: Skill) => {
    if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSelected({ kind: 'installed', skill });
    setEditBody(skill.body);
    setIsEditing(false);
  };

  const handleSearchResultPress = (result: SkillSearchResult) => {
    if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSelected({ kind: 'search', result });
    setIsEditing(false);
  };

  const handleSave = () => {
    if (selected?.kind === 'installed' && onUpdateSkill) {
      onUpdateSkill(selected.skill.name, editBody);
      setSelected({ kind: 'installed', skill: { ...selected.skill, body: editBody } });
    }
    setIsEditing(false);
  };

  const handleInstall = () => {
    if (selected?.kind === 'search' && onInstallSkill) {
      onInstallSkill(selected.result.packageRef);
      setSelected(null);
    }
  };

  const handleSearch = () => {
    if (searchQuery.trim() && onSearchSkills) {
      onSearchSkills(searchQuery.trim());
    }
  };

  // Derive display values from selected item
  const modalTitle = selected?.kind === 'installed' ? selected.skill.name : selected?.kind === 'search' ? selected.result.name : '';
  const modalDescription = selected?.kind === 'installed' ? selected.skill.description : selected?.kind === 'search' ? selected.result.description : '';
  const modalBody = selected?.kind === 'installed' ? selected.skill.body : null;
  const isEditable = selected?.kind === 'installed' && (selected.skill.source === 'builtin' || selected.skill.source === 'user');
  const isSearchResult = selected?.kind === 'search';

  return (
    <View style={styles.overlay}>
      <Animated.View style={[styles.backdrop, { opacity: backdropOpacity }]} pointerEvents="none" />

      <Animated.View
        style={[styles.container, { transform: [{ translateX: swipeX }] }]}
        {...panResponder.panHandlers}
      >
        <View style={styles.header}>
          <Svg width={18} height={18} viewBox="0 0 24 24" fill="none">
            <Path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" stroke="#888" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
          </Svg>
          <Text style={styles.headerTitle}>Skills</Text>
          <View style={styles.headerSpacer} />
          <TouchableOpacity onPress={animateBack} style={styles.closeButton} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Text style={styles.closeText}>Done</Text>
          </TouchableOpacity>
        </View>

        <ScrollView style={styles.content} contentContainerStyle={styles.contentInner} keyboardShouldPersistTaps="handled">
          {/* Search input */}
          <View style={styles.searchBar}>
            <View style={styles.searchInputWrapper}>
              <Svg width={14} height={14} viewBox="0 0 24 24" fill="none" style={{ marginRight: 8 }}>
                <Path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" stroke="#555" strokeWidth={2} strokeLinecap="round" />
              </Svg>
              <TextInput
                style={styles.searchInput}
                placeholder="Search skills marketplace..."
                placeholderTextColor="#444"
                value={searchQuery}
                onChangeText={(text) => {
                  setSearchQuery(text);
                  onClearSearchResults?.();
                }}
                onSubmitEditing={handleSearch}
                returnKeyType="search"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardAppearance="dark"
              />
              {searchLoading && (
                <ActivityIndicator size="small" color="#555" />
              )}
            </View>
          </View>

          {/* Search results section */}
          {searchResults.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Search Results</Text>
              {searchResults.map((result, idx) => (
                <TouchableOpacity
                  key={result.packageRef || idx}
                  style={styles.skillRow}
                  activeOpacity={0.7}
                  onPress={() => handleSearchResultPress(result)}
                >
                  <SkillIcon icon="vercel" />
                  <View style={styles.skillContent}>
                    <Text style={styles.skillName}>{result.name}</Text>
                    {result.description ? (
                      <Text style={styles.skillDescription} numberOfLines={2}>{result.description}</Text>
                    ) : (
                      <Text style={styles.skillRef}>{result.packageRef}</Text>
                    )}
                  </View>
                  <ChevronRight />
                </TouchableOpacity>
              ))}
            </View>
          )}

          {/* User-installed skills */}
          {userSkills.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Installed</Text>
              {userSkills.map(skill => (
                <TouchableOpacity
                  key={skill.name}
                  style={styles.skillRow}
                  activeOpacity={0.7}
                  onPress={() => handleSkillPress(skill)}
                >
                  <View style={styles.skillContent}>
                    <Text style={styles.skillName}>{skill.name}</Text>
                    <Text style={styles.skillDescription} numberOfLines={2}>{skill.description}</Text>
                  </View>
                  <ChevronRight />
                </TouchableOpacity>
              ))}
            </View>
          )}

          {/* Empty state — only when no skills AND no search results */}
          {userSkills.length === 0 && searchResults.length === 0 && !searchLoading && (
            <View style={styles.emptyContainer}>
              <Text style={styles.emptyText}>No skills installed</Text>
              <Text style={styles.emptySubtext}>
                Search above to find and install skills
              </Text>
            </View>
          )}
        </ScrollView>
      </Animated.View>

      {/* Detail / install modal */}
      <BottomModal
        isVisible={selected !== null}
        onClose={() => { setSelected(null); setIsEditing(false); }}
        title={modalTitle}
      >
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <ScrollView style={detailStyles.scroll} keyboardShouldPersistTaps="handled">
            {modalDescription ? (
              <Text style={detailStyles.description}>{modalDescription}</Text>
            ) : null}

            {/* Package ref + view on skills.sh for search results */}
            {isSearchResult && selected.kind === 'search' && (
              <View style={detailStyles.searchMeta}>
                <Text style={detailStyles.packageRef}>{selected.result.packageRef}</Text>
                {selected.result.url ? (
                  <TouchableOpacity
                    style={detailStyles.viewDetailsButton}
                    activeOpacity={0.7}
                    onPress={() => selected.result.url && WebBrowser.openBrowserAsync(selected.result.url)}
                  >
                    <Text style={detailStyles.viewDetailsButtonText}>View Details</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            )}

            {/* Prompt body for installed skills */}
            {modalBody !== null && (
              <View style={detailStyles.bodySection}>
                <View style={detailStyles.bodyHeader}>
                  <Text style={detailStyles.bodyLabel}>Prompt</Text>
                  {isEditable && !isEditing && (
                    <TouchableOpacity onPress={() => setIsEditing(true)} activeOpacity={0.7}>
                      <Text style={detailStyles.editBtn}>Edit</Text>
                    </TouchableOpacity>
                  )}
                  {isEditing && (
                    <TouchableOpacity onPress={handleSave} activeOpacity={0.7}>
                      <Text style={detailStyles.saveBtn}>Save</Text>
                    </TouchableOpacity>
                  )}
                </View>
                {isEditing ? (
                  <TextInput
                    style={detailStyles.bodyEditor}
                    value={editBody}
                    onChangeText={setEditBody}
                    multiline
                    autoFocus
                    textAlignVertical="top"
                    keyboardAppearance="dark"
                  />
                ) : (
                  <Text style={detailStyles.bodyText}>{modalBody}</Text>
                )}
              </View>
            )}

            {/* Install button for search results */}
            {isSearchResult && (
              <TouchableOpacity
                style={detailStyles.installButton}
                activeOpacity={0.7}
                onPress={handleInstall}
              >
                <Text style={detailStyles.installButtonText}>Install Skill</Text>
              </TouchableOpacity>
            )}

            {/* Source tag for installed skills */}
            {!isSearchResult && selected?.kind === 'installed' && (
              <View style={detailStyles.meta}>
                <Text style={detailStyles.metaText}>
                  Source: {selected.skill.source === 'builtin' ? 'Built-in' : 'Installed'}
                </Text>
              </View>
            )}
          </ScrollView>
        </KeyboardAvoidingView>
      </BottomModal>
    </View>
  );
}

const iconStyles = StyleSheet.create({
  circle: {
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});

const detailStyles = StyleSheet.create({
  scroll: {
    maxHeight: 600,
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  description: {
    color: '#888',
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 12,
  },
  searchMeta: {
    marginBottom: 16,
    gap: 8,
  },
  packageRef: {
    color: '#555',
    fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  viewDetailsButton: {
    backgroundColor: '#1a1a1a',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
  },
  viewDetailsButtonText: {
    color: '#e5e5e5',
    fontSize: 16,
    fontWeight: '600',
  },
  bodySection: {
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
  },
  bodyHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  bodyLabel: {
    color: '#666',
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  editBtn: {
    color: '#6b8aed',
    fontSize: 13,
    fontWeight: '500',
  },
  saveBtn: {
    color: '#4ade80',
    fontSize: 13,
    fontWeight: '600',
  },
  bodyText: {
    color: '#ccc',
    fontSize: 13,
    lineHeight: 20,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  bodyEditor: {
    color: '#e5e5e5',
    fontSize: 13,
    lineHeight: 20,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    minHeight: 120,
    padding: 0,
  },
  installButton: {
    backgroundColor: '#fff',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: 8,
  },
  installButtonText: {
    color: '#000',
    fontSize: 16,
    fontWeight: '600',
  },
  meta: {
    paddingBottom: 8,
  },
  metaText: {
    color: '#444',
    fontSize: 11,
  },
});

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000',
  },
  container: {
    flex: 1,
    backgroundColor: '#0a0a0a',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 10,
    gap: 8,
  },
  headerTitle: {
    color: '#fafafa',
    fontSize: 17,
    fontWeight: '600',
  },
  headerSpacer: {
    flex: 1,
  },
  closeButton: {
    paddingLeft: 8,
  },
  closeText: {
    color: '#888',
    fontSize: 15,
    fontWeight: '500',
  },
  content: {
    flex: 1,
  },
  contentInner: {
    padding: 16,
    paddingBottom: 40,
  },
  searchBar: {
    marginBottom: 20,
  },
  searchInputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1a1a1a',
    borderRadius: 8,
    paddingHorizontal: 12,
    height: 40,
  },
  searchInput: {
    flex: 1,
    color: '#e5e5e5',
    fontSize: 14,
    padding: 0,
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    color: '#666',
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 12,
  },
  skillRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1a1a1a',
    paddingVertical: 16,
    paddingHorizontal: 18,
    marginBottom: 1,
    gap: 12,
  },
  skillContent: {
    flex: 1,
  },
  skillName: {
    color: '#e5e5e5',
    fontSize: 15,
    fontWeight: '600',
  },
  skillDescription: {
    color: '#666',
    fontSize: 12,
    marginTop: 2,
    lineHeight: 16,
  },
  skillRef: {
    color: '#555',
    fontSize: 11,
    marginTop: 2,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  emptyContainer: {
    paddingTop: 40,
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
    textAlign: 'center',
    lineHeight: 18,
  },
});
