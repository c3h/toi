import { Ellipsis, Pencil, Trash2 } from 'lucide-react';
import { useRef, useState, type KeyboardEvent } from 'react';
import { MAX_TITLE_LENGTH, type Conversation } from '../domain/conversation';
import type { ConversationId } from '../domain/ids';
import { ageGroup } from './support';

interface SidebarProps {
  conversations: Conversation[];
  selected: ConversationId | null;
  running: ConversationId | null;
  settingsOpen: boolean;
  open: boolean;
  now: number;
  onNew: () => void;
  onSelect: (id: ConversationId) => void;
  onRename: (id: ConversationId, title: string) => void;
  onDelete: (id: ConversationId) => void;
  onSettings: () => void;
}

interface ItemProps {
  conversation: Conversation;
  active: boolean;
  running: boolean;
  onSelect: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
}

const MENU_ITEM =
  'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left outline-none transition-colors';

const Item = ({ conversation, active, running, onSelect, onRename, onDelete }: ItemProps) => {
  const [mode, setMode] = useState<'view' | 'rename' | 'delete'>('view');
  const [menuOpen, setMenuOpen] = useState(false);
  const cancelled = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const title = conversation.title.toLowerCase();

  // Popover fica na camada do topo: não é cortado pela rolagem da lista e fecha sozinho ao clicar fora.
  const openMenu = () => {
    const button = trigger.current;
    const popup = menu.current;
    if (!button || !popup) return;

    popup.showPopover();
    const anchor = button.getBoundingClientRect();
    const below = anchor.bottom + 4;
    const fits = below + popup.offsetHeight <= innerHeight - 8;
    popup.style.top = `${fits ? below : anchor.top - 4 - popup.offsetHeight}px`;
    popup.style.left = `${anchor.right - popup.offsetWidth}px`;
    popup.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  };

  const closeMenu = (restoreFocus: boolean) => {
    menu.current?.hidePopover();
    if (restoreFocus) trigger.current?.focus();
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
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
      closeMenu(true);
    } else if (target !== undefined) {
      event.preventDefault();
      items[target]?.focus();
    }
  };

  if (mode === 'rename') {
    return (
      <li>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const title = new FormData(event.currentTarget).get('title');
            if (!cancelled.current && typeof title === 'string') onRename(title);
            setMode('view');
          }}
        >
          <label className="sr-only" htmlFor={`rename-${conversation.id}`}>
            novo título
          </label>
          <input
            id={`rename-${conversation.id}`}
            name="title"
            defaultValue={conversation.title}
            maxLength={MAX_TITLE_LENGTH}
            autoFocus
            onFocus={(event) => event.currentTarget.select()}
            onBlur={(event) => event.currentTarget.form?.requestSubmit()}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                cancelled.current = true;
                setMode('view');
              }
            }}
            className="w-full rounded-sm border border-accent bg-panel px-2 py-1.5 text-sm text-text outline-none"
          />
        </form>
      </li>
    );
  }

  return (
    <li className="group relative">
      <button
        type="button"
        aria-current={active ? 'page' : undefined}
        onClick={onSelect}
        className={`flex w-full items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-left text-sm transition-colors group-hover:bg-panel ${
          active ? 'bg-panel text-accent' : 'text-muted group-hover:text-text'
        } ${menuOpen ? 'bg-panel' : ''}`}
      >
        {running && (
          <span
            className="size-1.5 flex-none animate-pulse rounded-full bg-accent"
            aria-label="respondendo"
          />
        )}
        <span className="min-w-0 truncate">{title}</span>
      </button>

      <button
        ref={trigger}
        type="button"
        aria-label={`ações de ${title}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-controls={`menu-${conversation.id}`}
        onClick={() => (menuOpen ? closeMenu(false) : openMenu())}
        className="absolute top-0.5 right-1 grid size-6 place-items-center rounded-sm text-subtle opacity-0 transition-[opacity,color] group-hover:opacity-100 hover:bg-line hover:text-text focus-visible:opacity-100 focus-visible:outline-offset-0 aria-expanded:bg-line aria-expanded:text-text aria-expanded:opacity-100 [@media(hover:none)]:opacity-100"
      >
        <Ellipsis size={14} aria-hidden />
      </button>

      <div
        ref={menu}
        id={`menu-${conversation.id}`}
        popover="auto"
        role="menu"
        aria-label={`ações de ${title}`}
        onToggle={(event) => setMenuOpen(event.newState === 'open')}
        onKeyDown={onMenuKeyDown}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) closeMenu(false);
        }}
        className="m-0 min-w-36 rounded-md border border-line bg-panel p-1 text-sm text-muted shadow-lg shadow-black/30"
      >
        <button
          type="button"
          role="menuitem"
          className={`${MENU_ITEM} hover:bg-line hover:text-text focus:bg-line focus:text-text`}
          onClick={() => {
            closeMenu(false);
            cancelled.current = false;
            setMode('rename');
          }}
        >
          <Pencil size={13} aria-hidden />
          renomear
        </button>
        <button
          type="button"
          role="menuitem"
          className={`${MENU_ITEM} text-danger hover:bg-danger/10 focus:bg-danger/10`}
          onClick={() => {
            closeMenu(false);
            setMode('delete');
          }}
        >
          <Trash2 size={13} aria-hidden />
          apagar
        </button>
      </div>

      {mode === 'delete' && (
        <div
          className="flex items-center gap-3 px-2 pt-1 pb-1.5 text-xs whitespace-nowrap"
          role="group"
        >
          <span className="text-muted">apagar?</span>
          <button
            type="button"
            className="rounded-sm text-danger hover:underline focus-visible:outline-offset-1"
            onClick={onDelete}
            autoFocus
          >
            sim, apagar
          </button>
          <button
            type="button"
            className="rounded-sm text-subtle hover:text-text focus-visible:outline-offset-1"
            onClick={() => {
              setMode('view');
              trigger.current?.focus();
            }}
          >
            não
          </button>
        </div>
      )}
    </li>
  );
};

const groupBy = (conversations: Conversation[], now: number): Array<[string, Conversation[]]> => {
  const groups = new Map<string, Conversation[]>();
  for (const conversation of conversations) {
    const label = ageGroup(conversation.updatedAt, now);
    const group = groups.get(label);
    if (group) group.push(conversation);
    else groups.set(label, [conversation]);
  }
  return [...groups];
};

const NavButton = ({
  shortcut,
  label,
  active,
  onClick,
}: {
  shortcut: string;
  label: string;
  active?: boolean;
  onClick: () => void;
}) => (
  <button
    type="button"
    onClick={onClick}
    aria-keyshortcuts={shortcut}
    className={`group text-sm transition-colors ${active ? 'text-accent' : 'text-muted hover:text-accent'}`}
  >
    <span className="hidden text-subtle transition-colors group-hover:text-text md:inline">
      [{shortcut}]
    </span>{' '}
    {label}
  </button>
);

export const Sidebar = ({
  conversations,
  selected,
  running,
  settingsOpen,
  open,
  now,
  onNew,
  onSelect,
  onRename,
  onDelete,
  onSettings,
}: SidebarProps) => (
  <nav
    aria-label="conversas"
    className={`flex min-h-0 flex-col border-r border-line bg-bg max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-20 max-md:w-[min(86vw,20rem)] max-md:transition-transform max-md:duration-150 ${
      open ? 'max-md:translate-x-0' : 'max-md:-translate-x-full'
    }`}
  >
    <div className="flex items-baseline justify-between gap-3 px-5 pt-6 pb-5">
      <span className="text-2xl leading-none font-bold tracking-tight text-text">
        toi
      </span>
      <NavButton
        shortcut="n"
        label="nova conversa"
        active={selected === null && !settingsOpen}
        onClick={onNew}
      />
    </div>

    <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
      {conversations.length === 0 ? (
        <p className="px-2 text-sm text-subtle">suas conversas aparecem aqui.</p>
      ) : (
        groupBy(conversations, now).map(([label, items]) => (
          <section key={label} className="mb-5">
            <h2 className="px-2 pb-1.5 text-xs text-subtle">{label}</h2>
            <ul>
              {items.map((conversation) => (
                <Item
                  key={conversation.id}
                  conversation={conversation}
                  active={conversation.id === selected && !settingsOpen}
                  running={conversation.id === running}
                  onSelect={() => onSelect(conversation.id)}
                  onRename={(title) => onRename(conversation.id, title)}
                  onDelete={() => onDelete(conversation.id)}
                />
              ))}
            </ul>
          </section>
        ))
      )}
    </div>

    <div className="border-t border-line px-5 py-4">
      <NavButton shortcut="c" label="configurações" active={settingsOpen} onClick={onSettings} />
    </div>
  </nav>
);
