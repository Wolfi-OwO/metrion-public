import { useEffect, useState } from 'react';
import { copyText } from '../lib/clipboard.ts';

/**
 * Used both for the landing page's quickstart snippet and the one-time API
 * key reveal - two different pieces of text, one control. `aria-live` on the
 * label itself (rather than the whole button) is what makes "Copied" get
 * announced without the button's own accessible name flickering mid-click.
 */
export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      onClick={() => void copyText(text).then(setCopied)}
      className="rounded-sm border border-line-strong px-2.5 py-1 text-[12px] text-ink-dim transition-colors duration-150 hover:border-series-1 hover:text-series-1"
    >
      <span aria-live="polite">{copied ? 'Copied' : label}</span>
    </button>
  );
}
