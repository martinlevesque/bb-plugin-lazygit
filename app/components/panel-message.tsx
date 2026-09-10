// app/components/panel-message.tsx — the centered panel placeholder shown
// over the terminal while lazygit cannot run (not a repo, exited, error).
export function PanelMessage({
  title,
  detail,
  actionLabel,
  onAction,
  disabled,
}: {
  title: string;
  detail: string | null;
  actionLabel: string;
  onAction: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-background p-6 text-center">
      <p className="text-sm font-medium text-foreground">{title}</p>
      {detail === null ? null : (
        <p className="max-w-md text-xs text-muted-foreground">{detail}</p>
      )}
      <button
        type="button"
        onClick={onAction}
        disabled={disabled}
        className="rounded-md border border-border bg-card px-3 py-1.5 text-sm text-foreground hover:bg-accent disabled:opacity-50"
      >
        {actionLabel}
      </button>
    </div>
  );
}