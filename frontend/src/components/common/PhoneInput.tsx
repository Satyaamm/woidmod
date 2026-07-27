'use client';

import { useMemo, useState } from 'react';
import { Input, Select, Space } from 'antd';
import type { PhoneNumberValue } from '@/lib/contract';

/**
 * Country-code phone input — flag, dial code, searchable country list
 * (docs/09 step 3). Used at first invite / first live call, not at signup.
 */

interface Country {
  code: string;
  dial: string;
  name: string;
}

/** Trimmed to the markets in docs/13 plus the common long tail. */
export const COUNTRIES: Country[] = [
  { code: 'IN', dial: '+91', name: 'India' },
  { code: 'US', dial: '+1', name: 'United States' },
  { code: 'CA', dial: '+1', name: 'Canada' },
  { code: 'GB', dial: '+44', name: 'United Kingdom' },
  { code: 'DE', dial: '+49', name: 'Germany' },
  { code: 'FR', dial: '+33', name: 'France' },
  { code: 'NL', dial: '+31', name: 'Netherlands' },
  { code: 'ES', dial: '+34', name: 'Spain' },
  { code: 'IT', dial: '+39', name: 'Italy' },
  { code: 'AT', dial: '+43', name: 'Austria' },
  { code: 'CH', dial: '+41', name: 'Switzerland' },
  { code: 'IE', dial: '+353', name: 'Ireland' },
  { code: 'AE', dial: '+971', name: 'United Arab Emirates' },
  { code: 'SG', dial: '+65', name: 'Singapore' },
  { code: 'AU', dial: '+61', name: 'Australia' },
  { code: 'BR', dial: '+55', name: 'Brazil' },
  { code: 'MX', dial: '+52', name: 'Mexico' },
  { code: 'PH', dial: '+63', name: 'Philippines' },
  { code: 'ZA', dial: '+27', name: 'South Africa' },
];

/** Flag emoji from the ISO code — no image assets, no icon font. */
export const flag = (code: string) =>
  String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1f1a5 + c.charCodeAt(0)));

export function PhoneInput({
  value,
  onChange,
  defaultCountry = 'IN',
}: {
  value?: PhoneNumberValue;
  onChange?: (value: PhoneNumberValue) => void;
  defaultCountry?: string;
}) {
  const [country, setCountry] = useState(value?.countryCode ?? defaultCountry);
  const [number, setNumber] = useState(value?.number ?? '');

  const options = useMemo(
    () =>
      COUNTRIES.map((c) => ({
        value: c.code,
        label: (
          <span>
            {flag(c.code)} {c.dial}
          </span>
        ),
        searchText: `${c.name} ${c.dial} ${c.code}`,
      })),
    [],
  );

  const emit = (nextCountry: string, nextNumber: string) => {
    const dial = COUNTRIES.find((c) => c.code === nextCountry)?.dial ?? '+91';
    onChange?.({ countryCode: nextCountry, dialCode: dial, number: nextNumber });
  };

  return (
    <Space.Compact style={{ width: '100%' }}>
      <Select
        style={{ width: 118 }}
        value={country}
        options={options}
        showSearch
        optionFilterProp="searchText"
        onChange={(next) => {
          setCountry(next);
          emit(next, number);
        }}
      />
      <Input
        style={{ width: '100%' }}
        value={number}
        inputMode="tel"
        placeholder="Phone number"
        onChange={(e) => {
          const digits = e.target.value.replace(/\D/g, '');
          setNumber(digits);
          emit(country, digits);
        }}
      />
    </Space.Compact>
  );
}
