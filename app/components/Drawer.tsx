import { useState, useEffect, useCallback } from 'react';
import { Dimensions, Keyboard, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import * as Haptics from 'expo-haptics';

const { height: SCREEN_HEIGHT } = Dimensions.get('window');

// Fast spring with no bounce — mimics iOS Family app feel
const SPRING_CONFIG = {
  damping: 28,
  stiffness: 300,
  mass: 0.8,
  overshootClamping: true,
  restDisplacementThreshold: 0.01,
  restSpeedThreshold: 0.01,
};

const SPRING_CONFIG_OUT = {
  damping: 32,
  stiffness: 350,
  mass: 0.7,
  overshootClamping: true,
  restDisplacementThreshold: 0.01,
  restSpeedThreshold: 0.01,
};

interface DrawerProps {
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
  title?: string;
  showCloseButton?: boolean;
}

function CloseIcon({
  color = '#AAAAAA',
  size = 14,
}: {
  color?: string;
  size?: number;
}) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M18 6L6 18M6 6l12 12"
        stroke={color}
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

export function Drawer({
  isOpen,
  onClose,
  children,
  title,
  showCloseButton = true,
}: DrawerProps) {
  const [shouldRender, setShouldRender] = useState(false);
  const [isAnimatingOut, setIsAnimatingOut] = useState(false);
  // 0 = closed, 1 = open — drives all animated properties
  const progress = useSharedValue(0);

  const handleClose = useCallback(() => {
    if (isAnimatingOut) return;
    Keyboard.dismiss();

    setIsAnimatingOut(true);
    progress.value = withSpring(0, SPRING_CONFIG_OUT, (finished) => {
      if (finished) {
        runOnJS(setShouldRender)(false);
        runOnJS(setIsAnimatingOut)(false);
        runOnJS(onClose)();
      }
    });
  }, [isAnimatingOut, progress, onClose]);

  useEffect(() => {
    if (isOpen && !shouldRender) {
      setShouldRender(true);
      setIsAnimatingOut(false);
      progress.value = 0;
      requestAnimationFrame(() => {
        progress.value = withSpring(1, SPRING_CONFIG);
      });
    } else if (!isOpen && shouldRender && !isAnimatingOut) {
      handleClose();
    }
  }, [isOpen, shouldRender, isAnimatingOut, handleClose, progress]);

  const drawerStyle = useAnimatedStyle(() => {
    const translateY = interpolate(progress.value, [0, 1], [SCREEN_HEIGHT * 0.4, 0]);
    const scale = interpolate(progress.value, [0, 1], [0.95, 1]);
    const opacity = interpolate(progress.value, [0, 0.4], [0, 1], 'clamp');
    return {
      transform: [{ translateY }, { scale }],
      opacity,
    };
  });

  const overlayStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 0.6], [0, 1], 'clamp'),
  }));

  if (!shouldRender) return null;

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <Animated.View style={[styles.overlay, overlayStyle]}>
        <Pressable style={styles.overlayPressable} onPress={handleClose} />
      </Animated.View>

      <Animated.View style={[styles.drawer, drawerStyle]}>
        {(title ?? showCloseButton) && (
          <View style={styles.header}>
            {title && <Text style={styles.title}>{title}</Text>}
            {showCloseButton && (
              <Pressable
                style={styles.closeButton}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(
                    (error) => console.error(error),
                  );
                  handleClose();
                }}
              >
                <CloseIcon />
              </Pressable>
            )}
          </View>
        )}

        <View style={styles.content}>{children}</View>
      </Animated.View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'flex-end',
    zIndex: 1000,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
  },
  overlayPressable: {
    flex: 1,
  },
  drawer: {
    backgroundColor: '#141414',
    borderRadius: 32,
    maxHeight: SCREEN_HEIGHT * 0.75,
    marginHorizontal: 16,
    marginBottom: 16,
    paddingTop: 22,
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: -2,
    },
    shadowOpacity: 0.25,
    shadowRadius: 12,
    elevation: 5,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.06)',
  },
  title: {
    fontSize: 18,
    fontWeight: '600',
    color: '#e5e5e5',
  },
  closeButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
  },
  content: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 16,
  },
});
