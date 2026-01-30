import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import * as Haptics from 'expo-haptics';

interface PermissionPromptProps {
  description: string;
  onApprove: () => void;
  onDeny: () => void;
}

export function PermissionPrompt({
  description,
  onApprove,
  onDeny,
}: PermissionPromptProps) {
  const handleApprove = () => {
    if (Platform.OS === 'ios') {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
    onApprove();
  };

  const handleDeny = () => {
    if (Platform.OS === 'ios') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    onDeny();
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Permission Required</Text>
      <Text style={styles.description}>{description}</Text>

      <View style={styles.buttons}>
        <TouchableOpacity style={styles.denyButton} onPress={handleDeny} activeOpacity={0.7}>
          <Text style={styles.denyText}>Deny</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.approveButton} onPress={handleApprove} activeOpacity={0.8}>
          <Text style={styles.approveText}>Allow</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#141414',
    borderRadius: 8,
    padding: 16,
    marginVertical: 12,
    borderWidth: 1,
    borderColor: '#2a2a2a',
  },
  title: {
    color: '#fafafa',
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 8,
  },
  description: {
    color: '#888',
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 16,
  },
  buttons: {
    flexDirection: 'row',
    gap: 12,
  },
  denyButton: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 6,
    alignItems: 'center',
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: '#333',
  },
  denyText: {
    color: '#888',
    fontWeight: '500',
    fontSize: 14,
  },
  approveButton: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 6,
    alignItems: 'center',
    backgroundColor: '#fff',
  },
  approveText: {
    color: '#000',
    fontWeight: '600',
    fontSize: 14,
  },
});
