'use client';

/**
 * The paginated-table primitive. One component that fetches a `Paginated<T>`,
 * paginates it, and renders every state correctly:
 *   • first load  → a table-SHAPED skeleton (not a spinner, not a blank)
 *   • page change → rows stay, a spinner overlays (no layout jump)
 *   • error       → AsyncBoundary's retry/offline treatment
 *   • empty       → a real empty state
 *
 * This is the DRY answer to "every list screen re-implements loading + pagination":
 * a list page is now `<DataTable fetcher={…} columns={…} rowKey=… />` plus its
 * column defs. Use `refreshToken` to refetch after a mutation, `resetDeps` for
 * filters/search (which return to page 1).
 */

import type { HTMLAttributes, ReactNode } from 'react';
import { Table } from 'antd';
import type { ColumnsType } from 'antd/es/table';

import { AsyncBoundary } from './AsyncBoundary';
import { TableSkeleton } from './Skeletons';
import { usePaginated } from '@/hooks/usePaginated';
import type { Paginated } from '@/lib/contract';

export interface DataTableProps<T> {
  fetcher: (params: { page: number; pageSize: number }) => Promise<Paginated<T>>;
  columns: ColumnsType<T>;
  rowKey: string | ((row: T) => string);
  pageSize?: number;
  pageSizeOptions?: number[];
  /** Filters/search — changing these returns to page 1. */
  resetDeps?: unknown[];
  /** Bump after a create/update/delete to refetch the current page in place. */
  refreshToken?: unknown;
  empty?: ReactNode;
  /** Rows in the loading skeleton; defaults to the page size (capped). */
  skeletonRows?: number;
  scroll?: { x?: number | string; y?: number | string };
  onRow?: (row: T) => HTMLAttributes<HTMLElement>;
  size?: 'small' | 'middle' | 'large';
  /** Rendered under the header, above the table (e.g. a filter bar). */
  toolbar?: ReactNode;
}

export function DataTable<T>({
  fetcher,
  columns,
  rowKey,
  pageSize = 25,
  pageSizeOptions,
  resetDeps,
  refreshToken,
  empty,
  skeletonRows,
  scroll,
  onRow,
  size = 'small',
  toolbar,
}: DataTableProps<T>) {
  const p = usePaginated<T>(fetcher, { pageSize, pageSizeOptions, resetDeps, refreshToken });

  return (
    <>
      {toolbar}
      <AsyncBoundary
        state={p.state}
        skeleton={
          <TableSkeleton rows={skeletonRows ?? Math.min(pageSize, 8)} columns={columns.length} />
        }
        isEmpty={(data) => data.items.length === 0}
        empty={empty}
      >
        {(pageData) => (
          <Table<T>
            rowKey={rowKey}
            size={size}
            columns={columns}
            dataSource={pageData.items}
            pagination={p.tablePagination}
            // Rows already on screen: overlay a spinner on page/size changes rather
            // than flipping back to the skeleton.
            loading={p.state.loading}
            scroll={scroll}
            onRow={onRow}
          />
        )}
      </AsyncBoundary>
    </>
  );
}
