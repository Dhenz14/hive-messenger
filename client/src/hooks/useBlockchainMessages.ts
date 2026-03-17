import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import {
  getConversationMessages,
  getCustomJsonTextMessages,
  discoverConversations,
} from '@/lib/hive';
import {
  getMessagesByConversation,
  cacheMessage,
  cacheMessages,
  updateConversation,
  getConversation,
  getConversationKey,
  getIndexedOpsByConversation,
  type MessageCache,
} from '@/lib/messageCache';
import { queryClient } from '@/lib/queryClient';
import { useEffect, useState, useRef, useCallback } from 'react';
import { logger } from '@/lib/logger';
import { getAccountMetadata, parseMinimumHBD, DEFAULT_MINIMUM_HBD } from '@/lib/accountMetadata';
import { useExceptionsList } from '@/hooks/useExceptionsList';

// ---------------------------------------------------------------------------
// Helpers (module-level, no re-creation per render)
// ---------------------------------------------------------------------------

function parseHBDAmount(amountString: string): number {
  const parts = amountString.trim().split(' ');
  if (parts.length === 2 && parts[1] === 'HBD') return parseFloat(parts[0]);
  return 0;
}

function isCorruptedMessage(msg: MessageCache): boolean {
  if (msg.isDecrypted) return false;
  if (msg.content?.startsWith('#')) return true;
  if (msg.content === msg.encryptedContent && msg.encryptedContent) return true;
  if (msg.content && msg.content.length > 80 && !msg.content.includes(' ') &&
      msg.encryptedContent && msg.encryptedContent.length > 80) return true;
  if (msg.content?.includes('[Encrypted') &&
      msg.content !== '[🔒 Encrypted - Click to decrypt]') return true;
  return false;
}

// ---------------------------------------------------------------------------
// useBlockchainMessages
// ---------------------------------------------------------------------------

interface UseBlockchainMessagesOptions {
  partnerUsername: string;
  enabled?: boolean;
}

