import { useCallback, useRef, useEffect } from 'react';
import { Audio } from 'expo-av';

/**
 * Hook for playing a completion chime when Claude finishes responding
 */
export function useCompletionChime() {
  const soundRef = useRef<Audio.Sound | null>(null);

  // Preload the sound on mount
  useEffect(() => {
    const loadSound = async () => {
      try {
        const { sound } = await Audio.Sound.createAsync(
          require('../assets/chime.wav')
        );
        soundRef.current = sound;
      } catch (err) {
        console.error('[Chime] Failed to load sound:', err);
      }
    };
    loadSound();

    return () => {
      if (soundRef.current) {
        soundRef.current.unloadAsync();
      }
    };
  }, []);

  const play = useCallback(async () => {
    try {
      if (soundRef.current) {
        // Reset to start and play
        await soundRef.current.setPositionAsync(0);
        await soundRef.current.playAsync();
      }
    } catch (err) {
      console.error('[Chime] Failed to play:', err);
    }
  }, []);

  return { play };
}
