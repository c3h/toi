import { Check } from 'lucide-react';
import { MENU_ITEM } from './menu';

interface PickerItemProps {
  label: string;
  checked: boolean;
  /** O `close` do `useMenu` que abriu o seletor. */
  close: (restoreFocus: boolean) => void;
  onPick: () => void;
}

/** Opção marcável de um seletor do composer: fecha o menu e só avisa quando muda a escolha. */
export const PickerItem = ({ label, checked, close, onPick }: PickerItemProps) => (
  <button
    type="button"
    role="menuitemradio"
    aria-checked={checked}
    onClick={() => {
      close(true);
      if (!checked) onPick();
    }}
    className={`${MENU_ITEM} justify-between hover:bg-line focus:bg-line ${
      checked ? 'text-accent' : 'hover:text-text focus:text-text'
    }`}
  >
    <span className="min-w-0 truncate">{label}</span>
    {checked && <Check size={13} aria-hidden className="flex-none" />}
  </button>
);
