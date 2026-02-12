import { useCallback } from 'react';
import { useAudioPlayer } from 'expo-audio';

/**
 * Hook for playing a completion chime when Claude finishes responding
 */
export function useCompletionChime() {
  const player = useAudioPlayer(require('../assets/chime.wav'));

  const play = useCallback(async () => {
    try {
      await player.seekTo(0);
      player.play();
    } catch (err) {
      console.error('[Chime] Failed to play:', err);
    }
  }, [player]);

  return { play };
}