export function useBlockchainMessages({
  partnerUsername,
  enabled = true,
}: UseBlockchainMessagesOptions) {
  const { user } = useAuth();
  const { isException } = useExceptionsList();
  const [isActive, setIsActive] = useState(true);
  const [lastSendTime, setLastSendTime] = useState<number>(0);
  const [lastActivityTime, setLastActivityTime] = useState<number>(Date.now());
  const corruptionFixedRef = useRef(false);

  // Visibility tracking
  useEffect(() => {
    const handler = () => setIsActive(!document.hidden);
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, []);

  // Activity tracking (throttled — update at most once per 5s)
  useEffect(() => {
    let lastUpdate = 0;
    const handler = () => {
      const now = Date.now();
      if (now - lastUpdate > 5000) {
        lastUpdate = now;
        setLastActivityTime(now);
      }
    };
    window.addEventListener('mousemove', handler, { passive: true });
    window.addEventListener('keypress', handler, { passive: true });
    return () => {
      window.removeEventListener('mousemove', handler);
      window.removeEventListener('keypress', handler);
    };
  }, []);

  // Fast polling trigger for MessageComposer
  useEffect(() => {
    registerFastPollingTrigger(() => setLastSendTime(Date.now()));
    return () => registerFastPollingTrigger(() => {});
  }, []);

  // Listen for exceptions changes
  useEffect(() => {
    const handler = (event: CustomEvent) => {
      if (user?.username && event.detail?.username === user.username) {
        queryClient.invalidateQueries({
          queryKey: ['blockchain-messages', user.username, partnerUsername],
        });
      }
    };
    window.addEventListener('exceptionsChanged', handler as EventListener);
    return () => window.removeEventListener('exceptionsChanged', handler as EventListener);
  }, [user?.username, partnerUsername]);

  // Pre-populate cache for instant display
  useEffect(() => {
    if (!user?.username || !partnerUsername || !enabled) return;
    getMessagesByConversation(user.username, partnerUsername).then(cached => {
      if (cached.length === 0) return;
      const visible = cached.filter(m => !m.hidden);
      queryClient.setQueryData(
        ['blockchain-messages', user.username, partnerUsername],
        { messages: visible, hiddenCount: cached.length - visible.length },
      );
    });
  }, [user?.username, partnerUsername, enabled]);

  // ONE-TIME corruption fix on mount (not every query cycle)
  useEffect(() => {
    if (!user?.username || !partnerUsername || corruptionFixedRef.current) return;
    corruptionFixedRef.current = true;

    getMessagesByConversation(user.username, partnerUsername).then(async (messages) => {
      const corrupted = messages.filter(isCorruptedMessage);
      if (corrupted.length === 0) return;

      logger.info('[CORRUPTION] Fixing', corrupted.length, 'corrupted messages (one-time)');
      const fixed = corrupted.map(msg => ({
        ...msg,
        content: '[🔒 Encrypted - Click to decrypt]',
      }));
      await cacheMessages(fixed, user.username);

      // Invalidate to pick up fixes
      queryClient.invalidateQueries({
        queryKey: ['blockchain-messages', user.username, partnerUsername],
      });
    });
  }, [user?.username, partnerUsername]);

  const query = useQuery({
    queryKey: ['blockchain-messages', user?.username, partnerUsername],
    queryFn: async () => {
      if (!user?.username) throw new Error('User not authenticated');

      // Load minimum HBD preference
      let userMinimumAmount = 0;
      try {
        const metadata = await getAccountMetadata(user.username);
        userMinimumAmount = parseHBDAmount(parseMinimumHBD(metadata));
      } catch { /* use 0 default */ }

      const conversationKey = getConversationKey(user.username, partnerUsername);

      // 1) Load cached messages from IndexedDB (instant)
      const cachedMessages = await getMessagesByConversation(user.username, partnerUsername);

      // 2) Build merged map — single pass, no corruption check (done on mount)
      const merged = new Map<string, MessageCache>();
      for (const msg of cachedMessages) {
        merged.set(msg.id, msg);
      }

      // 3) Read indexed ops from replay engine (already populated by background sync)
      try {
        const indexedOps = await getIndexedOpsByConversation(user.username, partnerUsername);

        const newMessages: MessageCache[] = [];
        for (const op of indexedOps) {
          if (merged.has(op.txId)) continue;
          if (op.sessionId && op.chunkIndex !== undefined && op.chunkIndex > 0) continue;

          const isSent = op.from === user.username;
          const shouldHide = op.opType === 'transfer' && !isSent &&
            !isException(op.from) && parseHBDAmount(op.amount || '0') < userMinimumAmount;

          newMessages.push({
            id: op.txId,
            conversationKey,
            from: op.from,
            to: op.to,
            content: '[🔒 Encrypted - Click to decrypt]',
            encryptedContent: op.payload,
            timestamp: op.timestamp,
            txId: op.txId,
            confirmed: true,
            amount: op.amount,
            hidden: shouldHide,
            messageType: op.opType === 'transfer' ? 'memo' : 'customJsonText',
            hash: op.hash,
          });
          merged.set(op.txId, newMessages[newMessages.length - 1]);
        }

        // 4) Fetch last 50 recent ops for real-time recency (lightweight)
        const [recentTransfers, recentCustomJson] = await Promise.all([
          getConversationMessages(user.username, partnerUsername, 50).catch(() => []),
          getCustomJsonTextMessages(user.username, partnerUsername, 50).catch(() => []),
        ]);

        for (const msg of recentTransfers) {
          if (merged.has(msg.trx_id)) continue;
          const isSent = msg.from === user.username;
          const shouldHide = !isSent && !isException(msg.from) &&
            parseHBDAmount(msg.amount || '0') < userMinimumAmount;

          const mc: MessageCache = {
            id: msg.trx_id, conversationKey, from: msg.from, to: msg.to,
            content: '[🔒 Encrypted - Click to decrypt]', encryptedContent: msg.memo,
            timestamp: msg.timestamp, txId: msg.trx_id, confirmed: true,
            amount: msg.amount, hidden: shouldHide, messageType: 'memo',
          };
          newMessages.push(mc);
          merged.set(msg.trx_id, mc);
        }

        for (const cj of recentCustomJson) {
          if (merged.has(cj.txId)) continue;
          const mc: MessageCache = {
            id: cj.txId, conversationKey, from: cj.from, to: cj.to,
            content: '[🔒 Encrypted - Click to decrypt]', encryptedContent: cj.encryptedPayload,
            timestamp: cj.timestamp, txId: cj.txId, confirmed: true,
            messageType: 'customJsonText', hash: cj.hash, hidden: false,
          };
          newMessages.push(mc);
          merged.set(cj.txId, mc);
        }

        // 5) Batch write only genuinely new messages (fire-and-forget — don't block UI)
        if (newMessages.length > 0) {
          cacheMessages(newMessages, user.username).catch(() => {});
        }
      } catch (err) {
        logger.error('[QUERY] Blockchain fetch failed, using cached data:', err);
      }

      // 6) Sort + filter in one pass
      const all = Array.from(merged.values());
      all.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

      const visible: MessageCache[] = [];
      let hiddenCount = 0;
      for (const msg of all) {
        if (msg.hidden) { hiddenCount++; } else { visible.push(msg); }
      }

      // Update conversation metadata (fire-and-forget)
      if (visible.length > 0) {
        const last = visible[visible.length - 1];
        updateConversation({
          conversationKey, partnerUsername,
          lastMessage: last.content, lastTimestamp: last.timestamp,
          unreadCount: 0, lastChecked: new Date().toISOString(),
        }, user.username).catch(() => {});
      }

      return { messages: visible, hiddenCount };
    },
    enabled: enabled && !!user?.username && !!partnerUsername,
    refetchInterval: () => {
      const now = Date.now();
      if (!isActive) return 45000;
      if (now - lastSendTime < 15000) return 3000;
      if (now - lastActivityTime < 60000) return 5000;
      return 15000;
    },
    staleTime: 12000,
    gcTime: 300000,
    refetchOnWindowFocus: 'always',
  });

  return query;
}

// ---------------------------------------------------------------------------
// useConversationDiscovery
// ---------------------------------------------------------------------------

export function useConversationDiscovery() {
  const { user } = useAuth();
  const [isActive, setIsActive] = useState(true);
  const [cachedConversations, setCachedConversations] = useState<any[]>([]);

  useEffect(() => {
    const handler = () => setIsActive(!document.hidden);
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, []);

  useEffect(() => {
    if (!user?.username) return;
    import('@/lib/messageCache').then(({ getConversations }) => {
      getConversations(user.username).then(cached => {
        if (cached.length > 0) setCachedConversations(cached);
      });
    });
  }, [user?.username]);

  const query = useQuery({
    queryKey: ['blockchain-conversations', user?.username],
    initialData: cachedConversations.length > 0 ? cachedConversations : undefined,
    queryFn: async () => {
      if (!user?.username) throw new Error('User not authenticated');

      const { discoverPartnersFromIndex } = await import('@/lib/messageCache');
      const indexedPartners = await discoverPartnersFromIndex(user.username);
      const legacyPartners = await discoverConversations(user.username, 50);

      // Merge
      const partnerMap = new Map<string, string>();
      for (const p of indexedPartners) partnerMap.set(p.username, p.lastTimestamp);
      for (const p of legacyPartners) {
        if (!partnerMap.has(p.username) || p.lastTimestamp > partnerMap.get(p.username)!)
          partnerMap.set(p.username, p.lastTimestamp);
      }

      const allPartners = Array.from(partnerMap.entries())
        .map(([username, lastTimestamp]) => ({ username, lastTimestamp }))
        .sort((a, b) => b.lastTimestamp.localeCompare(a.lastTimestamp));

      const allCached = await Promise.all(
        allPartners.map(({ username }) => getConversation(user.username, username))
      );

      const newConversations = await Promise.all(
        allPartners
          .filter((_, i) => !allCached[i])
          .map(async ({ username, lastTimestamp }) => {
            const conv = {
              conversationKey: getConversationKey(user.username, username),
              partnerUsername: username,
              lastMessage: `New conversation with @${username}`,
              lastTimestamp, unreadCount: 0,
              lastChecked: new Date().toISOString(),
            };
            await updateConversation(conv, user.username);
            return conv;
          })
      );

      return [...allCached.filter(Boolean), ...newConversations.filter(Boolean)];
    },
    enabled: !!user?.username,
    refetchInterval: () => (!isActive ? 90000 : 20000),
    staleTime: 20000,
  });

  return query;
}

// ---------------------------------------------------------------------------
// Fast polling singleton
// ---------------------------------------------------------------------------

let triggerFastPollingCallback: (() => void) | null = null;

export const registerFastPollingTrigger = (callback: () => void) => {
  triggerFastPollingCallback = callback;
};

export const triggerFastPolling = () => {
  triggerFastPollingCallback?.();
};
