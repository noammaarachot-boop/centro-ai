import { clsx } from "clsx";
import type { InputHTMLAttributes, TextareaHTMLAttributes } from "react";

const FIELD_CLASS =
  "w-full rounded-xl border border-border bg-white px-4 py-3 text-sm text-text-primary outline-none transition-all duration-200 focus:border-brand-purple focus:ring-4 focus:ring-brand-purple/10";

function FieldLabel({
  htmlFor,
  label,
  optional,
}: {
  htmlFor: string;
  label: string;
  optional?: boolean;
}) {
  return (
    <label
      htmlFor={htmlFor}
      className="mb-1.5 block text-sm font-medium text-text-secondary"
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

export function TextField({
  label,
  optional,
  error,
  className,
  id,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  optional?: boolean;
  error?: string;
  id: string;
}) {
  return (
    <div>
      <FieldLabel htmlFor={id} label={label} optional={optional} />
      <input
        id={id}
        className={clsx(FIELD_CLASS, className)}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : undefined}
        {...props}
      />
      <FieldError id={id} error={error} />
    </div>
  );
}

export function TextAreaField({
  label,
  optional,
  error,
  className,
  id,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label: string;
  optional?: boolean;
  error?: string;
  id: string;
}) {
  return (
    <div>
      <FieldLabel htmlFor={id} label={label} optional={optional} />
      <textarea
        id={id}
        className={clsx(FIELD_CLASS, className)}
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
  className,
  id,
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement> & {
  label: string;
  optional?: boolean;
  error?: string;
  id: string;
}) {
  return (
    <div>
      <FieldLabel htmlFor={id} label={label} optional={optional} />
      <select
        id={id}
        className={clsx(FIELD_CLASS, "cursor-pointer", className)}
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
