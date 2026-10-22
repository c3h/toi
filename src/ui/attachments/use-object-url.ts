import { useEffect, useState } from 'react';

/** Um `blob:` para o `<img>`, revogado quando o Blob muda ou o componente sai. */
export const useObjectUrl = (blob: Blob | null): string | null => {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!blob) return;
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => {
      URL.revokeObjectURL(next);
      setUrl(null);
    };
  }, [blob]);

  return url;
};
