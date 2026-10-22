import { cleanTitle, retitle } from '../domain/conversation';
import type { ConversationId } from '../domain/ids';
import { textOf } from '../domain/message';
import { EFFORTS, type Model } from '../domain/model';
import type { StopReason } from '../domain/usage';
import type { ChatProvider, ChatRequest } from '../ports/chat-provider';
import type { ConversationStore } from '../ports/conversation-store';
import type { RunResult } from './send-message';

/** Quanto da pergunta e da resposta vai ao Modelo do Título; o começo basta para dizer o assunto. */
const EXCERPT_LIMIT = 2_000;

/** Cabe o Título e, num Modelo que sempre raciocina, um raciocínio curto no Esforço mínimo. */
const TITLE_MAX_TOKENS = 1_024;

/** Poucos tokens não limitam o tempo de rede: sem resposta nesse prazo, fica o derivado. */
export const TITLE_TIMEOUT_MS = 20_000;

const SYSTEM =
  'Você dá nome a conversas. Responda só com um título de 3 a 6 palavras que diga do que a ' +
  'conversa trata, no idioma da pessoa. Sem aspas, sem ponto final, sem emoji.';

/** O primeiro par da Conversa, já em texto: Anexos entram pelo nome, nunca pelos bytes. */
export interface FirstExchange {
  conversationId: ConversationId;
  question: string;
  answer: string;
}

/**
 * Como a tentativa termina. `named` grava o Título; `kept` deixa o derivado
 * porque o Modelo não escreveu um utilizável ou porque a pessoa já renomeou;
 * `failed` e `aborted` também deixam o derivado, sem aviso na UI.
 */
export type TitleOutcome = 'named' | 'kept' | 'failed' | 'aborted';

/** O primeiro par, quando a primeira resposta terminou `complete`, gravada e com texto. */
export const firstExchange = ({
  message,
  opening,
  persistError,
}: RunResult): FirstExchange | null => {
  if (opening === null || message.status !== 'complete' || persistError !== null) return null;
  const answer = textOf(message).trim();
  if (!answer) return null;

  const names = opening.parts.flatMap((part) =>
    part.type === 'file' ? [`[anexo: ${part.attachment.name}]`] : [],
  );
  return {
    conversationId: message.conversationId,
    question: [...names, textOf(opening)].filter(Boolean).join('\n'),
    answer,
  };
};

const excerpt = (text: string): string =>
  text.length <= EXCERPT_LIMIT ? text : `${text.slice(0, EXCERPT_LIMIT)}…`;

const titleRequest = (model: Model, { question, answer }: FirstExchange): ChatRequest => ({
  model: model.id,
  maxTokens: TITLE_MAX_TOKENS,
  effort: EFFORTS[0],
  reasoning: 'off',
  system: SYSTEM,
  tools: [],
  messages: [
    {
      role: 'user',
      parts: [
        {
          type: 'text',
          text: `<pergunta>\n${excerpt(question)}\n</pergunta>\n\n<resposta>\n${excerpt(answer)}\n</resposta>`,
        },
      ],
    },
  ],
});

/** O texto do Título só vale com término normal; cortado por `max_tokens` ou recusado, não. */
const readTitle = async (
  provider: ChatProvider,
  request: ChatRequest,
  signal: AbortSignal,
): Promise<string | null> => {
  let text = '';
  let stop: StopReason | null = null;
  let finished = false;

  for await (const event of provider.stream(request, signal)) {
    if (event.type === 'delta' && event.part === 'text') text += event.text;
    else if (event.type === 'usage') stop = event.stopReason;
    else if (event.type === 'finished') finished = true;
  }

  return finished && stop === 'end_turn' ? cleanTitle(text) : null;
};

/**
 * Uma tentativa, sem nova: pede o Título e o grava só sobre um derivado, numa
 * transação, para não desfazer o que a pessoa renomeou aqui ou em outra aba.
 * Não toca `updatedAt`: nomear não reordena o histórico. Conversa apagada
 * no meio não é recriada.
 */
export const nameConversation = async (
  store: ConversationStore,
  provider: ChatProvider,
  model: Model,
  exchange: FirstExchange,
  signal: AbortSignal,
): Promise<TitleOutcome> => {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), TITLE_TIMEOUT_MS);

  try {
    const title = await readTitle(
      provider,
      titleRequest(model, exchange),
      AbortSignal.any([signal, timeout.signal]),
    );
    if (signal.aborted) return 'aborted';
    if (title === null) return 'kept';

    let applied = false;
    await store.updateConversation(exchange.conversationId, (current) => {
      const next = retitle(current, title, 'generated');
      applied = next !== current;
      return next;
    });
    return applied ? 'named' : 'kept';
  } catch {
    return signal.aborted ? 'aborted' : 'failed';
  } finally {
    clearTimeout(timer);
  }
};
