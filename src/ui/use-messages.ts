import { useEffect, useState } from 'react';
import type { Toi } from '../app/toi';
import type { ConversationId } from '../domain/ids';
import type { Message } from '../domain/message';
import { keepUnchanged, mergeMessages } from './merge';

/**
 * Mensagens da Conversa: o que está gravado (também por outra aba) mais o
 * Fluxo desta aba, que chega antes do flush. Tudo vai ao React no máximo uma
 * vez por frame.
 */
export const useMessages = (toi: Toi, conversationId: ConversationId | null): Message[] => {
  const [messages, setMessages] = useState<Message[]>([]);

  useEffect(() => {
    setMessages([]);
    if (conversationId === null) return;

    let stored: Message[] = [];
    const live = new Map<string, Message>();
    let frame: number | null = null;

    const render = (): void => {
      frame = null;
      const merged = mergeMessages(stored, live);
      setMessages((previous) => keepUnchanged(previous, merged));
    };
    const schedule = (): void => {
      frame ??= requestAnimationFrame(render);
    };

    const stopWatching = toi.watchMessages(conversationId, (messages) => {
      stored = messages;
      schedule();
    });

    const unsubscribe = toi.subscribe((message) => {
      if (message.conversationId !== conversationId) return;
      live.set(message.id, message);
      schedule();
    });

    return () => {
      stopWatching();
      unsubscribe();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [toi, conversationId]);

  return messages;
};
