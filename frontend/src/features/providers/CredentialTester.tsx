'use client';

import { useState } from 'react';
import { ApiOutlined } from '@ant-design/icons';
import { Alert, Button, Flex, Typography } from 'antd';
import { providerApi } from '@/lib/api';
import type { ProviderVerifyResult } from '@/lib/contract';

/**
 * "Test connection" — a real authenticated call to the vendor, from inside the
 * form, before anything is saved.
 *
 * The point is where it sits. Verifying only after saving means the first
 * feedback on a wrong Azure deployment name or a mismatched PlayHT user id
 * arrives once the credential is already encrypted and stored, and in the worst
 * case not until a caller is on the line. Testing from the open form turns a
 * production incident into a typo the customer fixes in the next field.
 *
 * Three outcomes, and they are deliberately NOT collapsed into pass/fail:
 *   - success — the vendor answered and accepted the credential.
 *   - error   — the vendor answered and rejected it. The message names the
 *               likely field, because "invalid credential" sends someone to
 *               rotate a key that was never the problem.
 *   - warning — we could not reach the vendor, or it returned a 5xx. Nothing
 *               was learned about the key, and saying "valid" here would be a
 *               lie the customer only discovers on a call.
 */
export function CredentialTester({
  providerKey,
  workspaceId,
  /** Reads the current form values. Called on click, so it always tests what is on screen. */
  collect,
  disabled,
}: {
  providerKey: string | null;
  workspaceId: string;
  collect: () => Promise<{ config: Record<string, string>; secrets: Record<string, string> }>;
  disabled?: boolean;
}) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ProviderVerifyResult | null>(null);

  const run = async () => {
    if (!providerKey) return;
    setTesting(true);
    setResult(null);
    try {
      const { config, secrets } = await collect();
      setResult(await providerApi.test({ providerKey, config, secrets }, workspaceId));
    } catch (err) {
      // A form validation error lands here too — the fields it names are the
      // same ones the probe would have complained about, so show it as-is.
      setResult({
        status: 'invalid',
        checked: 'structural',
        message: (err as Error).message || 'Fill in every field before testing.',
      });
    } finally {
      setTesting(false);
    }
  };

  // Success requires BOTH a pass and a vendor that actually answered. A
  // structural result — no probe for this vendor yet, or we could not reach it —
  // is never green, whatever its status says.
  const succeeded = result?.checked === 'live' && result.status === 'valid';
  const tone = !result
    ? undefined
    : succeeded
      ? 'success'
      : result.checked === 'structural'
        ? 'warning'
        : 'error';

  return (
    <Flex vertical gap={10} style={{ marginBottom: 16 }}>
      <Flex align="center" gap={10}>
        <Button
          icon={<ApiOutlined />}
          onClick={run}
          loading={testing}
          disabled={disabled || !providerKey}
        >
          Test connection
        </Button>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Checks the key against the provider now. Nothing is saved.
        </Typography.Text>
      </Flex>

      {result && tone && (
        <Alert
          type={tone}
          showIcon
          message={
            succeeded
              ? 'Connection succeeded'
              : result.checked === 'structural'
                ? 'Not tested'
                : 'Connection failed'
          }
          description={
            <Typography.Text style={{ fontSize: 13 }}>
              {result.message}
              {result.providerStatus ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {' '}
                  (HTTP {result.providerStatus})
                </Typography.Text>
              ) : null}
            </Typography.Text>
          }
        />
      )}
    </Flex>
  );
}
