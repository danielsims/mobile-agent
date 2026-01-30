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
import { BlurView } from 'expo-blur';
import * as Haptics from 'expo-haptics';

// Enable LayoutAnimation on Android
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

interface InputBarProps {
  onSend: (text: string) => void;
  disabled?: boolean;
  placeholder?: string;
  onActivity?: () => void;
  initialValue?: string;
  onDraftChange?: (text: string) => void;
}

const KEYBOARD_OVERLAP = 40;

// Throttle activity notifications to avoid excessive pings
const ACTIVITY_THROTTLE = 5000;

export function InputBar({ onSend, disabled, placeholder = 'Ask anything...', onActivity, initialValue = '', onDraftChange }: InputBarProps) {
  const [text, setText] = useState(initialValue);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const inputRef = useRef<TextInput>(null);
  const lastActivityRef = useRef<number>(0);

  // Update text if initialValue changes (e.g., restored from storage)
  useEffect(() => {
    if (initialValue && !text) {
      setText(initialValue);
    }
  }, [initialValue]);

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

  const canSend = text.trim().length > 0 && !disabled;

  return (
    <BlurView
      intensity={80}
      tint="dark"
      style={[
        styles.blurContainer,
        keyboardVisible && styles.blurContainerKeyboard,
      ]}
    >
      <View style={styles.content}>
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
            autoCorrect
            keyboardAppearance="dark"
          />
        </View>

        <TouchableOpacity
          style={[styles.sendBtn, canSend && styles.sendBtnActive]}
          onPress={handleSend}
          disabled={!canSend}
          activeOpacity={0.7}
        >
          <View style={styles.sendIcon}>
            <ArrowUpIcon color={canSend ? '#000' : '#555'} />
          </View>
        </TouchableOpacity>
      </View>

      {keyboardVisible && <View style={styles.keyboardFill} />}
      {!keyboardVisible && Platform.OS === 'ios' && <View style={styles.safeAreaFill} />}
    </BlurView>
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

const styles = StyleSheet.create({
  blurContainer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.1)',
  },
  blurContainerKeyboard: {
    marginBottom: -KEYBOARD_OVERLAP,
    paddingBottom: 10,
  },
  content: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 6,
    gap: 10,
  },
  keyboardFill: {
    height: KEYBOARD_OVERLAP,
    backgroundColor: 'transparent',
  },
  safeAreaFill: {
    height: 34,
  },
  inputWrapper: {
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  input: {
    paddingHorizontal: 18,
    paddingVertical: 12,
    paddingTop: 12,
    color: '#fafafa',
    fontSize: 16,
    maxHeight: 120,
    minHeight: 44,
  },
  sendBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
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
