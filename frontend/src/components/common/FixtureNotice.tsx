'use client';

import { ExperimentOutlined } from '@ant-design/icons';
import { Alert, Typography } from 'antd';

/**
 * The honesty rule: a screen reading from `src/lib/fixtures` must say so.
 *
 * A fixtured feature that looks connected is worse than no feature — someone
 * demos it, someone else ships against it. `endpoints` lists exactly what the
 * control plane still owes this screen.
 */
export function FixtureNotice({
  feature,
  endpoints,
  works,
}: {
  feature: string;
  /** The routes the backend still has to implement, e.g. `GET /v1/workspaces/:id/tools`. */
  endpoints: string[];
  /** What genuinely works on this screen despite the fixtures, if anything. */
  works?: string;
}) {
  return (
    <Alert
      type="warning"
      showIcon
      icon={<ExperimentOutlined />}
      style={{ marginBottom: 12 }}
      message={`${feature} is running on local fixtures — nothing here is saved`}
      description={
        <>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 6 }}>
            {works
              ? `${works} Everything else is sample data.`
              : 'The layout, states and interactions are real; the data is sample data and edits are discarded on reload.'}{' '}
            Swapping to the live backend is a one-line change per method in{' '}
            <Typography.Text code>src/lib/api.ts</Typography.Text>.
          </Typography.Paragraph>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {endpoints.map((e) => (
              <Typography.Text key={e} code style={{ fontSize: 11 }}>
                {e}
              </Typography.Text>
            ))}
          </div>
        </>
      }
    />
  );
}
