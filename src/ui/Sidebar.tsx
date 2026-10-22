import { Ellipsis, Pencil, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { MAX_TITLE_LENGTH, type Conversation } from '../domain/conversation';
import type { ConversationId } from '../domain/ids';
import { MENU_ITEM, MENU_PANEL, useMenu } from './menu';
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

const Item = ({ conversation, active, running, onSelect, onRename, onDelete }: ItemProps) => {
  const [mode, setMode] = useState<'view' | 'rename' | 'delete'>('view');
  const cancelled = useRef(false);
  const menu = useMenu({ align: 'end', prefer: 'below' });
  const title = conversation.title.toLowerCase();

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
        title={title}
        onClick={onSelect}
        className={`flex w-full items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-left text-sm transition-colors group-hover:bg-panel ${
          active ? 'bg-panel text-accent' : 'text-muted group-hover:text-text'
        } ${menu.open ? 'bg-panel' : ''}`}
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
        ref={menu.trigger}
        type="button"
        aria-label={`ações de ${title}`}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        aria-controls={`menu-${conversation.id}`}
        onClick={menu.toggle}
        className="absolute top-0.5 right-1 grid size-6 place-items-center rounded-sm text-subtle opacity-0 transition-[opacity,color] group-hover:opacity-100 hover:bg-line hover:text-text focus-visible:opacity-100 focus-visible:outline-offset-0 aria-expanded:bg-line aria-expanded:text-text aria-expanded:opacity-100 [@media(hover:none)]:opacity-100"
      >
        <Ellipsis size={14} aria-hidden />
      </button>

      <div
        {...menu.panel}
        id={`menu-${conversation.id}`}
        aria-label={`ações de ${title}`}
        className={`${MENU_PANEL} min-w-36`}
      >
        <button
          type="button"
          role="menuitem"
          className={`${MENU_ITEM} hover:bg-line hover:text-text focus:bg-line focus:text-text`}
          onClick={() => {
            menu.close(false);
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
            menu.close(false);
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
              menu.trigger.current?.focus();
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

    {/* flex tira a linha de 24px herdada; pb maior compensa o vazio acima da tinta da fonte. */}
    <div className="flex border-t border-line px-5 pt-4.5 pb-5">
      <NavButton shortcut="c" label="configurações" active={settingsOpen} onClick={onSettings} />
    </div>
  </nav>
);
