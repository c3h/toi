import { CircleAlert, Download, FileText, LoaderCircle, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { Toi } from '../../app/toi';
import {
  MESSAGE_LIMITS,
  TEXT_LIMIT_BYTES,
  type Attachment,
  type MessageLimit,
} from '../../domain/attachment';
import type { AttachmentId } from '../../domain/ids';
import { download, formatBytes } from '../support';
import type { PrepareProblem } from './prepare';
import type { DraftAttachment } from './use-draft-attachments';
import { useObjectUrl } from './use-object-url';

const PROBLEM_TEXT: Record<PrepareProblem | MessageLimit, string> = {
  empty: 'arquivo vazio',
  unreadable: 'não deu para ler o arquivo',
  unsupported: 'só imagem, pdf ou texto em utf-8',
  heic: 'este navegador não abre heic',
  undecodable: 'este navegador não abre esta imagem',
  too_many_pixels: 'imagem com pixels demais',
  image_too_large: 'imagem grande demais, mesmo reduzida',
  pdf_too_large: `pdf acima de ${formatBytes(MESSAGE_LIMITS.bytes)}`,
  text_too_large: `texto acima de ${formatBytes(TEXT_LIMIT_BYTES)}`,
  files: `passa de ${MESSAGE_LIMITS.files} arquivos por mensagem`,
  bytes: `passa de ${formatBytes(MESSAGE_LIMITS.bytes)} por mensagem`,
  pages: `passa de ${MESSAGE_LIMITS.pages} páginas por mensagem`,
};

const detailOf = (attachment: Attachment): string => {
  const size = formatBytes(attachment.size);
  switch (attachment.kind) {
    case 'image':
      return `${attachment.width}×${attachment.height} · ${size}`;
    case 'pdf':
      return attachment.pages === null ? `pdf · ${size}` : `${attachment.pages} pág · ${size}`;
    case 'text':
      return size;
  }
};

/** A forma comum de um Anexo: miniatura ou ícone, nome, detalhe e uma ação à direita. */
const FileChip = ({
  thumb,
  name,
  detail,
  danger = false,
  action,
}: {
  thumb: ReactNode;
  name: string;
  detail: string;
  danger?: boolean;
  action?: ReactNode;
}) => (
  <span
    className={`flex h-10 max-w-60 items-center gap-2 border bg-bg pl-1 text-left text-xs transition-colors ${
      danger ? 'border-danger/60' : 'border-line group-hover:border-subtle'
    } ${action ? 'pr-1' : 'pr-3'}`}
  >
    <span className="grid size-8 flex-none place-items-center overflow-hidden bg-bg-soft text-muted">
      {thumb}
    </span>
    <span className="min-w-0 flex-1 leading-tight">
      <span className="block truncate text-text">{name}</span>
      <span className={`block truncate ${danger ? 'text-danger' : 'text-subtle'}`}>{detail}</span>
    </span>
    {action}
  </span>
);

const DraftChip = ({
  item,
  onRemove,
}: {
  item: DraftAttachment;
  onRemove: (id: AttachmentId) => void;
}) => {
  const ready = item.status === 'ready' ? item.upload : null;
  const url = useObjectUrl(ready?.attachment.kind === 'image' ? ready.blob : null);

  const thumb =
    item.status === 'preparing' ? (
      <LoaderCircle size={14} className="animate-spin motion-reduce:animate-none" aria-hidden />
    ) : item.status === 'error' ? (
      <CircleAlert size={14} className="text-danger" aria-hidden />
    ) : url ? (
      <img src={url} alt="" className="size-full object-cover" />
    ) : (
      <FileText size={14} aria-hidden />
    );

  const detail =
    item.status === 'preparing'
      ? 'preparando…'
      : item.status === 'error'
        ? PROBLEM_TEXT[item.problem]
        : detailOf(item.upload.attachment);

  return (
    <li>
      <FileChip
        thumb={thumb}
        name={item.name}
        detail={detail}
        danger={item.status === 'error'}
        action={
          <button
            type="button"
            aria-label={`remover ${item.name}`}
            className="grid size-6 flex-none place-items-center text-subtle hover:text-text"
            onClick={() => onRemove(item.id)}
          >
            <X size={12} aria-hidden />
          </button>
        }
      />
    </li>
  );
};

/** Os Anexos do rascunho, acima do campo de texto. */
export const DraftAttachments = ({
  items,
  onRemove,
}: {
  items: DraftAttachment[];
  onRemove: (id: AttachmentId) => void;
}) => (
  <ul aria-label="anexos" aria-live="polite" className="flex flex-wrap gap-2 px-3 pt-3">
    {items.map((item) => (
      <DraftChip key={item.id} item={item} onRemove={onRemove} />
    ))}
  </ul>
);

/** Vira `true` na primeira vez que o elemento chega perto da tela, e fica. */
const useSeen = (ref: RefObject<Element | null>): boolean => {
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element || seen) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setSeen(true);
      },
      { rootMargin: '200px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, seen]);

  return seen;
};

