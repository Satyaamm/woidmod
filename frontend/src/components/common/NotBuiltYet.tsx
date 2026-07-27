'use client';

import { ToolOutlined } from '@ant-design/icons';
import { Card, Flex, Result, Typography } from 'antd';

/**
 * Honest placeholder for a nav destination whose types aren't in
 * `contract.ts` yet. Better than a fake screen: it says exactly what's missing
 * and who has to add it (the contract is the coordination point — docs/09).
 */
export function NotBuiltYet({
  screen,
  needs,
  description,
}: {
  screen: string;
  needs: string[];
  description: string;
}) {
  return (
    <Card size="small">
      <Result
        icon={<ToolOutlined style={{ opacity: 0.5 }} />}
        title={`${screen} isn’t built yet`}
        subTitle={description}
        extra={
          <Flex vertical align="center" gap={6}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Blocked on these types in <Typography.Text code>src/lib/contract.ts</Typography.Text>:
            </Typography.Text>
            <Flex gap={8} wrap justify="center">
              {needs.map((type) => (
                <Typography.Text key={type} code>
                  {type}
                </Typography.Text>
              ))}
            </Flex>
          </Flex>
        }
      />
    </Card>
  );
}
