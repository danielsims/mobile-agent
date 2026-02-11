import { useState, useCallback, useRef, useEffect } from 'react';
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from 'expo-speech-recognition';

interface UseSpeechRecognitionResult {
  transcript: string;
  isListening: boolean;
  start: () => Promise<boolean>;
  stop: () => void;
  abort: () => void;
  clear: () => void;
  error: string | null;
}

export function useSpeechRecognition(): UseSpeechRecognitionResult {
  const [transcript, setTranscript] = useState('');
  const [isListening, setIsListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isListeningRef = useRef(false);

  useSpeechRecognitionEvent('result', (event) => {
    if (event.results && event.results.length > 0) {
      const latest = event.results[event.results.length - 1];
      if (latest) {
        setTranscript(latest.transcript);
      }
    }
  });

  useSpeechRecognitionEvent('error', (event) => {
    if (event.error !== 'aborted') {
      setError(event.message || 'Speech recognition error');
    }
    setIsListening(false);
    isListeningRef.current = false;
  });

  useSpeechRecognitionEvent('end', () => {
    setIsListening(false);
    isListeningRef.current = false;
  });

  const start = useCallback(async (): Promise<boolean> => {
    if (isListeningRef.current) return true;

    setError(null);

    const { granted } = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!granted) {
      setError('Speech recognition permission denied');
      return false;
    }

    try {
      ExpoSpeechRecognitionModule.start({
        lang: 'en-US',
        interimResults: true,
        continuous: true,
      });
      setIsListening(true);
      isListeningRef.current = true;
      return true;
    } catch (err) {
      setError(String(err));
      return false;
    }
  }, []);

  const stop = useCallback(() => {
    if (isListeningRef.current) {
      ExpoSpeechRecognitionModule.stop();
    }
  }, []);

  const abort = useCallback(() => {
    if (isListeningRef.current) {
      ExpoSpeechRecognitionModule.abort();
    }
    setIsListening(false);
    isListeningRef.current = false;
    setTranscript('');
  }, []);

  const clear = useCallback(() => {
    setTranscript('');
    setError(null);
  }, []);

  useEffect(() => {
    return () => {
      if (isListeningRef.current) {
        ExpoSpeechRecognitionModule.abort();
      }
    };
  }, []);

  return { transcript, isListening, start, stop, abort, clear, error };
}