type Stored = { status: 'idle' } | { status: 'ready'; blob: Blob } | { status: 'missing' };

/** Os bytes gravados, lidos só quando `enabled`: uma Conversa longa não abre tudo de uma vez. */
const useStored = (toi: Toi, id: AttachmentId, enabled: boolean): Stored => {
  const [stored, setStored] = useState<Stored>({ status: 'idle' });

  useEffect(() => {
    if (!enabled) return;
    let current = true;
    toi.attachment(id).then(
      (blob) => current && setStored({ status: 'ready', blob }),
      () => current && setStored({ status: 'missing' }),
    );
    return () => {
      current = false;
    };
  }, [toi, id, enabled]);

  return stored;
};

const MISSING = 'não está mais no navegador';

type ImageAttachment = Extract<Attachment, { kind: 'image' }>;

const ImageDialog = ({
  url,
  attachment,
  onClose,
}: {
  url: string;
  attachment: ImageAttachment;
  onClose: () => void;
}) => {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  return (
    <dialog
      ref={dialog}
      aria-label={attachment.name}
      className="m-auto max-h-[92dvh] max-w-[92vw] border border-line bg-panel p-0 text-text backdrop:bg-black/70"
      onClose={onClose}
      // Clique no fundo cai no próprio `dialog`; na imagem ou na barra, não.
      onClick={(event) => {
        if (event.target === event.currentTarget) dialog.current?.close();
      }}
      // O esc fecha o diálogo; sem isso, chegaria ao atalho que para o Fluxo.
      onKeyDown={(event) => event.stopPropagation()}
    >
      <img
        src={url}
        alt={attachment.name}
        className="block max-h-[calc(92dvh-2.5rem)] max-w-[92vw] object-contain"
      />
      <div className="flex h-10 items-center gap-3 px-3 text-xs text-subtle">
        <span className="min-w-0 flex-1 truncate">
          {attachment.name} · {detailOf(attachment)}
        </span>
        <a
          href={url}
          download={attachment.name}
          className="inline-flex items-center gap-1 hover:text-text"
        >
          <Download size={12} aria-hidden />
          baixar
        </a>
        <button
          type="button"
          aria-label="fechar"
          className="grid size-6 place-items-center hover:text-text"
          onClick={() => dialog.current?.close()}
        >
          <X size={14} aria-hidden />
        </button>
      </div>
    </dialog>
  );
};

const StoredImage = ({ toi, attachment }: { toi: Toi; attachment: ImageAttachment }) => {
  const button = useRef<HTMLButtonElement>(null);
  const stored = useStored(toi, attachment.id, useSeen(button));
  const url = useObjectUrl(stored.status === 'ready' ? stored.blob : null);
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={`ver ${attachment.name}`}
        title={stored.status === 'missing' ? `${attachment.name}: ${MISSING}` : attachment.name}
        disabled={!url}
        className={`block h-24 max-w-48 min-w-12 overflow-hidden border bg-bg-soft transition-colors enabled:hover:border-subtle ${
          stored.status === 'missing' ? 'border-danger/60' : 'border-line'
        }`}
        style={{ aspectRatio: `${attachment.width} / ${attachment.height}` }}
        onClick={() => setOpen(true)}
      >
        {url && <img src={url} alt="" className="size-full object-cover" />}
      </button>
      {open && url && (
        <ImageDialog url={url} attachment={attachment} onClose={() => setOpen(false)} />
      )}
    </>
  );
};

const StoredFile = ({ toi, attachment }: { toi: Toi; attachment: Attachment }) => {
  const [missing, setMissing] = useState(false);

  const save = async () => {
    try {
      download(attachment.name, await toi.attachment(attachment.id));
    } catch {
      setMissing(true);
    }
  };

  return (
    <button
      type="button"
      aria-label={`baixar ${attachment.name}`}
      title={`baixar ${attachment.name}`}
      className="group block"
      onClick={() => void save()}
    >
      <FileChip
        thumb={<FileText size={14} aria-hidden />}
        name={attachment.name}
        detail={missing ? MISSING : detailOf(attachment)}
        danger={missing}
      />
    </button>
  );
};

/** Os Anexos de uma Mensagem gravada: imagem abre em tamanho grande, o resto baixa. */
export const MessageAttachments = ({
  toi,
  attachments,
}: {
  toi: Toi;
  attachments: Attachment[];
}) => (
  <ul aria-label="anexos" className="flex flex-wrap gap-2">
    {attachments.map((attachment) => (
      <li key={attachment.id}>
        {attachment.kind === 'image' ? (
          <StoredImage toi={toi} attachment={attachment} />
        ) : (
          <StoredFile toi={toi} attachment={attachment} />
        )}
      </li>
    ))}
  </ul>
);
