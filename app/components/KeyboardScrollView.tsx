import React, { useRef, useCallback, useEffect } from 'react';
import {
  ScrollView,
  StyleSheet,
  ViewStyle,
  Keyboard,
  Platform,
  LayoutAnimation,
  UIManager,
} from 'react-native';

// Enable LayoutAnimation on Android
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

interface KeyboardScrollViewProps {
  children: React.ReactNode;
  style?: ViewStyle;
  contentContainerStyle?: ViewStyle;
}

export function KeyboardScrollView({
  children,
  style,
  contentContainerStyle,
}: KeyboardScrollViewProps) {
  const scrollRef = useRef<ScrollView>(null);
  const isUserScrolling = useRef(false);

  const scrollToEnd = useCallback(() => {
    // Small delay to ensure content has rendered
    setTimeout(() => {
      scrollRef.current?.scrollToEnd({ animated: true });
    }, 100);
  }, []);

  // Keyboard listeners - auto scroll when keyboard opens
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const showListener = Keyboard.addListener(showEvent, () => {
      // Animate layout change
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);

      if (!isUserScrolling.current) {
        scrollToEnd();
      }
    });

    const hideListener = Keyboard.addListener(hideEvent, () => {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    });

    return () => {
      showListener.remove();
      hideListener.remove();
    };
  }, [scrollToEnd]);

  // Auto-scroll when content changes (unless user is scrolling)
  const handleContentSizeChange = useCallback(
    (_w: number, _h: number) => {
      if (!isUserScrolling.current) {
        scrollToEnd();
      }
    },
    [scrollToEnd]
  );

  const handleScrollBeginDrag = useCallback(() => {
    isUserScrolling.current = true;
  }, []);

  const handleScrollEndDrag = useCallback(() => {
    // Reset after a short delay
    setTimeout(() => {
      isUserScrolling.current = false;
    }, 500);
  }, []);

  const handleMomentumScrollEnd = useCallback(() => {
    isUserScrolling.current = false;
  }, []);

  return (
    <ScrollView
      ref={scrollRef}
      style={[styles.scrollView, style]}
      contentContainerStyle={[styles.contentContainer, contentContainerStyle]}
      onContentSizeChange={handleContentSizeChange}
      onScrollBeginDrag={handleScrollBeginDrag}
      onScrollEndDrag={handleScrollEndDrag}
      onMomentumScrollEnd={handleMomentumScrollEnd}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      scrollEventThrottle={16}
      showsVerticalScrollIndicator={true}
      bounces={true}
      alwaysBounceVertical={false}
    >
      {children}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scrollView: {
    flex: 1,
  },
  contentContainer: {
    flexGrow: 1,
  },
});
