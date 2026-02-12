import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Platform,
  Keyboard,
  LayoutAnimation,
  UIManager,
} from 'react-native';
import Svg, { Path, Line } from 'react-native-svg';
import * as Haptics from 'expo-haptics';
import { ShimmerText } from './ShimmerText';

// Enable LayoutAnimation on Android
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

interface InputBarProps {
  onSend: (text: string) => void;
  onStop?: () => void;
  showStop?: boolean;
  onVoice?: () => void;
  onPlus?: () => void;
  disabled?: boolean;
  placeholder?: string;
  onActivity?: () => void;
  initialValue?: string;
  onDraftChange?: (text: string) => void;
  autoFocus?: boolean;
  shimmer?: boolean;
}

// Throttle activity notifications to avoid excessive pings
const ACTIVITY_THROTTLE = 5000;

export function InputBar({ onSend, onStop, showStop = false, onVoice, onPlus, disabled, placeholder = 'Ask anything...', onActivity, initialValue = '', onDraftChange, autoFocus, shimmer }: InputBarProps) {
  const [text, setText] = useState(initialValue);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const inputRef = useRef<TextInput>(null);
  const lastActivityRef = useRef<number>(0);

  // Update text if initialValue changes (e.g., restored from storage)
  useEffect(() => {
    if (initialValue) {
      setText(initialValue);
    }
  }, [initialValue]);

  // Auto-focus the input when requested (e.g., inline chat on dashboard)
  useEffect(() => {
    if (autoFocus) {
      // Short delay to let the layout settle before focusing
      const timer = setTimeout(() => inputRef.current?.focus(), 100);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [autoFocus]);

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const showListener = Keyboard.addListener(showEvent, () => {
      // Fast spring animation
      LayoutAnimation.configureNext({
        duration: 150,
        update: {
          type: LayoutAnimation.Types.easeOut,
        },
      });
      setKeyboardVisible(true);
    });

    const hideListener = Keyboard.addListener(hideEvent, () => {
      LayoutAnimation.configureNext({
        duration: 150,
        update: {
          type: LayoutAnimation.Types.easeOut,
        },
      });
      setKeyboardVisible(false);
    });

    return () => {
      showListener.remove();
      hideListener.remove();
    };
  }, []);

  // Notify activity when user is typing (throttled)
  const handleTextChange = (newText: string) => {
    setText(newText);

    // Notify parent of draft change for persistence
    onDraftChange?.(newText);

    // Throttle activity notifications
    const now = Date.now();
    if (onActivity && now - lastActivityRef.current > ACTIVITY_THROTTLE) {
      lastActivityRef.current = now;
      onActivity();
    }
  };

  const handleSend = async () => {
    if (!text.trim() || disabled) return;

    if (Platform.OS === 'ios') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }

    const message = text.trim();
    setText('');
    onSend(message);
    inputRef.current?.focus();
  };

  const canStop = Boolean(onStop) && showStop && !disabled;
  const canSend = text.trim().length > 0 && !disabled && !canStop;

  const handlePrimaryAction = async () => {
    if (canStop) {
      if (Platform.OS === 'ios') {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      }
      onStop?.();
      return;
    }
    await handleSend();
  };

  return (
    <View style={styles.container}>
      <View style={styles.content}>
        {onPlus && (
          <TouchableOpacity
            style={styles.plusBtn}
            onPress={() => {
              if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              onPlus();
            }}
            activeOpacity={0.7}
          >
            <PlusIcon size={20} color="#888" />
          </TouchableOpacity>
        )}
        <View style={styles.inputWrapper}>
          <TextInput
            ref={inputRef}
            style={styles.input}
            value={text}
            onChangeText={handleTextChange}
            placeholder={placeholder}
            placeholderTextColor="#666"
            onSubmitEditing={handleSend}
            returnKeyType="send"
            multiline
            editable={!disabled}
            autoCapitalize="sentences"
            autoCorrect={false}
            spellCheck={false}
            autoComplete="off"
            keyboardAppearance="dark"
          />
          {shimmer && !text && (
            <View style={styles.shimmerOverlay} pointerEvents="none">
              <ShimmerText text={placeholder} style={styles.shimmerText} />
            </View>
          )}
        </View>

        {onVoice && (
          <TouchableOpacity
            style={styles.micBtn}
            onPress={onVoice}
            activeOpacity={0.7}
          >
            <MicIcon size={20} color="#888" />
          </TouchableOpacity>
        )}

        <TouchableOpacity
          style={[styles.sendBtn, (canSend || canStop) && styles.sendBtnActive]}
          onPress={handlePrimaryAction}
          disabled={!canSend && !canStop}
          activeOpacity={0.7}
        >
          <View style={styles.sendIcon}>
            {canStop ? (
              <StopIcon color="#000" />
            ) : (
              <ArrowUpIcon color={canSend ? '#000' : '#555'} />
            )}
          </View>
        </TouchableOpacity>
      </View>

      {!keyboardVisible && Platform.OS === 'ios' && <View style={styles.safeAreaFill} />}
    </View>
  );
}

function PlusIcon({ size = 20, color = '#888' }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M12 5v14M5 12h14" stroke={color} strokeWidth={2} strokeLinecap="round" />
    </Svg>
  );
}

function MicIcon({ size = 20, color = '#888' }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M12 2a3.5 3.5 0 00-3.5 3.5v5a3.5 3.5 0 007 0v-5A3.5 3.5 0 0012 2z"
        fill={color}
      />
      <Path
        d="M19 10v1a7 7 0 01-14 0v-1"
        stroke={color}
        strokeWidth={1.8}
        strokeLinecap="round"
      />
      <Line x1={12} y1={18} x2={12} y2={22} stroke={color} strokeWidth={1.8} strokeLinecap="round" />
      <Line x1={9} y1={22} x2={15} y2={22} stroke={color} strokeWidth={1.8} strokeLinecap="round" />
    </Svg>
  );
}

function ArrowUpIcon({ color }: { color: string }) {
  return (
    <View style={styles.arrowIcon}>
      <View style={[styles.arrowStem, { backgroundColor: color }]} />
      <View style={[styles.arrowHead, { borderBottomColor: color }]} />
    </View>
  );
}

function StopIcon({ color }: { color: string }) {
  return (
    <View
      style={{
        width: 10,
        height: 10,
        borderRadius: 2,
        backgroundColor: color,
      }}
    />
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#0a0a0a',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.1)',
  },
  content: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 6,
    gap: 10,
  },
  safeAreaFill: {
    height: 34,
  },
  inputWrapper: {
    flex: 1,
    position: 'relative',
  },
  input: {
    paddingHorizontal: 4,
    paddingVertical: 12,
    paddingTop: 12,
    color: '#fafafa',
    fontSize: 16,
    maxHeight: 120,
    minHeight: 44,
  },
  shimmerOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 4,
    paddingTop: 12,
    backgroundColor: '#0a0a0a',
  },
  shimmerText: {
    fontSize: 16,
    color: '#999',
  },
  plusBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  micBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  sendBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  sendBtnActive: {
    backgroundColor: '#fff',
  },
  sendIcon: {
    width: 18,
    height: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  arrowIcon: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  arrowStem: {
    width: 2.5,
    height: 10,
    borderRadius: 1,
    marginTop: 4,
  },
  arrowHead: {
    position: 'absolute',
    top: 0,
    width: 0,
    height: 0,
    borderLeftWidth: 5,
    borderRightWidth: 5,
    borderBottomWidth: 6,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
  },
});
