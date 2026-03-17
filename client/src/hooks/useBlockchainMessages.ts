import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import {
  getConversationMessages,
  getCustomJsonTextMessages,
  decryptMemo,
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
  type IndexedOp,
} from '@/lib/messageCache';
import { syncAccount, type SyncResult } from '@/lib/replayEngine';
import { queryClient } from '@/lib/queryClient';
import { useEffect, useState } from 'react';
import { logger } from '@/lib/logger';
import { getAccountMetadata, parseMinimumHBD, DEFAULT_MINIMUM_HBD } from '@/lib/accountMetadata';
import { useExceptionsList } from '@/hooks/useExceptionsList';
import { decryptTextPayload } from '@/lib/customJsonEncryption';

interface UseBlockchainMessagesOptions {
  partnerUsername: string;
  enabled?: boolean;
}

export function useBlockchainMessages({
  partnerUsername,
  enabled = true,
}: UseBlockchainMessagesOptions) {
  const { user } = useAuth();
  const { isException } = useExceptionsList(); // Check if contact is on exceptions list (from context)
  const [isActive, setIsActive] = useState(true);
  const [lastSendTime, setLastSendTime] = useState<number>(0);
  const [lastActivityTime, setLastActivityTime] = useState<number>(Date.now());
  
  // Listen for exceptions changes and invalidate query to trigger re-evaluation
  useEffect(() => {
    const handleExceptionsChanged = (event: CustomEvent) => {
      if (user?.username && event.detail?.username === user.username) {
        console.log('[useBlockchainMessages] Exceptions changed, invalidating query for re-evaluation');
        queryClient.invalidateQueries({ 
          queryKey: ['blockchain-messages', user.username, partnerUsername] 
        });
      }
    };
    
    window.addEventListener('exceptionsChanged', handleExceptionsChanged as EventListener);
    
    return () => {
      window.removeEventListener('exceptionsChanged', handleExceptionsChanged as EventListener);
    };
  }, [user?.username, partnerUsername]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      setIsActive(!document.hidden);
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  // Track user activity for adaptive polling
  useEffect(() => {
    const handleActivity = () => {
      setLastActivityTime(Date.now());
    };
    
    // Update activity time on mouse/keyboard events
    window.addEventListener('mousemove', handleActivity);
    window.addEventListener('keypress', handleActivity);
    
    return () => {
      window.removeEventListener('mousemove', handleActivity);
      window.removeEventListener('keypress', handleActivity);
    };
  }, []);

  // Register fast polling trigger for MessageComposer
  useEffect(() => {
    registerFastPollingTrigger(() => setLastSendTime(Date.now()));
    return () => registerFastPollingTrigger(() => {});
  }, []);

  // TIER 1 OPTIMIZATION: Pre-populate React Query cache with cached messages for instant display
  // Removed immediate invalidation - let staleTime control when to refetch
  useEffect(() => {
    if (user?.username && partnerUsername && enabled) {
      getMessagesByConversation(user.username, partnerUsername).then(cachedMessages => {
        if (cachedMessages.length > 0) {
          // PHASE 4.1: Filter out hidden messages for instant display
          const visibleCached = cachedMessages.filter(msg => !msg.hidden);
          const hiddenCachedCount = cachedMessages.length - visibleCached.length;
          
          logger.info('[MESSAGES] Pre-populating cache with', visibleCached.length, 'visible messages (', hiddenCachedCount, 'hidden)');
          const queryKey = ['blockchain-messages', user.username, partnerUsername];
          
          // Seed cache with cached data (shows instantly) - new format with hiddenCount
          queryClient.setQueryData(queryKey, {
            messages: visibleCached,
            hiddenCount: hiddenCachedCount,
          });
          
          // OPTIMIZATION: Don't immediately invalidate - let staleTime/refetchInterval handle it
          // This prevents excessive refetches on tab switch / component remount
        }
      });
    }
  }, [user?.username, partnerUsername, enabled]);

  const query = useQuery({
    queryKey: ['blockchain-messages', user?.username, partnerUsername],
    queryFn: async () => {
      logger.info('[QUERY] Starting blockchain messages query for:', { username: user?.username, partner: partnerUsername });
      
      if (!user?.username) {
        throw new Error('User not authenticated');
      }

      // PHASE 4.1: Load user's minimum HBD preference ONCE per query
      let userMinimumHBD = DEFAULT_MINIMUM_HBD;
      try {
        const metadata = await getAccountMetadata(user.username);
        userMinimumHBD = parseMinimumHBD(metadata);
        logger.info('[FILTER] User minimum HBD:', userMinimumHBD);
      } catch (error) {
        logger.warn('[FILTER] Failed to load minimum HBD, using default:', DEFAULT_MINIMUM_HBD);
      }

      // Helper: Parse HBD amount string to number for comparison
      const parseHBDAmount = (amountString: string): number => {
        // Amount format: "0.001 HBD" or "1.000 HBD"
        const parts = amountString.trim().split(' ');
        if (parts.length === 2 && parts[1] === 'HBD') {
          return parseFloat(parts[0]);
        }
        return 0;
      };

      const userMinimumAmount = parseHBDAmount(userMinimumHBD);

      // PERFORMANCE FIX: Load cached messages FIRST to display instantly
      const cachedMessages = await getMessagesByConversation(
        user.username,
        partnerUsername
      );
      
      logger.info('[QUERY] Retrieved cached messages:', cachedMessages.length);
      cachedMessages.forEach((msg, idx) => {
        logger.sensitive(`[QUERY] Cached msg ${idx}:`, { 
          id: msg.id.substring(0, 15) + '...', 
          from: msg.from, 
          contentPreview: msg.content.substring(0, 50) + '...',
          contentLength: msg.content.length 
        });
      });

      const mergedMessages = new Map<string, MessageCache>();
      cachedMessages.forEach((msg) => {
        // Detect and fix corrupted messages where content contains encrypted data
        // If message is marked as decrypted, trust it - user manually decrypted it
        if (!msg.isDecrypted) {
          let isCorrupted = false;
          
          // Case 0: content starts with # (encrypted memo format) - THIS IS THE MOST OBVIOUS CASE!
          if (msg.content && msg.content.startsWith('#')) {
            logger.info('[QUERY] Corrupted (case 0): content starts with # (encrypted memo), msg:', msg.id.substring(0, 20));
            isCorrupted = true;
          }
          
          // Case 1: content exactly matches encryptedContent (most obvious corruption)
          if (!isCorrupted && msg.content === msg.encryptedContent && msg.encryptedContent) {
            logger.info('[QUERY] Corrupted (case 1): content === encryptedContent, msg:', msg.id.substring(0, 20));
            isCorrupted = true;
          }
          
          // Case 2: content looks like encrypted data (long gibberish without spaces)
          // Encrypted memos are typically 100+ chars of base64-like data
          if (!isCorrupted && msg.content && msg.content.length > 50) {
            const hasSpaces = msg.content.includes(' ');
            const hasCommonWords = /\b(the|is|are|was|were|hello|hi|you|me|we|they)\b/i.test(msg.content);
            const looksLikeEncrypted = !hasSpaces && !hasCommonWords && msg.content.length > 80;
            
            if (looksLikeEncrypted && msg.encryptedContent && msg.encryptedContent.length > 80) {
              logger.info('[QUERY] Corrupted (case 2): content looks encrypted, msg:', msg.id.substring(0, 20));
              isCorrupted = true;
            }
          }
          
          // Case 3: content is encrypted placeholder but doesn't match our standard format
          if (!isCorrupted && msg.content && msg.content.includes('[Encrypted') && 
              msg.content !== '[🔒 Encrypted - Click to decrypt]') {
            logger.info('[QUERY] Corrupted (case 3): non-standard placeholder, msg:', msg.id.substring(0, 20));
            isCorrupted = true;
          }
          
          if (isCorrupted) {
            logger.info('[QUERY] FIXING corrupted message, setting placeholder');
            msg.content = '[🔒 Encrypted - Click to decrypt]';
            cacheMessage(msg, user.username).catch(err => logger.error('[QUERY] Failed to fix message:', err));
          }
        }
        
        mergedMessages.set(msg.id, msg);
      });

      try {
        const conversationKey = getConversationKey(user.username, partnerUsername);

        // REPLAY ENGINE: Trigger background sync (crawls full history with pagination)
        // This replaces the old 200-op limit fetch with unbounded backward crawl
        try {
          const syncResult = await syncAccount(user.username);
          if (syncResult.newOps > 0) {
            logger.info('[REPLAY] Sync found', syncResult.newOps, 'new ops');
          }
        } catch (syncErr) {
          logger.warn('[REPLAY] Sync error (falling back to legacy fetch):', syncErr);
        }

        // REPLAY ENGINE: Read indexed ops for this conversation from IndexedDB
        // The replay engine has already crawled all history and stored it
        const indexedOps = await getIndexedOpsByConversation(user.username, partnerUsername);
        logger.info('[REPLAY] Found', indexedOps.length, 'indexed ops for conversation');

        // Convert indexed ops to MessageCache format and merge
        const newMessagesToCache: MessageCache[] = [];

        for (const op of indexedOps) {
          if (mergedMessages.has(op.txId)) continue;

          // Skip multi-chunk image parts (they'll be reassembled separately)
          if (op.sessionId && op.chunkIndex !== undefined && op.chunkIndex > 0) continue;

          if (op.opType === 'transfer') {
            // Legacy memo-based transfer message
            const messageAmount = parseHBDAmount(op.amount || '0.000 HBD');
            const senderIsException = isException(op.from);
            const isSent = op.from === user.username;
            const shouldHide = !isSent && !senderIsException && messageAmount < userMinimumAmount;

            const messageCache: MessageCache = {
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
              messageType: 'memo',
            };

            newMessagesToCache.push(messageCache);
            mergedMessages.set(op.txId, messageCache);
          } else if (op.opType === 'custom_json_text') {
            // Custom JSON text message (always visible - no HBD filter)
            const messageCache: MessageCache = {
              id: op.txId,
              conversationKey,
              from: op.from,
              to: op.to,
              content: '[🔒 Encrypted - Click to decrypt]',
              encryptedContent: op.payload,
              timestamp: op.timestamp,
              txId: op.txId,
              confirmed: true,
              messageType: 'customJsonText',
              hash: op.hash,
              hidden: false,
            };

            newMessagesToCache.push(messageCache);
            mergedMessages.set(op.txId, messageCache);
          } else if (op.opType === 'custom_json_img') {
            // Custom JSON image message (single-op or first chunk of reassembled)
            const messageCache: MessageCache = {
              id: op.txId,
              conversationKey,
              from: op.from,
              to: op.to,
              content: '[🔒 Encrypted - Click to decrypt]',
              encryptedContent: op.payload,
              timestamp: op.timestamp,
              txId: op.txId,
              confirmed: true,
              messageType: 'customJsonImage' as any,
              hash: op.hash,
              hidden: false,
            };

            newMessagesToCache.push(messageCache);
            mergedMessages.set(op.txId, messageCache);
          }
        }

        // ALSO run legacy fetch for very recent messages not yet indexed by replay engine
        // (The replay engine may have a slight delay on brand-new ops)
        try {
          const recentTransfers = await getConversationMessages(
            user.username, partnerUsername, 50
          );
          const recentCustomJson = await getCustomJsonTextMessages(
            user.username, partnerUsername, 50
          );

          for (const msg of recentTransfers) {
            if (mergedMessages.has(msg.trx_id)) continue;
            const messageAmount = parseHBDAmount(msg.amount || '0.000 HBD');
            const senderIsException = isException(msg.from);
            const isSent = msg.from === user.username;
            const shouldHide = !isSent && !senderIsException && messageAmount < userMinimumAmount;

            const messageCache: MessageCache = {
              id: msg.trx_id,
              conversationKey,
              from: msg.from,
              to: msg.to,
              content: '[🔒 Encrypted - Click to decrypt]',
              encryptedContent: msg.memo,
              timestamp: msg.timestamp,
              txId: msg.trx_id,
              confirmed: true,
              amount: msg.amount,
              hidden: shouldHide,
              messageType: 'memo',
            };
            newMessagesToCache.push(messageCache);
            mergedMessages.set(msg.trx_id, messageCache);
          }

          for (const cjMsg of recentCustomJson) {
            if (mergedMessages.has(cjMsg.txId)) continue;
            const messageCache: MessageCache = {
              id: cjMsg.txId,
              conversationKey,
              from: cjMsg.from,
              to: cjMsg.to,
              content: '[🔒 Encrypted - Click to decrypt]',
              encryptedContent: cjMsg.encryptedPayload,
              timestamp: cjMsg.timestamp,
              txId: cjMsg.txId,
              confirmed: true,
              messageType: 'customJsonText',
              hash: cjMsg.hash,
              hidden: false,
            };
            newMessagesToCache.push(messageCache);
            mergedMessages.set(cjMsg.txId, messageCache);
          }
        } catch (legacyErr) {
          logger.warn('[REPLAY] Legacy recent fetch failed:', legacyErr);
        }

        // Batch write all new messages to IndexedDB
        if (newMessagesToCache.length > 0) {
          logger.info('[QUERY] Batching', newMessagesToCache.length, 'new messages for IndexedDB write');
          await cacheMessages(newMessagesToCache, user.username);
        }
      } catch (blockchainError) {
        logger.error('Failed to fetch from blockchain, using cached data:', blockchainError);
      }

      // PHASE 4 FIX + EXCEPTIONS: Re-evaluate ALL messages (cached + new) against current user minimum
      // This ensures that when user changes their minimum threshold OR exceptions list, cached messages are updated
      logger.info('[PHASE4] Re-evaluating', mergedMessages.size, 'messages against current minimum:', userMinimumHBD);
      let reEvaluatedCount = 0;
      
      mergedMessages.forEach((msg, id) => {
        if (msg.from !== user.username) {
          // RECEIVED message: Re-evaluate ONLY if it's a memo-based message
          // custom_json text messages are always visible (no minimum HBD filter)
          if (msg.messageType === 'memo' || !msg.messageType) {
            // Legacy memo-based message: Apply minimum HBD filter
            const msgAmount = parseHBDAmount(msg.amount || '0.000 HBD');
            const senderIsException = isException(msg.from);
            // Hide if: below minimum AND not an exception
            const isHidden = !senderIsException && msgAmount < userMinimumAmount;
            
            // Only update if hidden state changed
            if (msg.hidden !== isHidden) {
              mergedMessages.set(id, { ...msg, hidden: isHidden });
              reEvaluatedCount++;
              logger.info('[PHASE4] Updated hidden flag for memo message:', {
                txId: msg.id.substring(0, 20),
                from: msg.from,
                amount: msg.amount,
                isException: senderIsException,
                oldHidden: msg.hidden,
                newHidden: isHidden
              });
            }
          } else if (msg.messageType === 'customJsonText') {
            // custom_json text message: Always visible
            if (msg.hidden !== false) {
              mergedMessages.set(id, { ...msg, hidden: false });
              reEvaluatedCount++;
              logger.info('[PHASE4] custom_json text message always visible:', {
                txId: msg.id.substring(0, 20),
                from: msg.from
              });
            }
          }
        } else {
          // SENT message: Always visible (never hide sent messages)
          if (msg.hidden !== false) {
            mergedMessages.set(id, { ...msg, hidden: false });
            reEvaluatedCount++;
          }
        }
      });
      
      logger.info('[PHASE4] Re-evaluated', reEvaluatedCount, 'messages with changed hidden state');

      const allMessages = Array.from(mergedMessages.values()).sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      );

      // PHASE 4.1: Filter out hidden messages and track count
      const visibleMessages = allMessages.filter(msg => !msg.hidden);
      const hiddenCount = allMessages.length - visibleMessages.length;

      logger.info('[QUERY] Total messages:', allMessages.length, 'Visible:', visibleMessages.length, 'Hidden:', hiddenCount);
      visibleMessages.forEach((msg, idx) => {
        logger.sensitive(`[QUERY] Visible msg ${idx}:`, { 
          id: msg.id.substring(0, 15) + '...', 
          from: msg.from, 
          contentPreview: msg.content.substring(0, 50) + '...',
          contentLength: msg.content.length,
          amount: msg.amount 
        });
      });

      if (visibleMessages.length > 0) {
        const lastMessage = visibleMessages[visibleMessages.length - 1];
        await updateConversation({
          conversationKey: getConversationKey(user.username, partnerUsername),
          partnerUsername,
          lastMessage: lastMessage.content,
          lastTimestamp: lastMessage.timestamp,
          unreadCount: 0,
          lastChecked: new Date().toISOString(),
        }, user.username);
      }

      // PHASE 4.1: Return object with filtered messages and hidden count
      return {
        messages: visibleMessages,
        hiddenCount,
      };
    },
    enabled: enabled && !!user?.username && !!partnerUsername,
    refetchInterval: (data) => {
      const now = Date.now();
      const timeSinceLastSend = now - lastSendTime;
      const timeSinceActivity = now - lastActivityTime;
      
      // Background tab: slow polling
      if (!isActive) return 45000; // 45 seconds
      
      // Burst mode: Fast polling for 15 seconds after sending a message
      if (timeSinceLastSend < 15000) {
        return 3000; // 3 seconds for instant feedback
      }
      
      // Active conversation: Recent activity (typing, viewing)
      if (timeSinceActivity < 60000) {
        return 5000; // 5 seconds - optimal balance
      }
      
      // Idle conversation: No recent activity
      return 15000; // 15 seconds - slower but still responsive
    },
    staleTime: 12000, // 12 seconds - serves cached data, reduces redundant fetches
    gcTime: 300000, // TIER 1 OPTIMIZATION: 5 minutes (was default) - keep in memory longer
    refetchOnWindowFocus: 'always', // Still refetch on focus for freshness
  });

  return query;
}

