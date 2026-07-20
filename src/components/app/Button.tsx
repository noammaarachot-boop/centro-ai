import { clsx } from "clsx";
import { Loader2 } from "lucide-react";
import type { ButtonHTMLAttributes } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg" | "icon";

const BASE =
  "inline-flex items-center justify-center gap-2 font-semibold transition-all duration-200 ease-[var(--ease-standard)] focus-visible:outline-2 focus-visible:outline-offset-2 disabled:pointer-events-none disabled:opacity-60";

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "rounded-full bg-gradient-to-l from-brand-purple to-brand-blue text-white shadow-card-lg hover:scale-[1.02] hover:shadow-[var(--shadow-glow-purple)] active:scale-[0.98]",
  secondary:
    "rounded-full border border-border bg-surface text-text-secondary hover:border-brand-purple/40 hover:text-brand-purple hover:bg-brand-purple/5 active:scale-[0.98]",
  ghost:
    "rounded-full text-text-secondary hover:bg-surface-muted hover:text-text-primary active:scale-[0.98]",
  danger:
    "rounded-full border border-danger/25 bg-danger/5 text-danger hover:border-danger/50 hover:bg-danger/10 active:scale-[0.98]",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "px-3.5 py-2 text-xs",
  md: "px-5 py-2.5 text-sm",
  lg: "px-6 py-3.5 text-base",
  icon: "h-9 w-9 p-0",
};

export function buttonVariants({
  variant = "secondary",
  size = "md",
  className,
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
} = {}) {
  return clsx(BASE, VARIANTS[variant], SIZES[size], className);
}

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  className,
  children,
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}) {
  return (
    <button
      className={buttonVariants({ variant, size, className })}
      disabled={disabled || loading}
      {...props}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" />}
      {children}
    </button>
  );
}
