import { type ReactNode, useId } from "react";

/**
 * The form primitives every configuration screen is built from. They exist so that a label, its
 * hint and its error are wired to the control in one place rather than in each of the eleven forms
 * that need them, which is the difference between a form somebody can use with a keyboard and one
 * that happens to look right.
 */

type Common = {
  label: string;
  hint?: string;
  wrong?: string | undefined;
};

function useFieldIds(hint: string | undefined, wrong: string | undefined) {
  const id = useId();
  const hintId = hint === undefined ? undefined : `${id}-hint`;
  const wrongId = wrong === undefined ? undefined : `${id}-wrong`;
  const describedBy = [hintId, wrongId].filter(Boolean).join(" ") || undefined;
  return { id, hintId, wrongId, describedBy };
}

function Frame({
  label,
  hint,
  wrong,
  id,
  hintId,
  wrongId,
  children,
}: Common & {
  id: string;
  hintId: string | undefined;
  wrongId: string | undefined;
  children: ReactNode;
}): ReactNode {
  return (
    <div className="field">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      {children}
      {hint !== undefined && (
        <span className="hint" id={hintId}>
          {hint}
        </span>
      )}
      {wrong !== undefined && (
        <span className="wrong" id={wrongId}>
          {wrong}
        </span>
      )}
    </div>
  );
}

export function TextField({
  value,
  onChange,
  type = "text",
  ...common
}: Common & {
  value: string;
  onChange: (next: string) => void;
  type?: "text" | "password" | "tel" | "number";
}): ReactNode {
  const ids = useFieldIds(common.hint, common.wrong);
  return (
    <Frame {...common} {...ids}>
      <input
        id={ids.id}
        type={type}
        value={value}
        aria-describedby={ids.describedBy}
        aria-invalid={common.wrong !== undefined}
        onChange={(event) => onChange(event.target.value)}
      />
    </Frame>
  );
}

export function AreaField({
  value,
  onChange,
  rows,
  ...common
}: Common & {
  value: string;
  onChange: (next: string) => void;
  rows?: number;
}): ReactNode {
  const ids = useFieldIds(common.hint, common.wrong);
  return (
    <Frame {...common} {...ids}>
      <textarea
        id={ids.id}
        rows={rows ?? 6}
        value={value}
        spellCheck={false}
        aria-describedby={ids.describedBy}
        aria-invalid={common.wrong !== undefined}
        onChange={(event) => onChange(event.target.value)}
      />
    </Frame>
  );
}

export function PickField({
  value,
  onChange,
  options,
  ...common
}: Common & {
  value: string;
  onChange: (next: string) => void;
  options: readonly { value: string; label: string }[];
}): ReactNode {
  const ids = useFieldIds(common.hint, common.wrong);
  return (
    <Frame {...common} {...ids}>
      <select
        id={ids.id}
        value={value}
        aria-describedby={ids.describedBy}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Frame>
  );
}

export function CheckList({
  legend,
  hint,
  options,
  chosen,
  onChange,
}: {
  legend: string;
  hint?: string;
  options: readonly { value: string; label: string }[];
  chosen: readonly string[];
  onChange: (next: string[]) => void;
}): ReactNode {
  const picked = new Set(chosen);
  return (
    <fieldset className="field bare">
      <legend className="label">{legend}</legend>
      {hint !== undefined && <span className="hint">{hint}</span>}
      <div className="checks">
        {options.map((option) => (
          <label key={option.value}>
            <input
              type="checkbox"
              checked={picked.has(option.value)}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...chosen, option.value]
                    : chosen.filter((one) => one !== option.value),
                )
              }
            />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
