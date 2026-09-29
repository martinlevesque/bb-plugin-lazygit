// app/components/panel-message.tsx — the centered panel placeholder shown
// over the terminal while lazygit cannot run (not a repo, exited, error).
import { Button } from "../../components/ui/button";

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
    <div className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-sidebar p-6 text-center">
      <p className="text-sm font-medium text-foreground">{title}</p>
      {detail === null ? null : (
        <p className="max-w-md text-xs text-muted-foreground">{detail}</p>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onAction}
        disabled={disabled}
      >
        {actionLabel}
      </Button>
    </div>
  );
}