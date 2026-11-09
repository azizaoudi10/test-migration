/** Tiny event bus for inserting a prompt into the reviewer composer from
 *  surfaces that do not share React state (palette command, settings use
 *  button). The active ReviewerTab listens and appends. */
const EVENT = 'fraktole:insert-prompt';

export function insertPrompt(text: string): void {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { text } }));
}

export function onInsertPrompt(cb: (text: string) => void): () => void {
  const handler = (e: Event): void => {
    const detail = (e as CustomEvent<{ text?: string }>).detail;
    if (typeof detail?.text === 'string') cb(detail.text);
  };
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
