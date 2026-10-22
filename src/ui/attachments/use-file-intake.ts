import { useEffect, useState, type ClipboardEvent, type DragEvent } from 'react';

const carriesFiles = (event: { dataTransfer: DataTransfer | null }): boolean =>
  event.dataTransfer?.types.includes('Files') === true;

/**
 * Arquivos que chegam arrastados ou colados. `dropProps` vai na área que
 * aceita soltar; `enabled` só decide o destaque, quem recebe `onFiles` filtra.
 */
export const useFileIntake = (enabled: boolean, onFiles: (files: File[]) => void) => {
  const [dragging, setDragging] = useState(false);

  // Arquivo solto fora da área abriria no lugar do app e levaria o rascunho junto.
  useEffect(() => {
    const keep = (event: globalThis.DragEvent) => {
      if (carriesFiles(event)) event.preventDefault();
    };
    addEventListener('dragover', keep);
    addEventListener('drop', keep);
    return () => {
      removeEventListener('dragover', keep);
      removeEventListener('drop', keep);
    };
  }, []);

  return {
    dragging,
    dropProps: {
      onDragEnter: (event: DragEvent) => {
        if (enabled && carriesFiles(event)) setDragging(true);
      },
      onDragOver: (event: DragEvent) => {
        if (enabled && carriesFiles(event)) event.preventDefault();
      },
      onDragLeave: (event: DragEvent) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      },
      onDrop: (event: DragEvent) => {
        event.preventDefault();
        setDragging(false);
        onFiles([...event.dataTransfer.files]);
      },
    },
    onPaste: (event: ClipboardEvent) => {
      const files = [...event.clipboardData.files];
      if (files.length === 0) return;
      event.preventDefault();
      onFiles(files);
    },
  };
};
