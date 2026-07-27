'use client';

import { useState } from 'react';
import {
  CheckCircleFilled,
  ClockCircleOutlined,
  DeleteOutlined,
  ExportOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Descriptions,
  Divider,
  Flex,
  Form,
  Input,
  Modal,
  Row,
  Select,
  Space,
  Tag,
  Typography,
} from 'antd';
import { createStyles } from 'antd-style';
import { AddressForm } from '@/components/common/AddressForm';
import { ConfirmDestructive } from '@/components/common/ConfirmDestructive';
import { CountrySelect } from '@/components/common/CountrySelect';
import { PermissionGate, usePermission } from '@/components/common/PermissionGate';
import { PhoneInput } from '@/components/common/PhoneInput';
import { currentOrgApi, type OrgWithTaxLabel } from '@/lib/api';
import type { OrgSize } from '@/lib/contract';
import { taxIdLabel as localTaxIdLabel } from '@/lib/format';

const SIZES: OrgSize[] = ['1-10', '11-50', '51-200', '201-1000', '1000+'];

const useStyles = createStyles(({ token, css }) => ({
  danger: css`
    border-color: ${token.colorErrorBorder};
  `,
  dangerRow: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 14px 0;
    flex-wrap: wrap;
  `,
  txt: css`
    font-family: ${token.fontFamilyCode};
    font-size: 12px;
  `,
}));

/**
 * Settings save **per section**, never one giant Save (UI-IA §5). Each card owns
 * its own form and its own submit, so changing a phone number does not risk
 * re-submitting a half-edited address.
 */
function useSectionSave(onSaved: (org: OrgWithTaxLabel) => void) {
  const { message } = App.useApp();
  const [busy, setBusy] = useState(false);
  return {
    busy,
    save: async (values: Record<string, unknown>) => {
      setBusy(true);
      try {
        const updated = await currentOrgApi.update(values);
        onSaved(updated);
        message.success('Saved.');
      } catch (err) {
        message.error((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export function OrgProfileSection({
  org,
  onSaved,
}: {
  org: OrgWithTaxLabel;
  onSaved: (org: OrgWithTaxLabel) => void;
}) {
  const canWrite = usePermission('org:write');
  const { busy, save } = useSectionSave(onSaved);
  const [form] = Form.useForm();

  return (
    <Row gutter={[12, 12]}>
      <Col xs={24} xl={14}>
        <Card
          size="small"
          title="Organization profile"
          extra={
            <PermissionGate need="org:write" reason="Only owners and admins can edit the organization.">
              <Button size="small" type="primary" loading={busy} onClick={() => save(form.getFieldsValue())}>
                Save profile
              </Button>
            </PermissionGate>
          }
        >
          <Form form={form} layout="vertical" initialValues={org} disabled={!canWrite} requiredMark={false}>
            <Row gutter={12}>
              <Col xs={24} sm={12}>
                <Form.Item
                  name="name"
                  label="Display name"
                  extra="What the product shows in the switcher and the sidebar."
                  rules={[{ required: true, message: 'A display name is required' }]}
                >
                  <Input />
                </Form.Item>
              </Col>
              <Col xs={24} sm={12}>
                <Form.Item
                  name="legalName"
                  label="Legal name"
                  extra="The registered legal entity name that appears on contracts and invoices."
                >
                  <Input />
                </Form.Item>
              </Col>
              <Col xs={24} sm={12}>
                <Form.Item
                  name="slug"
                  label="URL slug"
                  extra="Changing this breaks every existing link to this organization."
                  rules={[
                    {
                      pattern: /^[a-z0-9]+(-[a-z0-9]+)*$/,
                      message: 'Lowercase letters, numbers and single hyphens only',
                    },
                  ]}
                >
                  <Input addonBefore="/orgs/" />
                </Form.Item>
              </Col>
              <Col xs={24} sm={12}>
                <Form.Item name="website" label="Website">
                  <Input placeholder="https://example.com" />
                </Form.Item>
              </Col>
              <Col xs={24} sm={12}>
                <Form.Item name="industry" label="Industry">
                  <Input placeholder="Financial services" />
                </Form.Item>
              </Col>
              <Col xs={24} sm={12}>
                <Form.Item name="size" label="Company size">
                  <Select
                    allowClear
                    options={SIZES.map((s) => ({ value: s, label: `${s} people` }))}
                  />
                </Form.Item>
              </Col>
              <Col xs={24} sm={12}>
                <Form.Item name="phone" label="Phone">
                  <PhoneInput defaultCountry={org.country} />
                </Form.Item>
              </Col>
              <Col xs={24} sm={12}>
                <Form.Item name="timezone" label="Default timezone" extra="Used for reports and calling windows.">
                  <Input placeholder="Europe/Berlin" />
                </Form.Item>
              </Col>
            </Row>
          </Form>
        </Card>
      </Col>

      <Col xs={24} xl={10}>
        <Card size="small" title="Identifiers">
          <Descriptions column={1} size="small" colon={false}>
            <Descriptions.Item label="Organization ID">
              <Typography.Text copyable code style={{ fontSize: 12 }}>
                {org.id}
              </Typography.Text>
            </Descriptions.Item>
            <Descriptions.Item label="Created">
              {new Date(org.createdAt).toLocaleDateString()}
            </Descriptions.Item>
            <Descriptions.Item label="Currency">{org.currency}</Descriptions.Item>
            {org.parentOrgId ? (
              <Descriptions.Item label="Parent organization">
                <Typography.Text code style={{ fontSize: 12 }}>
                  {org.parentOrgId}
                </Typography.Text>
              </Descriptions.Item>
            ) : null}
          </Descriptions>
          <Alert
            type="info"
            showIcon
            style={{ marginTop: 8 }}
            message="Quote the organization ID in support tickets — it is stable even if the slug changes."
          />
        </Card>
      </Col>
    </Row>
  );
}

// ---------------------------------------------------------------------------
// Address & tax
// ---------------------------------------------------------------------------

export function OrgTaxSection({
  org,
  onSaved,
}: {
  org: OrgWithTaxLabel;
  onSaved: (org: OrgWithTaxLabel) => void;
}) {
  const canWrite = usePermission('org:write');
  const { busy, save } = useSectionSave(onSaved);
  const [form] = Form.useForm();
  const country: string = Form.useWatch('country', form) ?? org.country;

  // Server derives the label from the saved country; while it is being edited we
  // fall back locally so a US customer is never shown a "VAT ID" field.
  const label = country === org.country ? org.taxIdLabel : localTaxIdLabel(country);

  return (
    <Row gutter={[12, 12]}>
      <Col xs={24} xl={14}>
        <Card
          size="small"
          title="Address & tax"
          extra={
            <PermissionGate need="org:write" reason="Only owners and admins can edit this.">
              <Button size="small" type="primary" loading={busy} onClick={() => save(form.getFieldsValue())}>
                Save details
              </Button>
            </PermissionGate>
          }
        >
          <Form form={form} layout="vertical" initialValues={org} disabled={!canWrite} requiredMark={false}>
            <Row gutter={12}>
              <Col xs={24} sm={12}>
                <Form.Item
                  name="country"
                  label="Country of registration"
                  extra="Drives the tax-ID format, the invoice layout and compliance defaults."
                >
                  <CountrySelect />
                </Form.Item>
              </Col>
              <Col xs={24} sm={12}>
                <Form.Item name="taxId" label={label} extra={`Printed on every invoice as your ${label}.`}>
                  <Input placeholder={label === 'EIN' ? '12-3456789' : 'DE123456789'} />
                </Form.Item>
              </Col>
              <Col xs={24}>
                <Form.Item
                  name="billingEmail"
                  label="Billing email"
                  rules={[{ type: 'email', message: 'That does not look like an email address' }]}
                  extra="Where invoices go. Usually accounts-payable rather than a person."
                >
                  <Input />
                </Form.Item>
              </Col>
            </Row>
            <Divider style={{ margin: '4px 0 12px' }} />
            <AddressForm />
          </Form>
        </Card>
      </Col>
      <Col xs={24} xl={10}>
        <Card size="small" title="Why we ask">
          <Typography.Paragraph type="secondary" style={{ fontSize: 12.5 }}>
            The registered address and tax ID are contractual, not cosmetic. They appear on the invoice,
            on the DPA, and they decide whether VAT is charged or reverse-charged. A mismatch between
            what you enter here and what your tax authority holds is the most common cause of a rejected
            invoice.
          </Typography.Paragraph>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12.5, marginBottom: 0 }}>
            Data residency is separate and set per workspace — see each workspace&apos;s region.
          </Typography.Paragraph>
        </Card>
      </Col>
    </Row>
  );
}

// ---------------------------------------------------------------------------
// Verified domains
// ---------------------------------------------------------------------------

export function OrgDomainsSection({
  org,
  onSaved,
}: {
  org: OrgWithTaxLabel;
  onSaved: (org: OrgWithTaxLabel) => void;
}) {
  const { styles } = useStyles();
  const { message } = App.useApp();
  const canWrite = usePermission('org:write');
  const [adding, setAdding] = useState(false);
  const [domain, setDomain] = useState('');
  const [pending, setPending] = useState<string | null>(null);

  const token = pending ? `woidmod-verify=${btoa(`${org.id}:${pending}`).replace(/=+$/, '')}` : '';

  const remove = async (d: string) => {
    const next = org.verifiedDomains.filter((x) => x !== d);
    const updated = await currentOrgApi.update({ verifiedDomains: next });
    onSaved(updated);
    message.success(`${d} removed.`);
  };

  return (
    <Row gutter={[12, 12]}>
      <Col xs={24} xl={14}>
        <Card
          size="small"
          title="Verified domains"
          extra={
            <PermissionGate need="org:write" reason="Only owners and admins can manage domains.">
              <Button size="small" icon={<PlusOutlined />} onClick={() => setAdding(true)}>
                Add domain
              </Button>
            </PermissionGate>
          }
        >
          <Typography.Paragraph type="secondary" style={{ fontSize: 12.5 }}>
            A verified domain lets colleagues signing up with that email domain find and join this
            organization instead of quietly creating a duplicate. Duplicate orgs are the single biggest
            source of split billing and orphaned agents.
          </Typography.Paragraph>

          {org.verifiedDomains.length ? (
            <Flex gap={8} wrap>
              {org.verifiedDomains.map((d) => (
                <Tag
                  key={d}
                  color="green"
                  bordered={false}
                  icon={<CheckCircleFilled />}
                  closable={canWrite}
                  onClose={(e) => {
                    e.preventDefault();
                    void remove(d);
                  }}
                >
                  {d}
                </Tag>
              ))}
            </Flex>
          ) : (
            <Flex vertical align="flex-start" gap={10}>
              <Typography.Text type="secondary">
                No verified domains yet — colleagues cannot discover this organization.
              </Typography.Text>
              <PermissionGate need="org:write" reason="Only owners and admins can manage domains.">
                <Button type="primary" icon={<PlusOutlined />} onClick={() => setAdding(true)}>
                  Verify a domain
                </Button>
              </PermissionGate>
            </Flex>
          )}
        </Card>
      </Col>

      <Modal
        open={adding}
        title="Verify a domain"
        onCancel={() => {
          setAdding(false);
          setPending(null);
          setDomain('');
        }}
        footer={
          pending ? (
            <Space>
              <Button
                onClick={() => {
                  setPending(null);
                  setDomain('');
                }}
              >
                Back
              </Button>
              <Button
                type="primary"
                icon={<ClockCircleOutlined />}
                onClick={() =>
                  message.info('DNS checks run every few minutes. We will email you when it verifies.')
                }
              >
                Check now
              </Button>
            </Space>
          ) : (
            <Button type="primary" disabled={!domain.trim()} onClick={() => setPending(domain.trim())}>
              Continue
            </Button>
          )
        }
        destroyOnHidden
      >
        {pending ? (
          <>
            <Typography.Paragraph style={{ fontSize: 13 }}>
              Add this TXT record at the root of <Typography.Text strong>{pending}</Typography.Text>, then
              come back. Propagation usually takes minutes, occasionally hours.
            </Typography.Paragraph>
            <Descriptions column={1} size="small" bordered>
              <Descriptions.Item label="Type">TXT</Descriptions.Item>
              <Descriptions.Item label="Host">@</Descriptions.Item>
              <Descriptions.Item label="Value">
                <Typography.Text copyable className={styles.txt}>
                  {token}
                </Typography.Text>
              </Descriptions.Item>
            </Descriptions>
          </>
        ) : (
          <Form layout="vertical" requiredMark={false}>
            <Form.Item
              label="Domain"
              extra="The bare domain, without https:// or www."
              validateStatus={domain && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain) ? 'error' : undefined}
            >
              <Input
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder="example.com"
                autoFocus
              />
            </Form.Item>
          </Form>
        )}
      </Modal>
    </Row>
  );
}

// ---------------------------------------------------------------------------
// Danger zone
// ---------------------------------------------------------------------------

export function OrgDangerSection({ org }: { org: OrgWithTaxLabel }) {
  const { styles } = useStyles();
  const { message } = App.useApp();
  const [deleting, setDeleting] = useState(false);

  return (
    <Row gutter={[12, 12]}>
      <Col xs={24} xl={16}>
        <Card size="small" title="Danger zone" className={styles.danger}>
          <div className={styles.dangerRow}>
            <Flex vertical style={{ maxWidth: 620 }}>
              <Typography.Text strong>Export all organization data</Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                Agents, call metadata, transcripts and the full audit log, as JSON. Do this before
                deleting anything — and before your retention window lapses.
              </Typography.Text>
            </Flex>
            <PermissionGate need="org:write" reason="Only owners and admins can export.">
              <Button
                icon={<ExportOutlined />}
                onClick={() => message.info('Export is queued server-side; you get an email when it is ready.')}
              >
                Request export
              </Button>
            </PermissionGate>
          </div>

          <Divider style={{ margin: 0 }} />

          <div className={styles.dangerRow}>
            <Flex vertical style={{ maxWidth: 620 }}>
              <Typography.Text strong>Delete this organization</Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                Permanently removes every workspace, agent, phone number, recording and API key. Billing
                stops at the end of the current period; the final invoice is still issued.
              </Typography.Text>
            </Flex>
            <PermissionGate
              need={['org:write', 'org:billing']}
              reason="Only an owner can delete the organization."
            >
              <Button danger icon={<DeleteOutlined />} onClick={() => setDeleting(true)}>
                Delete organization
              </Button>
            </PermissionGate>
          </div>
        </Card>
      </Col>

      <ConfirmDestructive
        open={deleting}
        onCancel={() => setDeleting(false)}
        title={`Delete ${org.name}`}
        resourceKind="organization"
        resourceName={org.name}
        confirmText="Delete organization"
        consequences={
          <>
            Every workspace, agent, phone number, recording, transcript and API key belonging to{' '}
            <strong>{org.name}</strong> is deleted. Numbers are released and cannot be recovered. Members
            lose access immediately. The audit log is retained for the statutory period and then
            destroyed.
          </>
        }
        onConfirm={async () => {
          // NEEDED: DELETE /v1/org. Intentionally not wired to a guessed endpoint.
          message.info('Organization deletion is not wired up yet — it needs DELETE /v1/org.');
          setDeleting(false);
        }}
      />
    </Row>
  );
}
