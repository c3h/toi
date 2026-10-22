import { useCallback, useRef, useState } from 'react';
import { exceededLimit, type AttachmentUpload, type MessageLimit } from '../../domain/attachment';
import { newId, type AttachmentId } from '../../domain/ids';
import type { PrepareProblem } from './prepare';

/** Por que um arquivo ficou fora; `not_loaded` é o chunk do preparo que não baixou. */
export type DraftProblem = PrepareProblem | MessageLimit | 'not_loaded';

/** Um Anexo no composer: preparando, pronto para enviar ou recusado, com o motivo. */
export type DraftAttachment =
  | { id: AttachmentId; name: string; status: 'preparing' }
  | { id: AttachmentId; name: string; status: 'ready'; upload: AttachmentUpload }
  | { id: AttachmentId; name: string; status: 'error'; problem: DraftProblem };

type Prepared = { upload: AttachmentUpload } | { problem: Exclude<DraftProblem, MessageLimit> };

/** O preparo (canvas, contagem de páginas) só baixa no primeiro Anexo. */
const prepare = async (file: File, id: AttachmentId): Promise<Prepared> => {
  // A aba é anterior ao último deploy, ou a rede caiu: recarregar resolve os dois.
  const loaded = await import('./prepare').catch(() => null);
  if (loaded === null) return { problem: 'not_loaded' };
  try {
    return { upload: await loaded.prepareAttachment(file, id) };
  } catch (error) {
    if (error instanceof loaded.PrepareError) return { problem: error.problem };
    // API do navegador que falhou: o arquivo só não entra.
    return { problem: 'unreadable' };
  }
};

const uploadsOf = (items: DraftAttachment[]): AttachmentUpload[] =>
  items.flatMap((item) => (item.status === 'ready' ? [item.upload] : []));

/** Pronto só se ainda cabe na Mensagem com os que já estão prontos. */
const settle = (
  items: DraftAttachment[],
  id: AttachmentId,
  prepared: Prepared,
): DraftAttachment[] =>
  items.map((item): DraftAttachment => {
    if (item.id !== id) return item;
    if ('problem' in prepared) {
      return { id, name: item.name, status: 'error', problem: prepared.problem };
    }

    const { attachment } = prepared.upload;
    const ready = uploadsOf(items).map((upload) => upload.attachment);
    const limit = exceededLimit([...ready, attachment]);
    return limit
      ? { id, name: item.name, status: 'error', problem: limit }
      : { id, name: attachment.name, status: 'ready', upload: prepared.upload };
  });

/**
 * Os Anexos do rascunho. Um arquivo prepara por vez, na ordem em que entrou,
 * para dois arquivos grandes não decodificarem juntos; o que sai do rascunho
 * antes ou durante o preparo tem o resultado descartado.
 */
export const useDraftAttachments = () => {
  const [items, setItems] = useState<DraftAttachment[]>([]);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const kept = useRef(new Set<AttachmentId>());

  const add = useCallback((files: File[]) => {
    const added = files.map((file) => ({
      file,
      item: { id: newId(), name: file.name, status: 'preparing' } as const,
    }));
    for (const { item } of added) kept.current.add(item.id);
    setItems((current) => [...current, ...added.map(({ item }) => item)]);

    for (const { file, item } of added) {
      queue.current = queue.current.then(async () => {
        if (!kept.current.has(item.id)) return;
        const prepared = await prepare(file, item.id);
        if (kept.current.has(item.id)) setItems((current) => settle(current, item.id, prepared));
      });
    }
  }, []);

  const remove = useCallback((id: AttachmentId) => {
    kept.current.delete(id);
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  /**
   * Tira tudo do rascunho para enviar, só quando nada está `blocked`;
   * `restore` devolve se o envio não foi aceito.
   */
  const take = useCallback((): AttachmentUpload[] => {
    setItems([]);
    return uploadsOf(items);
  }, [items]);

  const restore = useCallback((uploads: AttachmentUpload[]) => {
    const restored = uploads.map(
      (upload): DraftAttachment => ({
        id: upload.attachment.id,
        name: upload.attachment.name,
        status: 'ready',
        upload,
      }),
    );
    setItems((current) => [...restored, ...current]);
  }, []);

  return {
    items,
    /** Enviar espera todo Anexo pronto: um em preparo ou recusado não some calado. */
    blocked: items.some((item) => item.status !== 'ready'),
    add,
    remove,
    take,
    restore,
  };
};
