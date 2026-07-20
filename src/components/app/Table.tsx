import { Card } from "@/components/app/Card";

// The one shared table shell for the app — sticky header, hover rows, a
// horizontal-scroll wrapper for narrow viewports. Replaces the same
// <table className="w-full min-w-[...px] text-end text-sm"> markup that
// was hand-copied (with a drifting min-width) across clients, dashboard,
// OneTimeDashboard, and collections. Callers still own <thead>/<tbody>
// content — this only standardizes the outer shell and cell/row classes
// via the exported helpers below.
export function Table({
  minWidth = 480,
  children,
}: {
  minWidth?: number;
  children: React.ReactNode;
}) {
  return (
    <Card padding="none" className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-end text-sm" style={{ minWidth }}>
          {children}
        </table>
      </div>
    </Card>
  );
}

export function TableHead({ children }: { children: React.ReactNode }) {
  return (
    <thead className="sticky top-0 bg-surface-muted text-text-muted">
      <tr>{children}</tr>
    </thead>
  );
}

export function TableHeadCell({ children }: { children: React.ReactNode }) {
  return <th className="px-5 py-3.5 font-medium">{children}</th>;
}

export function TableRow({
  children,
  ...props
}: React.HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className="border-t border-border transition-colors ease-[var(--ease-standard)] hover:bg-surface-muted/60"
      {...props}
    >
      {children}
    </tr>
  );
}

export function TableCell({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <td className={className ? `px-5 py-4 ${className}` : "px-5 py-4"}>{children}</td>;
}