export function useConversationDiscovery() {
  const { user } = useAuth();
  const [isActive, setIsActive] = useState(true);
  const [cachedConversations, setCachedConversations] = useState<any[]>([]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      setIsActive(!document.hidden);
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  // PERFORMANCE FIX: Load cached conversations immediately on mount
  useEffect(() => {
    if (user?.username) {
      import('@/lib/messageCache').then(({ getConversations }) => {
        getConversations(user.username).then(cached => {
          logger.info('[CONV DISCOVERY] Loaded', cached.length, 'cached conversations immediately');
          setCachedConversations(cached);
        });
      });
    }
  }, [user?.username]);

  const query = useQuery({
    queryKey: ['blockchain-conversations', user?.username],
    // PERFORMANCE FIX: Return cached data immediately if available
    initialData: cachedConversations.length > 0 ? cachedConversations : undefined,
    queryFn: async () => {
      if (!user?.username) {
        throw new Error('User not authenticated');
      }

      logger.info('[CONV DISCOVERY] Starting discovery with replay engine for user:', user.username);

      // REPLAY ENGINE: The sync is already running (triggered by useBlockchainMessages
      // or the auth lifecycle). Discover partners from the indexed ops.
      const { discoverPartnersFromIndex } = await import('@/lib/messageCache');
      const indexedPartners = await discoverPartnersFromIndex(user.username);

      logger.info('[REPLAY] Discovered', indexedPartners.length, 'partners from indexed ops');

      // ALSO run legacy discovery for very recent messages (last 50 ops)
      // that may not yet be in the replay engine index
      const legacyPartners = await discoverConversations(user.username, 50);

      // Merge: indexed partners take priority, add any legacy-only partners
      const partnerMap = new Map<string, string>();
      for (const p of indexedPartners) {
        partnerMap.set(p.username, p.lastTimestamp);
      }
      for (const p of legacyPartners) {
        if (!partnerMap.has(p.username) || p.lastTimestamp > partnerMap.get(p.username)!) {
          partnerMap.set(p.username, p.lastTimestamp);
        }
      }

      const allPartners = Array.from(partnerMap.entries())
        .map(([username, lastTimestamp]) => ({ username, lastTimestamp }))
        .sort((a, b) => b.lastTimestamp.localeCompare(a.lastTimestamp));

      logger.info('[CONV DISCOVERY] Total partners after merge:', allPartners.length);

      // Process all partners: check cache, create placeholders for new ones
      const allCached = await Promise.all(
        allPartners.map(({ username }) => getConversation(user.username, username))
      );

      const uncached = allPartners.filter((_, index) => !allCached[index]);

      const newConversations = await Promise.all(
        uncached.map(async ({ username, lastTimestamp }) => {
          const newConversation = {
            conversationKey: getConversationKey(user.username, username),
            partnerUsername: username,
            lastMessage: `New conversation with @${username}`,
            lastTimestamp: lastTimestamp,
            unreadCount: 0,
            lastChecked: new Date().toISOString(),
          };

          await updateConversation(newConversation, user.username);
          return newConversation;
        })
      );

      const conversations = [
        ...allCached.filter(Boolean),
        ...newConversations.filter(Boolean)
      ];

      logger.info('[CONV DISCOVERY] Complete:', conversations.length, 'conversations');
      return conversations;
    },
    enabled: !!user?.username,
    refetchInterval: (data) => {
      // Conversation list updates less frequently than messages
      if (!isActive) return 90000; // 90 seconds when hidden
      return 20000; // 20 seconds when active
    },
    staleTime: 20000, // Increased from 10s to 20s
  });

  return query;
}

// Create a singleton ref to store the setLastSendTime function
let triggerFastPollingCallback: (() => void) | null = null;

export const registerFastPollingTrigger = (callback: () => void) => {
  triggerFastPollingCallback = callback;
};

export const triggerFastPolling = () => {
  if (triggerFastPollingCallback) {
    triggerFastPollingCallback();
  }
};
