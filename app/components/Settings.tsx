import React from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { ConnectionStatus } from '../types';

interface SettingsProps {
  serverUrl: string;
  authToken: string;
  status: ConnectionStatus;
  onServerUrlChange: (url: string) => void;
  onAuthTokenChange: (token: string) => void;
  onConnect: () => void;
  onScan: () => void;
  onBack?: () => void;
}

export function Settings({
  serverUrl,
  authToken,
  status,
  onServerUrlChange,
  onAuthTokenChange,
  onConnect,
  onScan,
  onBack,
}: SettingsProps) {
  const canConnect = serverUrl.trim() && authToken.trim();

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Claude Mobile</Text>
      <Text style={styles.subtitle}>Connect to your computer</Text>

      <TouchableOpacity style={styles.primaryBtn} onPress={onScan}>
        <Text style={styles.primaryBtnText}>Scan QR Code</Text>
      </TouchableOpacity>

      <View style={styles.divider}>
        <View style={styles.dividerLine} />
        <Text style={styles.dividerText}>or enter manually</Text>
        <View style={styles.dividerLine} />
      </View>

      <TextInput
        style={styles.input}
        value={serverUrl}
        onChangeText={onServerUrlChange}
        placeholder="Server URL"
        placeholderTextColor="#666"
        autoCapitalize="none"
        autoCorrect={false}
      />

      <TextInput
        style={styles.input}
        value={authToken}
        onChangeText={onAuthTokenChange}
        placeholder="Token"
        placeholderTextColor="#666"
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
      />

      <TouchableOpacity
        style={[styles.connectBtn, !canConnect && styles.btnDisabled]}
        onPress={onConnect}
        disabled={!canConnect || status === 'connecting'}
      >
        {status === 'connecting' ? (
          <ActivityIndicator color="#fff" size="small" />
        ) : (
          <Text style={styles.connectBtnText}>Connect</Text>
        )}
      </TouchableOpacity>

      {status === 'connected' && onBack && (
        <TouchableOpacity style={styles.backBtn} onPress={onBack}>
          <Text style={styles.backBtnText}>Back to chat</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 24,
    justifyContent: 'center',
    backgroundColor: '#0a0a0a',
  },
  title: {
    fontSize: 24,
    fontWeight: '600',
    color: '#fafafa',
    textAlign: 'center',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    color: '#888',
    textAlign: 'center',
    marginBottom: 32,
  },
  primaryBtn: {
    backgroundColor: '#fff',
    padding: 14,
    borderRadius: 8,
    alignItems: 'center',
  },
  primaryBtnText: {
    color: '#000',
    fontSize: 15,
    fontWeight: '600',
  },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 24,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: '#222',
  },
  dividerText: {
    color: '#555',
    paddingHorizontal: 12,
    fontSize: 13,
  },
  input: {
    backgroundColor: '#141414',
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 8,
    padding: 14,
    color: '#fafafa',
    fontSize: 15,
    marginBottom: 12,
  },
  connectBtn: {
    backgroundColor: '#222',
    padding: 14,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 8,
  },
  connectBtnText: {
    color: '#fafafa',
    fontSize: 15,
    fontWeight: '500',
  },
  backBtn: {
    padding: 16,
    alignItems: 'center',
  },
  backBtnText: {
    color: '#888',
    fontSize: 14,
  },
  btnDisabled: {
    opacity: 0.4,
  },
});
