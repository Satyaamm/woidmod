'use client';

import { Select } from 'antd';
import type { SelectProps } from 'antd';
import { COUNTRIES, flag } from './PhoneInput';

/**
 * Searchable ISO-3166 country picker.
 *
 * Country is not decoration in this product: it decides the tax-ID label
 * (VAT / EIN / USt-IdNr.), the invoice format, the default dial code and the
 * compliance defaults. It therefore gets a real component rather than a bare
 * `<Select>` copied per form, and it always emits the alpha-2 code — never the
 * display name.
 *
 * The list is shared with `PhoneInput` so the two can never disagree.
 */
export function CountrySelect({
  value,
  onChange,
  placeholder = 'Select a country',
  ...rest
}: {
  value?: string;
  onChange?: (code: string) => void;
  placeholder?: string;
} & Omit<SelectProps, 'value' | 'onChange' | 'options' | 'children'>) {
  return (
    <Select
      showSearch
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      optionFilterProp="searchText"
      options={COUNTRIES.map((c) => ({
        value: c.code,
        label: `${flag(c.code)}  ${c.name}`,
        searchText: `${c.name} ${c.code} ${c.dial}`,
      }))}
      {...rest}
    />
  );
}

/** Display helper for read-only surfaces — falls back to the raw code. */
export function countryName(code: string | undefined): string {
  if (!code) return '—';
  return COUNTRIES.find((c) => c.code === code.toUpperCase())?.name ?? code.toUpperCase();
}

export { flag };
