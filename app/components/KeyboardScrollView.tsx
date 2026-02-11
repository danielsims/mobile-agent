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

const NEAR_BOTTOM_THRESHOLD = 120;

export function KeyboardScrollView({
  children,
  style,
  contentContainerStyle,
}: KeyboardScrollViewProps) {
  const scrollRef = useRef<ScrollView>(null);
  const isNearBottom = useRef(true);
  const layoutHeight = useRef(0);
  const contentHeightRef = useRef(0);
  const scrollOffset = useRef(0);

  const scrollToEnd = useCallback(() => {
    setTimeout(() => {
      scrollRef.current?.scrollToEnd({ animated: true });
    }, 100);
  }, []);

  // Update near-bottom tracking on every scroll
  const updateNearBottom = useCallback(() => {
    const distFromBottom = contentHeightRef.current - layoutHeight.current - scrollOffset.current;
    isNearBottom.current = distFromBottom < NEAR_BOTTOM_THRESHOLD;
  }, []);

  // Keyboard listeners - auto scroll when keyboard opens
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const showListener = Keyboard.addListener(showEvent, () => {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      if (isNearBottom.current) {
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

  // Only auto-scroll when near the bottom (new messages, not card expand mid-scroll)
  const handleContentSizeChange = useCallback(
    (_w: number, h: number) => {
      contentHeightRef.current = h;
      if (isNearBottom.current) {
        scrollToEnd();
      }
    },
    [scrollToEnd]
  );

  const handleScroll = useCallback(
    (e: { nativeEvent: { contentOffset: { y: number }; contentSize: { height: number }; layoutMeasurement: { height: number } } }) => {
      scrollOffset.current = e.nativeEvent.contentOffset.y;
      layoutHeight.current = e.nativeEvent.layoutMeasurement.height;
      contentHeightRef.current = e.nativeEvent.contentSize.height;
      updateNearBottom();
    },
    [updateNearBottom],
  );

  const handleLayout = useCallback(
    (e: { nativeEvent: { layout: { height: number } } }) => {
      layoutHeight.current = e.nativeEvent.layout.height;
    },
    [],
  );

  return (
    <ScrollView
      ref={scrollRef}
      style={[styles.scrollView, style]}
      contentContainerStyle={[styles.contentContainer, contentContainerStyle]}
      onContentSizeChange={handleContentSizeChange}
      onScroll={handleScroll}
      onLayout={handleLayout}
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
