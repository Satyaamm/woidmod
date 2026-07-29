'use client';

import { ApiOutlined, CalendarOutlined, DatabaseOutlined, LinkOutlined } from '@ant-design/icons';
import { Card, Col, Empty, Flex, Row, Tag, Typography } from 'antd';
import { createStyles } from 'antd-style';

const useStyles = createStyles(({ token, css }) => ({
  tile: css`
    height: 100%;
    opacity: 0.72;
  `,
  icon: css`
    font-size: 18px;
    color: ${token.colorTextTertiary};
  `,
  body: css`
    font-size: 12px;
    color: ${token.colorTextTertiary};
    line-height: 1.55;
  `,
}));

const PLANNED = [
  {
    key: 'crm',
    icon: <DatabaseOutlined />,
    title: 'CRM',
    body: 'Push call outcomes and transcripts onto the contact record, and pull lead lists for campaigns without a CSV.',
  },
  {
    key: 'calendar',
    icon: <CalendarOutlined />,
    title: 'Calendar',
    body: 'Let an agent read availability and book directly, instead of promising a callback.',
  },
  {
    key: 'webhooks',
    icon: <ApiOutlined />,
    title: 'Webhooks',
    body: 'Fire an HTTP request on call completion, escalation, or a compliance block, so your systems learn about it in seconds.',
  },
];

/**
 * Honest placeholder. Nothing here is wired to a backend yet, and pretending
 * otherwise with a row of greyed-out "Connect" buttons would be worse than
 * saying so.
 */
export function IntegrationsTab() {
  const { styles } = useStyles();

  return (
    <Flex vertical gap={16}>
      <Card size="small">
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <Flex vertical gap={6} align="center">
              <Typography.Text strong>No integrations yet</Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12, maxWidth: '52ch' }}>
                Agents can already call any HTTP endpoint you define as a tool, which covers most
                of what an integration would do. Named connectors — with OAuth, field mapping and
                sync history — are not built.
              </Typography.Text>
              <Typography.Link href="../agents">
                <LinkOutlined /> Define a tool on an agent instead
              </Typography.Link>
            </Flex>
          }
        />
      </Card>

      <div>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Planned
        </Typography.Text>
        <Row gutter={[12, 12]} style={{ marginTop: 8 }}>
          {PLANNED.map((p) => (
            <Col xs={24} md={8} key={p.key}>
              <Card size="small" className={styles.tile}>
                <Flex vertical gap={6}>
                  <Flex justify="space-between" align="center">
                    <span className={styles.icon}>{p.icon}</span>
                    <Tag bordered={false}>not built</Tag>
                  </Flex>
                  <Typography.Text strong style={{ fontSize: 13 }}>
                    {p.title}
                  </Typography.Text>
                  <span className={styles.body}>{p.body}</span>
                </Flex>
              </Card>
            </Col>
          ))}
        </Row>
      </div>
    </Flex>
  );
}
