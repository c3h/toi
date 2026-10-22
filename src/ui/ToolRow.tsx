import { ChevronRight, FileText, Search } from 'lucide-react';
import { memo, useId, useState } from 'react';
import type { MessageStatus, ToolCallPart, ToolResultPart } from '../domain/message';
import { WEB_FETCH, type FetchFailureCode } from '../domain/web';
import { domainOf } from './segments';
import { lower } from './support';

const FAILURES: Record<FetchFailureCode, string> = {
  not_eligible: 'fora da conversa, não foi lida',
  not_found: 'página não existe',
  http_error: 'o site respondeu com erro',
  unreachable: 'site fora do ar',
  timeout: 'demorou demais',
  blocked: 'o site bloqueia leitura automática',
  login_required: 'pede login',
  empty: 'sem texto legível',
  too_large: 'grande demais',
  rejected: 'endereço recusado',
  unknown: 'não abriu',
};

const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`;

/** O que a linha diz da chamada: a consulta da Busca ou os domínios da Leitura. */
const subjectOf = (call: ToolCallPart): { verb: [string, string]; object: string } => {
  if (call.tool === WEB_FETCH && Array.isArray(call.input.urls)) {
    const domains = [
      ...new Set(call.input.urls.flatMap((url) => (typeof url === 'string' ? [domainOf(url)] : []))),
    ];
    return { verb: ['lendo', 'leu'], object: domains.join(', ') };
  }
  const query = typeof call.input.query === 'string' ? call.input.query : '';
  return { verb: ['buscando', 'buscou'], object: `“${query}”` };
};

const summaryOf = (
  call: ToolCallPart,
  result: ToolResultPart | null,
  status: MessageStatus,
  running: boolean,
): string | null => {
  if (result === null) {
    if (running) return null;
    // `failed` sem resultado é a chamada que o limite deixou de fora; o resto, parar.
    return status === 'failed' ? 'não executada' : 'interrompida';
  }
  if (result.error) return null;
  if (call.tool !== WEB_FETCH) return plural(result.sources.length, 'fonte', 'fontes');

  const read = plural(result.sources.length, 'página', 'páginas');
  const failed = result.failures.length;
  return failed === 0 ? read : `${read} · ${failed} não ${failed === 1 ? 'abriu' : 'abriram'}`;
};

export interface ToolRowProps {
  call: ToolCallPart;
  result: ToolResultPart | null;
  /** O estado da Mensagem: sem resultado, `streaming` é chamada correndo e o resto é interrupção. */
  status: MessageStatus;
  /** A Chave do Serviço foi recusada: a correção é em Configurações. */
  onOpenSettings: () => void;
}

/**
 * Uma chamada de Ferramenta dentro da resposta: o que o Modelo pediu, em que
 * pé está e, recolhidas, as Fontes e as páginas que não abriram.
 */
export const ToolRow = memo(({ call, result, status, onOpenSettings }: ToolRowProps) => {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const { verb, object } = subjectOf(call);
  const Icon = call.tool === WEB_FETCH ? FileText : Search;
  const running = result === null && status === 'streaming';

  const sources = result?.sources ?? [];
  const failures = result?.failures ?? [];
  const expandable = sources.length > 0 || failures.length > 0;
  const summary = summaryOf(call, result, status, running);
  const error = result?.error ?? null;

  const label = (
    <>
      <Icon size={12} aria-hidden className="flex-none self-center text-subtle" />
      <span className="min-w-0 [overflow-wrap:anywhere]">
        {running ? verb[0] : verb[1]} <span className="text-text">{object}</span>
        {running && <span className="text-subtle">…</span>}
      </span>
      {summary && <span className="flex-none text-subtle">· {summary}</span>}
    </>
  );

  return (
    <div className="text-sm text-muted" aria-busy={running}>
      {expandable ? (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((value) => !value)}
          className="group inline-flex max-w-full items-baseline gap-2 text-left transition-colors hover:text-text"
        >
          {label}
          <ChevronRight
            size={12}
            aria-hidden
            className={`flex-none self-center text-subtle transition-transform group-hover:text-text ${open ? 'rotate-90' : ''}`}
          />
        </button>
      ) : (
        <p className="inline-flex max-w-full items-baseline gap-2">{label}</p>
      )}

      {error && (
        <p className="mt-1 ml-5 flex flex-wrap gap-x-3">
          <span className="text-danger">{lower(error.message)}</span>
          {error.code === 'tool_invalid_credential' && (
            <button type="button" className="text-accent hover:underline" onClick={onOpenSettings}>
              configurações
            </button>
          )}
        </p>
      )}

      {expandable && open && (
        <ul id={listId} className="mt-2 ml-1.5 space-y-1.5 border-l border-line pl-4">
          {sources.map(({ title, url }) => (
            <li key={url} className="min-w-0">
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="group/link flex min-w-0 items-baseline gap-2 hover:text-accent"
              >
                <span className="flex-none text-subtle group-hover/link:text-accent">
                  {domainOf(url)}
                </span>
                <span className="truncate">{title}</span>
              </a>
            </li>
          ))}
          {failures.map(({ url, code }) => (
            <li key={url} className="flex min-w-0 items-baseline gap-2">
              <span className="truncate text-subtle">{domainOf(url)}</span>
              <span className="flex-none">{FAILURES[code]}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});
