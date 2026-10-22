import { Check, ChevronDown, SlidersHorizontal } from 'lucide-react';
import { memo, useId } from 'react';
import { findModel, isModel, type Model } from '../domain/model';
import { MENU_ITEM, MENU_PANEL, useMenu } from './menu';

interface ModelPickerProps {
  /** Os Modelos marcados em Configurações. */
  options: Model[];
  model: Model;
  disabled: boolean;
  onChange: (model: Model) => void;
  onManage: () => void;
}

// Memo: o Chat re-renderiza a cada frame do Fluxo e a cada tecla; o seletor não muda com eles.
export const ModelPicker = memo(
  ({ options, model, disabled, onChange, onManage }: ModelPickerProps) => {
    const { open, trigger, close, toggle, panel } = useMenu({
      align: 'start',
      prefer: 'above',
    });
    const id = useId();
    const name = model.displayName.toLowerCase();
    // A Conversa pode usar um Modelo desmarcado depois; ele continua escolhido e visível.
    const choices = findModel(options, model) ? options : [...options, model];

    return (
      <>
        <button
          ref={trigger}
          type="button"
          aria-label={`modelo: ${name}`}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={id}
          disabled={disabled}
          onClick={toggle}
          className="group inline-flex min-w-0 items-center gap-1.5 px-1.5 py-1 text-xs text-subtle transition-colors hover:bg-line/60 hover:text-text focus-visible:outline-offset-0 disabled:pointer-events-none disabled:opacity-60 aria-expanded:bg-line/60 aria-expanded:text-text"
        >
          <span className="max-w-[14rem] truncate">{name}</span>
          <ChevronDown
            size={12}
            aria-hidden
            className="flex-none transition-transform group-aria-expanded:rotate-180"
          />
        </button>

        <div {...panel} id={id} aria-label="modelo" className={`${MENU_PANEL} w-60`}>
          {choices.map((option) => {
            const checked = isModel(option, model);
            return (
              <button
                key={`${option.provider}:${option.id}`}
                type="button"
                role="menuitemradio"
                aria-checked={checked}
                onClick={() => {
                  close(true);
                  if (!checked) onChange(option);
                }}
                className={`${MENU_ITEM} justify-between hover:bg-line focus:bg-line ${
                  checked ? 'text-accent' : 'hover:text-text focus:text-text'
                }`}
              >
                <span className="min-w-0 truncate">{option.displayName.toLowerCase()}</span>
                {checked && <Check size={13} aria-hidden className="flex-none" />}
              </button>
            );
          })}
          <div role="separator" className="-mx-1 my-1 border-t border-line" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              close(false);
              onManage();
            }}
            className={`${MENU_ITEM} text-subtle hover:bg-line hover:text-text focus:bg-line focus:text-text`}
          >
            <SlidersHorizontal size={13} aria-hidden />
            escolher modelos
          </button>
        </div>
      </>
    );
  },
);
