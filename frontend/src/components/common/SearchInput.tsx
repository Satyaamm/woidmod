'use client';

import { useEffect, useRef, useState } from 'react';
import { SearchOutlined } from '@ant-design/icons';
import { Input } from 'antd';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';

export interface SearchInputProps {
  /** The committed (debounced) value. Keep this in the page's filter state. */
  value: string;
  /** Fires with the debounced text, ~`delayMs` after the user stops typing. */
  onChange: (value: string) => void;
  placeholder?: string;
  allowClear?: boolean;
  delayMs?: number;
  width?: number | string;
}

/**
 * One debounced search box for every list page. Typing stays instant (local
 * state) while `onChange` only fires once input settles, so client filters and
 * server queries aren't hammered on every keystroke. Clearing is immediate.
 */
export function SearchInput({
  value,
  onChange,
  placeholder = 'Search',
  allowClear = true,
  delayMs = 300,
  width = 260,
}: SearchInputProps) {
  const [text, setText] = useState(value);
  const debounced = useDebouncedValue(text, delayMs);

  // Keep local text in sync when the committed value is reset from outside
  // (e.g. a "clear filters" button) without clobbering in-flight typing.
  useEffect(() => {
    setText((prev) => (prev === value ? prev : value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // Only surface debounced changes the caller hasn't already seen.
  const last = useRef(value);
  useEffect(() => {
    if (debounced !== last.current) {
      last.current = debounced;
      onChange(debounced);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  return (
    <Input
      allowClear={allowClear}
      prefix={<SearchOutlined />}
      placeholder={placeholder}
      // A filter box is not personal data — an autofill dropdown over it only ever
      // covers the results the user is typing to see.
      autoComplete="off"
      value={text}
      onChange={(e) => {
        const next = e.target.value;
        setText(next);
        // Clearing should feel instant — don't wait out the debounce.
        if (next === '') {
          last.current = '';
          onChange('');
        }
      }}
      style={{ maxWidth: width, width }}
    />
  );
}
