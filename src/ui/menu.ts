import { useRef, useState, type FocusEvent, type KeyboardEvent, type ToggleEvent } from 'react';

export const MENU_ITEM =
  'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left outline-none transition-colors';

export const MENU_PANEL =
  'm-0 rounded-md border border-line bg-panel p-1 text-sm text-muted shadow-lg shadow-black/30';

const ITEMS = '[role^="menuitem"]';
const GAP = 4;
const MARGIN = 8;

interface Placement {
  align: 'start' | 'end';
  prefer: 'below' | 'above';
}

/**
 * Abre o popover na camada do topo, colado ao gatilho: não é cortado pela
 * rolagem e fecha sozinho ao clicar fora. Vai para o lado preferido se couber.
 * O foco cai no item marcado, ou no primeiro.
 */
const showMenu = (trigger: HTMLElement, popup: HTMLElement, { align, prefer }: Placement): void => {
  popup.showPopover();
  const anchor = trigger.getBoundingClientRect();
  const below = anchor.bottom + GAP;
  const above = anchor.top - GAP - popup.offsetHeight;
  const fitsBelow = below + popup.offsetHeight <= innerHeight - MARGIN;
  const fitsAbove = above >= MARGIN;
  const top = prefer === 'below' ? (fitsBelow ? below : above) : fitsAbove ? above : below;
  const left = align === 'end' ? anchor.right - popup.offsetWidth : anchor.left;

  popup.style.top = `${top}px`;
  popup.style.left = `${Math.max(MARGIN, left)}px`;
  (
    popup.querySelector<HTMLElement>('[aria-checked="true"]') ??
    popup.querySelector<HTMLElement>(ITEMS)
  )?.focus();
};

/** Setas, Home e End entre os itens; Esc fecha sem chegar aos atalhos globais. */
const onMenuKeyDown = (event: KeyboardEvent<HTMLElement>, close: () => void): void => {
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>(ITEMS)];
  const index = items.indexOf(document.activeElement as HTMLElement);
  const move: Record<string, number> = {
    ArrowDown: (index + 1) % items.length,
    ArrowUp: (index - 1 + items.length) % items.length,
    Home: 0,
    End: items.length - 1,
  };

  const target = move[event.key];
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    close();
  } else if (target !== undefined) {
    event.preventDefault();
    items[target]?.focus();
  }
};

/**
 * Gatilho e painel de um menu: abrir, fechar (devolvendo o foco ao gatilho
 * quando o fechamento vem do teclado ou de um item) e o estado `open`.
 */
export const useMenu = (placement: Placement) => {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  const close = (restoreFocus: boolean) => {
    menu.current?.hidePopover();
    if (restoreFocus) trigger.current?.focus();
  };

  const toggle = () => {
    if (open) close(false);
    else if (trigger.current && menu.current) showMenu(trigger.current, menu.current, placement);
  };

  const panel = {
    ref: menu,
    popover: 'auto',
    role: 'menu',
    onToggle: (event: ToggleEvent<HTMLDivElement>) => setOpen(event.newState === 'open'),
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => onMenuKeyDown(event, () => close(true)),
    onBlur: (event: FocusEvent<HTMLDivElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget)) close(false);
    },
  } as const;

  return { open, trigger, close, toggle, panel };
};
