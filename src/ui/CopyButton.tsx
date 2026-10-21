import { Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';

export const CopyButton = ({ text, className }: { text: string; className: string }) => {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      className={className}
      data-copied={copied}
      onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true))}
    >
      {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
      {copied ? 'copiado' : 'copiar'}
    </button>
  );
};
