'use client';

import * as RadixSelect from '@radix-ui/react-select';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import { useId, useState } from 'react';

export type SelectOption = { value: string; label: string; disabled?: boolean };

// Radix reserves the empty string, so an "empty" choice (e.g. "Not a PUBLISH service") travels under a sentinel.
const EMPTY = '__spaca_empty__';
const toRadix = (value: string) => (value === '' ? EMPTY : value);
const fromRadix = (value: string) => (value === EMPTY ? '' : value);

type SelectProps = {
  name: string;
  options: readonly SelectOption[];
  defaultValue?: string;
  required?: boolean;
  placeholder?: string;
  disabled?: boolean;
  /** id of the visible label, or an aria-label when there is none. */
  labelledBy?: string;
  ariaLabel?: string;
  variant?: 'field' | 'pill';
};

/**
 * spaca select (Radix UI Select): a styled listbox with keyboard and screen-reader support. A visually hidden native
 * <select> carries the value, so plain POST/GET forms submit it (even before hydration) and `required` still validates.
 */
export function Select({ name, options, defaultValue, required = false, placeholder, disabled = false, labelledBy, ariaLabel, variant = 'field' }: SelectProps) {
  const [value, setValue] = useState(defaultValue ?? (placeholder ? '' : options[0]?.value ?? ''));
  const selected = options.find((option) => option.value === value);
  const hasEmptyOption = options.some((option) => option.value === '');

  return <span className={`select select-${variant}`}>
    <select
      className="select-native"
      name={name}
      value={value}
      required={required}
      disabled={disabled}
      onChange={(event) => setValue(event.target.value)}
      aria-hidden="true"
      tabIndex={-1}
    >
      {!hasEmptyOption && <option value="" />}
      {options.map((option) => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
    </select>
    <RadixSelect.Root value={toRadix(value)} onValueChange={(next) => setValue(fromRadix(next))} disabled={disabled}>
      <RadixSelect.Trigger className="select-trigger" aria-labelledby={labelledBy} aria-label={ariaLabel} data-empty={selected ? undefined : ''}>
        <RadixSelect.Value>{selected?.label ?? placeholder ?? ''}</RadixSelect.Value>
        <RadixSelect.Icon className="select-icon"><ChevronDown size={16} strokeWidth={2} aria-hidden /></RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content className="select-content" position="popper" sideOffset={6} collisionPadding={12}>
          <RadixSelect.ScrollUpButton className="select-scroll"><ChevronUp size={14} aria-hidden /></RadixSelect.ScrollUpButton>
          <RadixSelect.Viewport className="select-viewport">
            {options.map((option) => <RadixSelect.Item key={option.value} value={toRadix(option.value)} disabled={option.disabled} className="select-item">
              <RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
              <RadixSelect.ItemIndicator className="select-check"><Check size={16} strokeWidth={2.25} aria-hidden /></RadixSelect.ItemIndicator>
            </RadixSelect.Item>)}
          </RadixSelect.Viewport>
          <RadixSelect.ScrollDownButton className="select-scroll"><ChevronDown size={14} aria-hidden /></RadixSelect.ScrollDownButton>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  </span>;
}

/** Label + select in the same layout as `Field`. */
export function SelectField({ label, hint, ...props }: Omit<SelectProps, 'labelledBy' | 'ariaLabel'> & { label: string; hint?: string }) {
  const id = useId();
  return <div className="field">
    <span id={`${id}-label`}>{label}</span>
    <Select {...props} labelledBy={`${id}-label`} />
    {hint && <small>{hint}</small>}
  </div>;
}
