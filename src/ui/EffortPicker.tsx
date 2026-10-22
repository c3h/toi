import { ChevronDown, Gauge } from 'lucide-react';
import { memo, useId } from 'react';
import { EFFORTS, type Effort } from '../domain/model';
import { MENU_PANEL, PICKER_TRIGGER, useMenu } from './menu';
import { PickerItem } from './PickerItem';

const LABELS: Record<Effort, string> = {
  low: 'baixo',
  medium: 'médio',
  high: 'alto',
  xhigh: 'muito alto',
  max: 'máximo',
};

export const effortLabel = (effort: Effort): string => LABELS[effort];

interface EffortPickerProps {
  effort: Effort;
  disabled: boolean;
  onChange: (effort: Effort) => void;
}

// Memo pelo mesmo motivo do seletor de Modelo: o Chat re-renderiza a cada frame do Fluxo.
export const EffortPicker = memo(({ effort, disabled, onChange }: EffortPickerProps) => {
  const { open, trigger, close, toggle, panel } = useMenu({ align: 'start', prefer: 'above' });
  const id = useId();
  const name = effortLabel(effort);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-label={`esforço: ${name}`}
        title="esforço"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        disabled={disabled}
        onClick={toggle}
        className={PICKER_TRIGGER}
      >
        <Gauge size={12} aria-hidden className="flex-none" />
        <span className="truncate">{name}</span>
        <ChevronDown
          size={12}
          aria-hidden
          className="flex-none transition-transform group-aria-expanded:rotate-180"
        />
      </button>

      <div {...panel} id={id} aria-label="esforço" className={`${MENU_PANEL} w-40`}>
        {EFFORTS.map((option) => (
          <PickerItem
            key={option}
            label={effortLabel(option)}
            checked={option === effort}
            close={close}
            onPick={() => onChange(option)}
          />
        ))}
      </div>
    </>
  );
});
