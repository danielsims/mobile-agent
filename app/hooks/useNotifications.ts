import { useEffect, useRef, useCallback } from 'react';
import { Platform, AppState, AppStateStatus } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';

// Configure how notifications are handled when app is in foreground
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

// Android notification channel ID
const CHANNEL_ID = 'claude-responses';

interface UseNotificationsOptions {
  enabled?: boolean;
}

export function useNotifications({ enabled = true }: UseNotificationsOptions = {}) {
  const hasPermissionRef = useRef(false);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const isSetupCompleteRef = useRef(false);

  // Setup notifications on mount
  useEffect(() => {
    if (!enabled) return;

    const setup = async () => {
      // Skip on simulators
      if (!Device.isDevice) {
        return;
      }

      // Create Android notification channel (required for Android 8+)
      if (Platform.OS === 'android') {
        await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
          name: 'Claude Responses',
          importance: Notifications.AndroidImportance.HIGH,
          vibrationPattern: [0, 250, 250, 250],
          sound: 'default',
          enableVibrate: true,
          showBadge: true,
        });
      }

      // Request permissions
      const { status: existingStatus } = await Notifications.getPermissionsAsync();
      let finalStatus = existingStatus;

      if (existingStatus !== 'granted') {
        const { status } = await Notifications.requestPermissionsAsync({
          ios: {
            allowAlert: true,
            allowBadge: true,
            allowSound: true,
          },
        });
        finalStatus = status;
      }

      hasPermissionRef.current = finalStatus === 'granted';
      isSetupCompleteRef.current = true;
    };

    setup();
  }, [enabled]);

  // Track app state to only notify when backgrounded
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextAppState) => {
      appStateRef.current = nextAppState;
    });

    return () => subscription.remove();
  }, []);

  // Send a notification (only when app is backgrounded)
  const notify = useCallback(async (title: string, body: string, options?: {
    forceShow?: boolean;
  }) => {
    if (!enabled) return;

    // Wait for setup if not complete
    if (!isSetupCompleteRef.current) {
      return;
    }

    if (!hasPermissionRef.current) {
      return;
    }

    // Only show notification if app is in background (unless forced)
    const isBackground = appStateRef.current !== 'active';
    if (!isBackground && !options?.forceShow) {
      return;
    }

    try {
      await Notifications.scheduleNotificationAsync({
        content: {
          title,
          body,
          sound: true,
          ...(Platform.OS === 'android' && {
            priority: Notifications.AndroidNotificationPriority.HIGH,
          }),
        },
        trigger: null, // Show immediately
      });
    } catch {
      // Notification failed silently
    }
  }, [enabled]);

  // Convenience method for task completion notifications
  const notifyTaskComplete = useCallback((summary: string) => {
    // Truncate if too long
    const truncated = summary.length > 200
      ? summary.slice(0, 197) + '...'
      : summary;

    notify('Claude finished', truncated);
  }, [notify]);

  // Force a test notification (for debugging)
  const testNotification = useCallback(() => {
    notify('Test Notification', 'This is a test from Claude mobile agent', { forceShow: true });
  }, [notify]);

  return {
    notify,
    notifyTaskComplete,
    testNotification,
  };
}
