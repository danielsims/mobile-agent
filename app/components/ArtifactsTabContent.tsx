import React, { useMemo, useRef, useState, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Platform,
} from 'react-native';
import Svg, { Path } from 'react-native-svg';
import * as Haptics from 'expo-haptics';
import * as WebBrowser from 'expo-web-browser';
import * as Clipboard from 'expo-clipboard';
import type { AgentMessage, ContentBlock } from '../state/types';

interface ArtifactsTabContentProps {
  messages: AgentMessage[];
}

interface ExtractedUrl {
  url: string;
  category: 'deployment' | 'localhost' | 'link';
}

const URL_REGEX = /https?:\/\/[^\s<>)"'\]*_`~]+/g;

const DEPLOYMENT_HOSTS = [
  'vercel.app', 'netlify.app', 'pages.dev', 'herokuapp.com',
  'fly.dev', 'railway.app', 'render.com', 'surge.sh',
];

function categorizeUrl(url: string): ExtractedUrl['category'] {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '0.0.0.0') {
      return 'localhost';
    }
    if (DEPLOYMENT_HOSTS.some(h => parsed.hostname.endsWith(h))) {
      return 'deployment';
    }
  } catch { /* invalid URL */ }
  return 'link';
}

function cleanUrl(raw: string): string | null {
  let url = raw;
  // Strip trailing punctuation / markdown artifacts
  url = url.replace(/[.,;:!?)\]}>*_`~]+$/, '');
  // Strip markdown image/link prefix that got glued on: ](http... → http...
  url = url.replace(/^[^h]*(?=https?:\/\/)/, '');
  // Validate: must still start with http(s) and parse as a URL
  if (!url.startsWith('http://') && !url.startsWith('https://')) return null;
  try {
    const parsed = new URL(url);
    // Must have a real hostname (not just "http://")
    if (!parsed.hostname || parsed.hostname.length < 1) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function stringifyValue(val: unknown): string {
  if (typeof val === 'string') return val;
  if (val == null || typeof val === 'boolean' || typeof val === 'number') return '';
  if (Array.isArray(val)) return val.map(stringifyValue).join('\n');
  if (typeof val === 'object') return Object.values(val).map(stringifyValue).join('\n');
  return '';
}

function extractTextFromBlocks(blocks: ContentBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === 'text' && 'text' in b) parts.push(b.text);
    else if (b.type === 'thinking' && 'text' in b) parts.push(b.text);
    else if (b.type === 'tool_use' && 'input' in b) parts.push(stringifyValue(b.input));
    else if (b.type === 'tool_result') parts.push(stringifyValue(b.content));
  }
  return parts.join('\n');
}

function extractUrls(messages: AgentMessage[]): ExtractedUrl[] {
  const seen = new Set<string>();
  const urls: ExtractedUrl[] = [];

  for (const msg of messages) {
    let textContent = '';

    if (typeof msg.content === 'string') {
      textContent = msg.content;
    } else if (Array.isArray(msg.content)) {
      textContent = extractTextFromBlocks(msg.content as ContentBlock[]);
    }

    const matches = textContent.match(URL_REGEX);
    if (matches) {
      for (const rawUrl of matches) {
        const url = cleanUrl(rawUrl);
        if (url && !seen.has(url)) {
          seen.add(url);
          urls.push({ url, category: categorizeUrl(url) });
        }
      }
    }
  }

  return urls;
}

const CATEGORY_ORDER: ExtractedUrl['category'][] = ['deployment', 'localhost', 'link'];
const CATEGORY_LABELS: Record<string, string> = {
  deployment: 'DEPLOYMENTS',
  localhost: 'LOCAL SERVERS',
  link: 'LINKS',
};

export function ArtifactsTabContent({ messages }: ArtifactsTabContentProps) {
  // Incremental URL extraction — only scan new messages, never lose old URLs
  const scannedCountRef = useRef(0);
  const seenUrlsRef = useRef(new Set<string>());
  const cachedUrlsRef = useRef<ExtractedUrl[]>([]);

  const urls = useMemo(() => {
    const startIdx = scannedCountRef.current;

    // If messages shrank (new session or reset), re-scan from scratch
    if (messages.length < startIdx) {
      scannedCountRef.current = 0;
      seenUrlsRef.current = new Set();
      cachedUrlsRef.current = [];
      return extractUrls(messages);
    }

    // Only scan messages we haven't seen yet
    if (startIdx < messages.length) {
      const newMessages = messages.slice(startIdx);
      for (const msg of newMessages) {
        let textContent = '';
        if (typeof msg.content === 'string') {
          textContent = msg.content;
        } else if (Array.isArray(msg.content)) {
          textContent = extractTextFromBlocks(msg.content as ContentBlock[]);
        }
        const matches = textContent.match(URL_REGEX);
        if (matches) {
          for (const rawUrl of matches) {
            const url = cleanUrl(rawUrl);
            if (url && !seenUrlsRef.current.has(url)) {
              seenUrlsRef.current.add(url);
              cachedUrlsRef.current.push({ url, category: categorizeUrl(url) });
            }
          }
        }
      }
      scannedCountRef.current = messages.length;
    }

    return cachedUrlsRef.current;
  }, [messages]);

  const grouped = useMemo(() => {
    const groups: Record<string, ExtractedUrl[]> = {};
    for (const u of urls) {
      if (!groups[u.category]) groups[u.category] = [];
      groups[u.category].push(u);
    }
    return groups;
  }, [urls]);

  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);

  const handlePress = async (url: string) => {
    if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await WebBrowser.openBrowserAsync(url, {
      presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
      controlsColor: '#fff',
      toolbarColor: '#0a0a0a',
    });
  };

  const handleLongPress = useCallback((url: string) => {
    if (Platform.OS === 'ios') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    Clipboard.setStringAsync(url);
    setCopiedUrl(url);
    setTimeout(() => setCopiedUrl(null), 1500);
  }, []);

  if (urls.length === 0) {
    return (
      <View style={styles.centered}>
        <Text style={styles.emptyText}>No artifacts found</Text>
        <Text style={styles.emptySubtext}>URLs and deployments from the conversation will appear here</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {CATEGORY_ORDER.map(category => {
        const items = grouped[category];
        if (!items || items.length === 0) return null;

        return (
          <View key={category} style={styles.section}>
            <Text style={styles.sectionTitle}>{CATEGORY_LABELS[category]}</Text>
            {items.map((item, i) => (
              <TouchableOpacity
                key={`${item.url}-${i}`}
                style={styles.urlRow}
                onPress={() => handlePress(item.url)}
                onLongPress={() => handleLongPress(item.url)}
                activeOpacity={0.6}
              >
                <View style={styles.urlIcon}>
                  {category === 'deployment' ? <DeployIcon /> :
                   category === 'localhost' ? <ServerIcon /> :
                   <LinkIcon />}
                </View>
                <View style={styles.urlInfo}>
                  <Text style={styles.urlText} numberOfLines={2}>{item.url}</Text>
                  {category === 'localhost' && (
                    <Text style={styles.urlNote}>Running on development machine</Text>
                  )}
                </View>
                {copiedUrl === item.url ? (
                  <Text style={styles.copiedLabel}>Copied</Text>
                ) : (
                  <ExternalLinkIcon />
                )}
              </TouchableOpacity>
            ))}
          </View>
        );
      })}
    </ScrollView>
  );
}

function DeployIcon() {
  return (
    <Svg width={16} height={16} viewBox="0 0 24 24" fill="none">
      <Path d="M22 12l-10-10L2 12" stroke="#22c55e" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="M12 2v20" stroke="#22c55e" strokeWidth={2} strokeLinecap="round" />
    </Svg>
  );
}

function ServerIcon() {
  return (
    <Svg width={16} height={16} viewBox="0 0 24 24" fill="none">
      <Path d="M2 5a2 2 0 012-2h16a2 2 0 012 2v4a2 2 0 01-2 2H4a2 2 0 01-2-2V5z" stroke="#f59e0b" strokeWidth={1.8} />
      <Path d="M2 15a2 2 0 012-2h16a2 2 0 012 2v4a2 2 0 01-2 2H4a2 2 0 01-2-2v-4z" stroke="#f59e0b" strokeWidth={1.8} />
      <Path d="M6 7h.01M6 17h.01" stroke="#f59e0b" strokeWidth={2} strokeLinecap="round" />
    </Svg>
  );
}

function LinkIcon() {
  return (
    <Svg width={16} height={16} viewBox="0 0 24 24" fill="none">
      <Path
        d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"
        stroke="#3b82f6"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"
        stroke="#3b82f6"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

function ExternalLinkIcon() {
  return (
    <Svg width={14} height={14} viewBox="0 0 24 24" fill="none">
      <Path
        d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3"
        stroke="#555"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    paddingBottom: 20,
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
  },
  emptyText: {
    color: '#555',
    fontSize: 15,
    fontWeight: '500',
  },
  emptySubtext: {
    color: '#3a3a3a',
    fontSize: 12,
    marginTop: 4,
    textAlign: 'center',
  },
  section: {
    marginTop: 4,
  },
  sectionTitle: {
    color: '#555',
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
  },
  urlRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.04)',
    gap: 10,
  },
  urlIcon: {
    width: 24,
    alignItems: 'center',
  },
  urlInfo: {
    flex: 1,
  },
  urlText: {
    color: '#ccc',
    fontSize: 13,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  urlNote: {
    color: '#555',
    fontSize: 11,
    marginTop: 2,
  },
  copiedLabel: {
    color: '#22c55e',
    fontSize: 11,
    fontWeight: '600',
  },
});
