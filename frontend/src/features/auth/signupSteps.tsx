'use client';

import {
  BankOutlined,
  GlobalOutlined,
  LockOutlined,
  MailOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { Checkbox, Col, Flex, Form, Input, Progress, Row, Select, Typography } from 'antd';
import { AddressForm } from '@/components/common/AddressForm';
import { COUNTRIES, PhoneInput, flag } from '@/components/common/PhoneInput';
import type { OrgSize } from '@/lib/contract';
import { taxIdLabel } from '@/lib/format';

/** Industry list kept short — long taxonomies get abandoned. */
const INDUSTRIES = [
  'Financial services',
  'Insurance',
  'Healthcare',
  'Retail & e-commerce',
  'Logistics',
  'Travel & hospitality',
  'Telecom',
  'BPO / contact centre',
  'SaaS / technology',
  'Education',
  'Real estate',
  'Other',
];

const SIZES: OrgSize[] = ['1-10', '11-50', '51-200', '201-1000', '1000+'];

export const TIMEZONES = Intl.supportedValuesOf?.('timeZone') ?? ['UTC'];

// ---------------------------------------------------------------------------
// Step 1 — who you are
// ---------------------------------------------------------------------------

export function IdentityStep({ password }: { password: string }) {
  const strength = scorePassword(password);

  return (
    <>
      <Row gutter={12}>
        <Col xs={24} sm={12}>
          <Form.Item
            name="firstName"
            label="First name"
            rules={[{ required: true, message: 'Enter your first name' }]}
          >
            <Input size="large" prefix={<UserOutlined />} autoComplete="given-name" autoFocus />
          </Form.Item>
        </Col>
        <Col xs={24} sm={12}>
          <Form.Item
            name="familyName"
            label="Family name"
            rules={[{ required: true, message: 'Enter your family name' }]}
          >
            <Input size="large" autoComplete="family-name" />
          </Form.Item>
        </Col>
      </Row>

      <Form.Item
        name="email"
        label="Work email"
        rules={[
          { required: true, message: 'Enter your work email' },
          { type: 'email', message: 'That email looks wrong' },
        ]}
        extra="We use your domain to find your team if they're already here."
      >
        <Input size="large" prefix={<MailOutlined />} placeholder="you@example.com" autoComplete="email" />
      </Form.Item>

      <Form.Item name="jobTitle" label="Job title" extra="Optional — helps us tune the product tour.">
        <Input size="large" placeholder="Your role" autoComplete="organization-title" />
      </Form.Item>

      <Form.Item
        name="password"
        label="Password"
        rules={[
          { required: true, message: 'Choose a password' },
          { min: 10, message: 'At least 10 characters' },
        ]}
      >
        <Input.Password size="large" prefix={<LockOutlined />} autoComplete="new-password" />
      </Form.Item>

      {password && (
        <Flex align="center" gap={10} style={{ marginTop: -10, marginBottom: 14 }}>
          <Progress
            percent={strength.percent}
            size="small"
            showInfo={false}
            status={strength.percent < 50 ? 'exception' : 'success'}
            style={{ flex: 1, margin: 0 }}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {strength.label}
          </Typography.Text>
        </Flex>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — how we reach you
// ---------------------------------------------------------------------------

export function ContactStep({ country }: { country: string }) {
  return (
    <>
      <Form.Item
        name="country"
        label="Country"
        rules={[{ required: true, message: 'Select your country' }]}
        extra="Sets your dial code, currency, tax fields and compliance defaults."
      >
        <Select
          size="large"
          showSearch
          optionFilterProp="searchText"
          suffixIcon={<GlobalOutlined />}
          options={COUNTRIES.map((c) => ({
            value: c.code,
            label: `${flag(c.code)}  ${c.name}`,
            searchText: c.name,
          }))}
        />
      </Form.Item>

      <Form.Item
        name="phone"
        label="Mobile number"
        rules={[
          {
            validator: (_, value) =>
              value?.number?.length >= 6
                ? Promise.resolve()
                : Promise.reject(new Error('Enter a valid number')),
          },
        ]}
        extra="Used for account recovery and to verify live calling."
      >
        <PhoneInput defaultCountry={country} />
      </Form.Item>

      <Row gutter={12}>
        <Col xs={24} sm={14}>
          <Form.Item name="timezone" label="Timezone">
            <Select
              size="large"
              showSearch
              options={TIMEZONES.map((tz) => ({ value: tz, label: tz }))}
            />
          </Form.Item>
        </Col>
        <Col xs={24} sm={10}>
          <Form.Item name="locale" label="Language">
            <Select
              size="large"
              options={[
                { value: 'en-US', label: 'English (US)' },
                { value: 'en-IN', label: 'English (India)' },
                { value: 'en-GB', label: 'English (UK)' },
                { value: 'de-DE', label: 'Deutsch' },
                { value: 'fr-FR', label: 'Français' },
                { value: 'es-ES', label: 'Español' },
              ]}
            />
          </Form.Item>
        </Col>
      </Row>
    </>
  );
}

// ---------------------------------------------------------------------------
// Step 3 — your company
// ---------------------------------------------------------------------------

export function CompanyStep({ country }: { country: string }) {
  return (
    <>
      <Form.Item
        name={['organization', 'name']}
        label="Company name"
        rules={[{ required: true, message: 'Enter your company name' }]}
      >
        <Input size="large" prefix={<BankOutlined />} placeholder="Your company name" autoComplete="organization" />
      </Form.Item>

      <Row gutter={12}>
        <Col xs={24} sm={12}>
          <Form.Item
            name={['organization', 'legalName']}
            label="Legal name"
            extra="What the invoice says."
          >
            <Input size="large" placeholder="Registered legal entity name" autoComplete="off" />
          </Form.Item>
        </Col>
        <Col xs={24} sm={12}>
          <Form.Item name={['organization', 'website']} label="Website">
            <Input size="large" placeholder="https://example.com" autoComplete="off" />
          </Form.Item>
        </Col>
        <Col xs={24} sm={12}>
          <Form.Item name={['organization', 'industry']} label="Industry">
            <Select
              size="large"
              showSearch
              options={INDUSTRIES.map((i) => ({ value: i, label: i }))}
            />
          </Form.Item>
        </Col>
        <Col xs={24} sm={12}>
          <Form.Item name={['organization', 'size']} label="Company size">
            <Select size="large" options={SIZES.map((s) => ({ value: s, label: `${s} people` }))} />
          </Form.Item>
        </Col>
      </Row>

      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        Registered address
      </Typography.Text>
      <div style={{ marginTop: 8 }}>
        <AddressForm namePrefix={['organization', 'address']} />
      </div>

      <Row gutter={12}>
        <Col xs={24} sm={12}>
          <Form.Item name={['organization', 'taxId']} label={taxIdLabel(country)}>
            <Input size="large" autoComplete="off" />
          </Form.Item>
        </Col>
        <Col xs={24} sm={12}>
          <Form.Item
            name={['organization', 'billingEmail']}
            label="Billing email"
            rules={[{ type: 'email', message: 'That email looks wrong' }]}
            extra="Leave blank to use your work email."
          >
            <Input size="large" autoComplete="off" />
          </Form.Item>
        </Col>
      </Row>

      <Form.Item
        name="acceptedTerms"
        valuePropName="checked"
        rules={[
          {
            validator: (_, value) =>
              value ? Promise.resolve() : Promise.reject(new Error('Please accept the terms')),
          },
        ]}
      >
        <Checkbox>
          I agree to the <Typography.Link>Terms of Service</Typography.Link> and{' '}
          <Typography.Link>Privacy Policy</Typography.Link>.
        </Checkbox>
      </Form.Item>

      <Form.Item name="marketingOptIn" valuePropName="checked">
        <Checkbox>Send me product updates. (Optional — we don&apos;t share your details.)</Checkbox>
      </Form.Item>
    </>
  );
}

export function scorePassword(pw: string): { percent: number; label: string } {
  if (!pw) return { percent: 0, label: '' };
  let score = 0;
  if (pw.length >= 10) score += 35;
  if (pw.length >= 16) score += 20;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score += 15;
  if (/\d/.test(pw)) score += 15;
  if (/[^\w\s]/.test(pw)) score += 15;
  const percent = Math.min(100, score);
  return { percent, label: percent < 50 ? 'Weak' : percent < 80 ? 'Good' : 'Strong' };
}
