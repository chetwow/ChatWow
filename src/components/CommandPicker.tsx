import { useEffect, useRef } from "react";
import { problemLabel, usage, type ChatCommand, type CommandMatch } from "../lib/commands";
import type { AuthStatus } from "../types";

function Row({
  match,
  auth,
  account,
  selected,
  onHover,
  onPick,
}: {
  match: CommandMatch;
  auth: AuthStatus;
  /** Whose token decides whether this row is locked -- the tab's account. */
  account: string;
  selected: boolean;
  onHover: () => void;
  onPick: () => void;
}) {
  const row = useRef<HTMLButtonElement>(null);

  // Keep the keyboard selection visible as it moves past either edge.
  useEffect(() => {
    if (selected) row.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const locked = problemLabel(match.command, auth, account);

  return (
    <button
      ref={row}
      type="button"
      // Mouse-down would take focus off the composer before the click lands,
      // which closes the picker out from under the pick.
      onMouseDown={(event) => event.preventDefault()}
      onMouseMove={onHover}
      onClick={onPick}
      className={[
        "block w-full px-2 py-1 text-left transition-colors",
        selected ? "bg-accent/25" : "hover:bg-surface-hover",
      ].join(" ")}
    >
      <span className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
          <span className="font-semibold">/{match.name}</span>
          {match.command.args && (
            <span className="text-ink-faint"> {match.command.args}</span>
          )}
        </span>
        {/* Locked rows stay listed rather than being hidden: not knowing a
            command exists is worse than knowing it needs a permission. */}
        {locked && <span className="shrink-0 text-[10px] text-amber-400/80">{locked}</span>}
        {!locked && match.command.broadcasterOnly && (
          <span className="shrink-0 text-[10px] text-ink-faint">your channel</span>
        )}
      </span>
      <span className="block truncate text-[11px] text-ink-faint">{match.command.summary}</span>
    </button>
  );
}

/**
 * The `/` command list, floating above the composer. Purely presentational, the
 * same as the emote picker: the composer owns the query, the selection and
 * every key that drives them.
 */
export function CommandPicker({
  matches,
  auth,
  account,
  selected,
  onSelect,
  onPick,
}: {
  matches: CommandMatch[];
  auth: AuthStatus;
  account: string;
  selected: number;
  onSelect: (index: number) => void;
  onPick: (match: CommandMatch) => void;
}) {
  return (
    <div className="absolute bottom-full left-2 right-2 z-50 mb-1 w-[360px] max-w-[calc(100%-1rem)] overflow-hidden rounded-lg border border-line bg-surface-raised shadow-xl shadow-black/50">
      <div className="scroller max-h-[248px] overflow-y-auto py-1">
        {matches.map((match, index) => (
          <Row
            key={match.name}
            match={match}
            auth={auth}
            account={account}
            selected={index === selected}
            onHover={() => onSelect(index)}
            onPick={() => onPick(match)}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * The arguments of the command you're already past typing, so the shape of a
 * command you half-remember is still in front of you while you fill it in.
 */
export function CommandHint({ command, name }: { command: ChatCommand; name: string }) {
  return (
    <div className="flex items-baseline gap-2 border-b border-line px-3 py-1 text-[11px]">
      <span className="shrink-0 font-mono text-ink-dim">{usage(command, name)}</span>
      <span className="min-w-0 flex-1 truncate text-ink-faint">{command.summary}</span>
    </div>
  );
}
