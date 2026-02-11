import React, { useRef, useEffect } from 'react';
import { Animated, Easing, StyleSheet, Text, View, type TextStyle } from 'react-native';
import MaskedView from '@react-native-masked-view/masked-view';
import Svg, { Defs, LinearGradient, Stop, Rect } from 'react-native-svg';

interface ShimmerTextProps {
  text: string;
  style?: TextStyle;
  duration?: number;
}

export function ShimmerText({ text, style, duration = 2000 }: ShimmerTextProps) {
  const anim = useRef(new Animated.Value(0)).current;
  const fontSize = (style?.fontSize as number) ?? 16;
  const width = Math.max(text.length * fontSize * 0.55, 100);
  const height = fontSize * 1.6;
  const gradientWidth = width * 3;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(anim, {
        toValue: 1,
        duration,
        easing: Easing.linear,
        useNativeDriver: true,
      })
    );
    loop.start();
    return () => loop.stop();
  }, [anim, duration]);

  // Sweep the gradient highlight across the visible area
  const translateX = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [-width * 0.75, width * 0.75],
  });

  return (
    <View style={{ width, height, justifyContent: 'center' }}>
      <MaskedView
        style={{ width, height, overflow: 'hidden' }}
        maskElement={
          <Text style={[styles.maskText, { fontSize }, style]}>{text}</Text>
        }
      >
        <Animated.View
          style={{
            width: gradientWidth,
            height,
            marginLeft: -width,
            transform: [{ translateX }],
          }}
        >
          <Svg width={gradientWidth} height={height}>
            <Defs>
              <LinearGradient id="shimmerGrad" x1="0" y1="0" x2="1" y2="0">
                <Stop offset="0" stopColor="#555" />
                <Stop offset="0.44" stopColor="#555" />
                <Stop offset="0.5" stopColor="#bbb" />
                <Stop offset="0.56" stopColor="#555" />
                <Stop offset="1" stopColor="#555" />
              </LinearGradient>
            </Defs>
            <Rect x="0" y="0" width={gradientWidth} height={height} fill="url(#shimmerGrad)" />
          </Svg>
        </Animated.View>
      </MaskedView>
    </View>
  );
}

const styles = StyleSheet.create({
  maskText: {
    color: '#fff',
  },
});
