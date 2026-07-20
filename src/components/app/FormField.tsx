import { clsx } from "clsx";
import type { InputHTMLAttributes, TextareaHTMLAttributes } from "react";

export type FieldSize = "sm" | "md";

// Exported so components with their own bespoke label/layout (CollectionDayField,
// ServiceScheduleOverrideCard) can still render inputs with the exact same visual
// treatment as TextField/SelectField below, instead of hand-rolling a slightly
// different border/radius/focus style per component.
export function fieldClass(fieldSize: FieldSize = "md", className?: string) {
  return clsx(
    "w-full rounded-xl border border-border bg-white text-text-primary outline-none transition-all duration-200 ease-[var(--ease-standard)] focus:border-brand-purple focus:ring-4 focus:ring-brand-purple/10",
    fieldSize === "sm" ? "px-3 py-2 text-xs" : "px-4 py-3 text-sm",
    className
  );
}

function FieldLabel({
  htmlFor,
  label,
  optional,
  fieldSize = "md",
}: {
  htmlFor: string;
  label: string;
  optional?: boolean;
  fieldSize?: FieldSize;
}) {
  return (
    <label
      htmlFor={htmlFor}
      className={clsx(
        "mb-1.5 block font-medium text-text-secondary",
        fieldSize === "sm" ? "text-xs" : "text-sm"
      )}
    >
      {label}{" "}
      {optional && (
        <span className="font-normal text-text-muted">(לא חובה)</span>
      )}
    </label>
  );
}

function FieldError({ id, error }: { id: string; error?: string }) {
  if (!error) return null;
  return (
    <p
      id={`${id}-error`}
      role="alert"
      className="mt-1.5 animate-fade-in-up text-xs font-medium text-danger"
    >
      {error}
    </p>
  );
}

// Note: the field-size variant is named `fieldSize`, not `size` — <input>
// already has a native `size` HTML attribute (a number, the visible
// character width), and this component's props extend
// InputHTMLAttributes, so reusing `size` for the sm/md variant would
// collide with — and get typed away by — the native one.
export function TextField({
  label,
  optional,
  error,
  fieldSize = "md",
  className,
  id,
  endAdornment,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  optional?: boolean;
  error?: string;
  fieldSize?: FieldSize;
  id: string;
  /** e.g. a password show/hide toggle button, rendered at the field's
   * logical start edge (so it sits correctly for an LTR-typed input —
   * email/password/phone — inside this app's RTL page direction). */
  endAdornment?: React.ReactNode;
}) {
  return (
    <div>
      <FieldLabel htmlFor={id} label={label} optional={optional} fieldSize={fieldSize} />
      <div className="relative">
        <input
          id={id}
          className={fieldClass(fieldSize, clsx(endAdornment && "ps-11", className))}
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-error` : undefined}
          {...props}
        />
        {endAdornment && (
          <span className="absolute inset-y-0 start-0 flex items-center px-3">
            {endAdornment}
          </span>
        )}
      </div>
      <FieldError id={id} error={error} />
    </div>
  );
}

export function TextAreaField({
  label,
  optional,
  error,
  fieldSize = "md",
  className,
  id,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label: string;
  optional?: boolean;
  error?: string;
  fieldSize?: FieldSize;
  id: string;
}) {
  return (
    <div>
      <FieldLabel htmlFor={id} label={label} optional={optional} fieldSize={fieldSize} />
      <textarea
        id={id}
        className={fieldClass(fieldSize, className)}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : undefined}
        {...props}
      />
      <FieldError id={id} error={error} />
    </div>
  );
}

export function SelectField({
  label,
  optional,
  error,
  fieldSize = "md",
  className,
  id,
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement> & {
  label: string;
  optional?: boolean;
  error?: string;
  fieldSize?: FieldSize;
  id: string;
}) {
  return (
    <div>
      <FieldLabel htmlFor={id} label={label} optional={optional} fieldSize={fieldSize} />
      <select
        id={id}
        className={fieldClass(fieldSize, clsx("cursor-pointer", className))}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : undefined}
        {...props}
      >
        {children}
      </select>
      <FieldError id={id} error={error} />
    </div>
  );
}
