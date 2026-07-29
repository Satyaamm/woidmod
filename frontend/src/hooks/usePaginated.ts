'use client';

import { useEffect, useMemo, useState } from 'react';
import type { TablePaginationConfig } from 'antd';

import { useAsync, type AsyncState } from './useAsync';
import type { Paginated } from '@/lib/contract';

/**
 * The one pagination source. Owns page/pageSize, tracks total from the response,
 * and hands back a `tablePagination` config so every table in the product paginates
 * identically (size changer, "1–25 of 240", bottom-right) without re-deriving it.
 *
 * Two kinds of change are distinguished, because they must behave differently:
 *   • `resetDeps` (filters, search) → jump back to page 1. Staying on page 9 of a
 *     filter you just narrowed to 3 results is the classic empty-table bug.
 *   • `refreshToken` (a counter bumped after a mutation) → refetch the CURRENT page.
 *     Deleting a row shouldn't fling you back to page 1.
 */
export interface UsePaginatedOptions {
  pageSize?: number;
  pageSizeOptions?: number[];
  /** Changing any of these resets to page 1 (filters/search). */
  resetDeps?: unknown[];
  /** Bump to refetch the current page in place (after a create/update/delete). */
  refreshToken?: unknown;
}

export interface UsePaginatedResult<T> {
  /** For `<AsyncBoundary state={…}>`. */
  state: AsyncState<Paginated<T>>;
  /** Convenience: the current page's rows, or [] before first load. */
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  setPage: (page: number) => void;
  setPageSize: (size: number) => void;
  reload: () => void;
  /** Spread straight onto `<Table pagination={…}>` or `<Pagination {…}>`. */
  tablePagination: TablePaginationConfig;
}

export function usePaginated<T>(
  fetcher: (params: { page: number; pageSize: number }) => Promise<Paginated<T>>,
  opts: UsePaginatedOptions = {},
): UsePaginatedResult<T> {
  const {
    pageSize: initialSize = 25,
    pageSizeOptions = [10, 25, 50, 100],
    resetDeps = [],
    refreshToken,
  } = opts;

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(initialSize);

  // Serialise the reset deps so a new filter value is a new effect key.
  const resetKey = JSON.stringify(resetDeps);

  // A filter change returns to page 1. Skips the initial mount (page is already 1),
  // and only writes when needed so it never causes a redundant fetch on its own.
  useEffect(() => {
    setPage((p) => (p === 1 ? p : 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  const state = useAsync<Paginated<T>>(
    () => fetcher({ page, pageSize }),
    [page, pageSize, resetKey, refreshToken],
  );

  const total = state.data?.total ?? 0;
  const items = state.data?.items ?? [];

  const tablePagination = useMemo<TablePaginationConfig>(
    () => ({
      current: page,
      pageSize,
      total,
      showSizeChanger: true,
      pageSizeOptions: pageSizeOptions.map(String),
      showTotal: (t, range) => `${range[0]}–${range[1]} of ${t}`,
      position: ['bottomRight'],
      onChange: (nextPage, nextSize) => {
        setPage(nextPage);
        if (nextSize !== pageSize) setPageSize(nextSize);
      },
      // Hide the pager entirely when there's a single page of results.
      hideOnSinglePage: false,
    }),
    [page, pageSize, total, pageSizeOptions],
  );

  return {
    state,
    items,
    page,
    pageSize,
    total,
    setPage,
    setPageSize,
    reload: state.reload,
    tablePagination,
  };
}
