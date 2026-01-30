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

interface UseNotificationsOptions {
  enabled?: boolean;
}

export function useNotifications({ enabled = true }: UseNotificationsOptions = {}) {
  const hasPermissionRef = useRef(false);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);

  // Request permissions on mount
  useEffect(() => {
    if (!enabled) return;

    const requestPermissions = async () => {
      if (!Device.isDevice) {
        // Notifications don't work on simulators
        return;
      }

      const { status: existingStatus } = await Notifications.getPermissionsAsync();
      let finalStatus = existingStatus;

      if (existingStatus !== 'granted') {
        const { status } = await Notifications.requestPermissionsAsync();
        finalStatus = status;
      }

      hasPermissionRef.current = finalStatus === 'granted';
    };

    requestPermissions();
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
    if (!enabled || !hasPermissionRef.current) return;

    // Only show notification if app is in background (unless forced)
    const isBackground = appStateRef.current !== 'active';
    if (!isBackground && !options?.forceShow) return;

    try {
      await Notifications.scheduleNotificationAsync({
        content: {
          title,
          body,
          sound: true,
          priority: Notifications.AndroidNotificationPriority.HIGH,
          ...(Platform.OS === 'ios' && {
            interruptionLevel: 'timeSensitive',
          }),
        },
        trigger: null, // Show immediately
      });
    } catch {
      // Notification failed, ignore
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

  return {
    notify,
    notifyTaskComplete,
  };
}
