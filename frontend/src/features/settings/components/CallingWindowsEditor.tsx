'use client';

import { Alert, Button, Flex, Select, Switch, Tooltip, Typography } from 'antd';
import { createStyles } from 'antd-style';
import { DAYS, tightestWindow } from '@/features/settings/jurisdictions';

const useStyles = createStyles(({ token, css }) => ({
  row: css`
    display: grid;
    grid-template-columns: 48px 96px 1fr;
    align-items: center;
    gap: 10px;
    padding: 6px 10px;
    border-radius: ${token.borderRadius}px;
    &:nth-of-type(odd) {
      background: ${token.colorFillQuaternary};
    }
  `,
  day: css`
    font-size: 12px;
    font-weight: 600;
  `,
  closed: css`
    font-size: 12px;
    color: ${token.colorTextTertiary};
  `,
}));

export interface CallingWindow {
  dayOfWeek: number;
  startHour: number;
  endHour: number;
}

const HOURS = Array.from({ length: 25 }, (_, h) => ({
  value: h,
  label: h === 24 ? '24:00' : `${String(h).padStart(2, '0')}:00`,
}));

/**
 * Calling windows, one row per day, stated in the CALLEE's local time.
 *
 * The timezone caveat is the whole point of this control. An operator in Berlin
 * setting "09:00–20:00" is not setting their own office hours — a lead in
 * Lisbon is dialled at 09:00 Lisbon time. Getting that backwards is the single
 * most common way a compliant configuration produces a non-compliant call.
 */
export function CallingWindowsEditor({
  value,
  onChange,
  jurisdictions,
  disabled,
}: {
  value: CallingWindow[];
  onChange: (value: CallingWindow[]) => void;
  jurisdictions: string[];
  disabled?: boolean;
}) {
  const { styles } = useStyles();
  const byDay = new Map(value.map((w) => [w.dayOfWeek, w]));
  const suggested = tightestWindow(jurisdictions);

  const setDay = (dayOfWeek: number, next: CallingWindow | null) => {
    const rest = value.filter((w) => w.dayOfWeek !== dayOfWeek);
    onChange(next ? [...rest, next].sort((a, b) => a.dayOfWeek - b.dayOfWeek) : rest);
  };

  const applySuggested = () => {
    if (!suggested) return;
    onChange(
      [1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
        dayOfWeek,
        startHour: suggested.startHour,
        endHour: suggested.endHour,
      })),
    );
  };

  const outOfBounds = suggested
    ? value.filter((w) => w.startHour < suggested.startHour || w.endHour > suggested.endHour)
    : [];

  return (
    <Flex vertical gap={10}>
      <Alert
        type="info"
        showIcon
        message="These hours are the person you are calling, not you."
        description="A window of 09:00–20:00 means a lead in Lisbon is dialled between 09:00 and 20:00 Lisbon time, and a lead in Warsaw between 09:00 and 20:00 Warsaw time. Outside the window the dial is blocked before it reaches the carrier — the campaign simply waits."
      />

      <div>
        {DAYS.map((day) => {
          const win = byDay.get(day.value);
          return (
            <div key={day.value} className={styles.row}>
              <span className={styles.day}>{day.short}</span>
              <Switch
                size="small"
                checked={Boolean(win)}
                disabled={disabled}
                onChange={(on) =>
                  setDay(
                    day.value,
                    on
                      ? {
                          dayOfWeek: day.value,
                          startHour: suggested?.startHour ?? 9,
                          endHour: suggested?.endHour ?? 20,
                        }
                      : null,
                  )
                }
              />
              {win ? (
                <Flex align="center" gap={6}>
                  <Select
                    size="small"
                    style={{ width: 92 }}
                    value={win.startHour}
                    disabled={disabled}
                    options={HOURS.filter((h) => h.value < win.endHour)}
                    onChange={(startHour) => setDay(day.value, { ...win, startHour })}
                  />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    to
                  </Typography.Text>
                  <Select
                    size="small"
                    style={{ width: 92 }}
                    value={win.endHour}
                    disabled={disabled}
                    options={HOURS.filter((h) => h.value > win.startHour)}
                    onChange={(endHour) => setDay(day.value, { ...win, endHour })}
                  />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    callee’s local time
                  </Typography.Text>
                </Flex>
              ) : (
                <span className={styles.closed}>
                  No outbound calls on {day.long}
                  {day.value === 0 && ' — Sunday calling is restricted or frowned on in most of Europe.'}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {suggested && (
        <Flex align="center" gap={8} wrap>
          <Tooltip title="The tightest window that satisfies every country you have selected.">
            <Button size="small" onClick={applySuggested} disabled={disabled}>
              Use the strictest legal window ({String(suggested.startHour).padStart(2, '0')}:00–
              {String(suggested.endHour).padStart(2, '0')}:00, Mon–Sat)
            </Button>
          </Tooltip>
          {outOfBounds.length > 0 && (
            <Typography.Text type="warning" style={{ fontSize: 12 }}>
              {outOfBounds.length} day{outOfBounds.length === 1 ? '' : 's'} fall outside the
              statutory window for at least one country you call.
            </Typography.Text>
          )}
        </Flex>
      )}

      {value.length === 0 && (
        <Alert
          type="warning"
          showIcon
          message="No calling windows configured"
          description="With an empty schedule the window check is skipped entirely and outbound calls can be placed at any hour. That is almost never what you want."
        />
      )}
    </Flex>
  );
}
