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
  const [size, setSize] = React.useState<{ width: number; height: number } | null>(null);

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

  const gradientWidth = (size?.width ?? 100) * 3;

  const translateX = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [-(size?.width ?? 100) * 0.75, (size?.width ?? 100) * 0.75],
  });

  return (
    <View>
      {/* Hidden text to measure exact layout size */}
      <Text
        style={[style, { opacity: 0 }]}
        numberOfLines={1}
        onLayout={(e) => {
          const { width, height } = e.nativeEvent.layout;
          setSize((prev) => (prev && prev.width === width && prev.height === height ? prev : { width, height }));
        }}
      >
        {text}
      </Text>
      {size && (
        <View style={[StyleSheet.absoluteFill, { justifyContent: 'center' }]}>
          <MaskedView
            style={{ width: size.width, height: size.height, overflow: 'hidden' }}
            maskElement={
              <Text style={[styles.maskText, style]} numberOfLines={1}>{text}</Text>
            }
          >
            <Animated.View
              style={{
                width: gradientWidth,
                height: size.height,
                marginLeft: -size.width,
                transform: [{ translateX }],
              }}
            >
              <Svg width={gradientWidth} height={size.height}>
                <Defs>
                  <LinearGradient id="shimmerGrad" x1="0" y1="0" x2="1" y2="0">
                    <Stop offset="0" stopColor="#555" />
                    <Stop offset="0.44" stopColor="#555" />
                    <Stop offset="0.5" stopColor="#bbb" />
                    <Stop offset="0.56" stopColor="#555" />
                    <Stop offset="1" stopColor="#555" />
                  </LinearGradient>
                </Defs>
                <Rect x="0" y="0" width={gradientWidth} height={size.height} fill="url(#shimmerGrad)" />
              </Svg>
            </Animated.View>
          </MaskedView>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  maskText: {
    color: '#fff',
  },
});
