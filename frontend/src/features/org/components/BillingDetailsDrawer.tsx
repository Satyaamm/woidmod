'use client';

import { useState } from 'react';
import { App, Alert, Button, Col, Drawer, Form, Input, Row, Space, Typography } from 'antd';
import { AddressForm } from '@/components/common/AddressForm';
import { CountrySelect } from '@/components/common/CountrySelect';
import { currentOrgApi, type OrgWithTaxLabel } from '@/lib/api';
import type { PostalAddress } from '@/lib/contract';
import { taxIdLabel as localTaxIdLabel } from '@/lib/format';

interface FormValues {
  legalName?: string;
  billingEmail?: string;
  country: string;
  taxId?: string;
  address?: PostalAddress;
}

/**
 * Org billing details (UI-PAGE-INVENTORY §4): legal name, structured address,
 * country-specific tax ID.
 *
 * Two details that are easy to get wrong and expensive to get wrong:
 *
 * 1. **Legal name is not display name.** The invoice must say the full registered
 *    entity name, not the short display name; a mismatch is a rejected expense claim in most finance
 *    departments.
 * 2. **The tax-ID label follows the country.** `GET /v1/org` returns
 *    `taxIdLabel` derived server-side (VAT / EIN / USt-IdNr. / GSTIN) so the
 *    rule lives in one place. While the user is *changing* the country in this
 *    form the server value is stale, so we fall back to the local mapping until
 *    it is saved — the field must never be labelled "VAT ID" to a US customer,
 *    even for the seconds before a round trip.
 */
export function BillingDetailsDrawer({
  open,
  org,
  onClose,
  onSaved,
}: {
  open: boolean;
  org: OrgWithTaxLabel;
  onClose: () => void;
  onSaved: (org: OrgWithTaxLabel) => void;
}) {
  const { message } = App.useApp();
  const [form] = Form.useForm<FormValues>();
  const [busy, setBusy] = useState(false);
  const country: string = Form.useWatch('country', form) ?? org.country;

  // Server-derived label while the country is untouched; local mapping while editing.
  const label = country === org.country ? org.taxIdLabel : localTaxIdLabel(country);

  const save = async () => {
    const values = await form.validateFields();
    setBusy(true);
    try {
      const updated = await currentOrgApi.update(values);
      message.success('Billing details saved. Future invoices use them.');
      onSaved(updated);
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={560}
      title="Billing details"
      destroyOnHidden
      extra={
        <Space>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="primary" loading={busy} onClick={save}>
            Save details
          </Button>
        </Space>
      }
    >
      <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
        These appear on every invoice and on the DPA. Finance teams reject invoices whose legal entity
        or tax ID does not match their records, so it is worth being exact.
      </Typography.Paragraph>

      <Form<FormValues>
        form={form}
        layout="vertical"
        requiredMark={false}
        initialValues={{
          legalName: org.legalName,
          billingEmail: org.billingEmail,
          country: org.country,
          taxId: org.taxId,
          address: org.address,
        }}
      >
        <Form.Item
          name="legalName"
          label="Registered legal name"
          extra={`Not the display name. For "${org.name}" this is usually the full registered entity.`}
          rules={[{ required: true, message: 'The invoice needs a legal entity name' }]}
        >
          <Input placeholder="Registered legal entity name" autoComplete="organization" />
        </Form.Item>

        <Row gutter={12}>
          <Col xs={24} sm={12}>
            <Form.Item
              name="country"
              label="Country of registration"
              rules={[{ required: true, message: 'Country is required' }]}
              extra="Drives the tax-ID format and the invoice layout."
            >
              <CountrySelect />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12}>
            <Form.Item
              name="taxId"
              label={label}
              extra={`Shown on the invoice as your ${label}. Leave blank if you have none.`}
            >
              <Input placeholder={label === 'EIN' ? '12-3456789' : 'DE123456789'} autoComplete="off" />
            </Form.Item>
          </Col>
        </Row>

        <Form.Item
          name="billingEmail"
          label="Billing email"
          rules={[{ type: 'email', message: 'That does not look like an email address' }]}
          extra="Where invoices and dunning notices go. Often accounts-payable, not you."
        >
          <Input placeholder="billing@example.com" autoComplete="email" />
        </Form.Item>

        <Typography.Title level={5} style={{ marginTop: 8 }}>
          Registered address
        </Typography.Title>
        <AddressForm />

        <Alert
          type="info"
          showIcon
          message="Reverse charge"
          description="If you supply a valid EU VAT ID outside our country of establishment, invoices are issued without VAT under the reverse-charge mechanism."
        />
      </Form>
    </Drawer>
  );
}
