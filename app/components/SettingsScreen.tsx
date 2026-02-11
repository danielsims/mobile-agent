import React, { useRef, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Switch,
  StyleSheet,
  Alert,
  ScrollView,
  PanResponder,
  Animated,
  Dimensions,
} from 'react-native';
import { useSettings } from '../state/SettingsContext';

const SCREEN_WIDTH = Dimensions.get('window').width;
const SWIPE_THRESHOLD = SCREEN_WIDTH * 0.25;
const EDGE_WIDTH = 30;

interface SettingsScreenProps {
  onBack: () => void;
  onUnpair: () => void;
}

function BackArrow() {
  return (
    <View style={styles.arrowContainer}>
      <View style={styles.arrowChevron} />
    </View>
  );
}

export function SettingsScreen({ onBack, onUnpair }: SettingsScreenProps) {
  const { settings, updateSetting } = useSettings();

  // Start off-screen and slide in on mount
  const swipeX = useRef(new Animated.Value(SCREEN_WIDTH)).current;

  useEffect(() => {
    Animated.timing(swipeX, {
      toValue: 0,
      duration: 250,
      useNativeDriver: true,
    }).start();
  }, [swipeX]);

  // Swipe-from-left-edge to go back
  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_evt, gesture) => {
        return (
          gesture.x0 < EDGE_WIDTH &&
          gesture.dx > 10 &&
          Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.5
        );
      },
      onPanResponderMove: (_evt, gesture) => {
        if (gesture.dx > 0) {
          swipeX.setValue(gesture.dx);
        }
      },
      onPanResponderRelease: (_evt, gesture) => {
        if (gesture.dx > SWIPE_THRESHOLD) {
          Animated.timing(swipeX, {
            toValue: SCREEN_WIDTH,
            duration: 150,
            useNativeDriver: true,
          }).start(() => onBack());
        } else {
          Animated.spring(swipeX, {
            toValue: 0,
            useNativeDriver: true,
            tension: 80,
            friction: 10,
          }).start();
        }
      },
      onPanResponderTerminate: () => {
        Animated.spring(swipeX, {
          toValue: 0,
          useNativeDriver: true,
        }).start();
      },
    }),
  ).current;

  const animateBack = useCallback(() => {
    Animated.timing(swipeX, {
      toValue: SCREEN_WIDTH,
      duration: 250,
      useNativeDriver: true,
    }).start(() => onBack());
  }, [swipeX, onBack]);

  const backdropOpacity = swipeX.interpolate({
    inputRange: [0, SCREEN_WIDTH],
    outputRange: [0.5, 0],
    extrapolate: 'clamp',
  });

  const handleUnpair = () => {
    Alert.alert(
      'Unpair Device',
      'This will disconnect and remove all pairing credentials. You will need to scan a new QR code to reconnect.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Unpair', style: 'destructive', onPress: onUnpair },
      ],
    );
  };

  return (
    <View style={styles.overlay}>
      <Animated.View style={[styles.backdrop, { opacity: backdropOpacity }]} pointerEvents="none" />

      <Animated.View
        style={[styles.container, { transform: [{ translateX: swipeX }] }]}
        {...panResponder.panHandlers}
      >
        <View style={styles.header}>
          <TouchableOpacity onPress={animateBack} style={styles.backButton} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <BackArrow />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Settings</Text>
        </View>

        <ScrollView style={styles.content}>
          {/* Appearance section */}
          <Text style={styles.sectionTitle}>Appearance</Text>
          <View style={styles.section}>
            <View style={styles.settingRow}>
              <View style={styles.settingInfo}>
                <Text style={styles.settingLabel}>Colorful git labels</Text>
                <Text style={styles.settingDescription}>
                  Show project and branch names in color
                </Text>
              </View>
              <Switch
                value={settings.colorfulGitLabels}
                onValueChange={(value) => updateSetting('colorfulGitLabels', value)}
                trackColor={{ false: '#333', true: '#22c55e' }}
                thumbColor="#fff"
              />
            </View>
          </View>

          {/* Device section */}
          <Text style={styles.sectionTitle}>Device</Text>
          <View style={styles.section}>
            <TouchableOpacity style={styles.destructiveRow} onPress={handleUnpair}>
              <Text style={styles.destructiveText}>Unpair device</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </Animated.View>
    </View>
  );
}

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
    paddingHorizontal: 12,
    paddingTop: 4,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a1a',
    gap: 10,
  },
  backButton: {
    paddingRight: 4,
  },
  headerTitle: {
    color: '#fafafa',
    fontSize: 17,
    fontWeight: '600',
  },
  arrowContainer: {
    width: 16,
    height: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  arrowChevron: {
    width: 10,
    height: 10,
    borderLeftWidth: 2,
    borderBottomWidth: 2,
    borderColor: '#888',
    transform: [{ rotate: '45deg' }],
    marginLeft: 3,
  },
  content: {
    flex: 1,
    paddingHorizontal: 16,
  },
  sectionTitle: {
    color: '#555',
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 24,
    marginBottom: 8,
    paddingHorizontal: 4,
  },
  section: {
    backgroundColor: '#141414',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#1f1f1f',
    overflow: 'hidden',
  },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  settingInfo: {
    flex: 1,
    marginRight: 12,
  },
  settingLabel: {
    color: '#e5e5e5',
    fontSize: 15,
  },
  settingDescription: {
    color: '#555',
    fontSize: 12,
    marginTop: 2,
  },
  destructiveRow: {
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  destructiveText: {
    color: '#ef4444',
    fontSize: 15,
  },
});
