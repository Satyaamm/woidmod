'use client';

import { useState } from 'react';
import { App, Button, Card, Col, Form, Input, Row, Select } from 'antd';
import { PageHeader } from '@/components/common/PageHeader';
import { PhoneInput } from '@/components/common/PhoneInput';
import { FormSkeleton } from '@/components/common/Skeletons';
import { meApi } from '@/lib/api';
import type { PhoneNumberValue, UpdateProfileInput, User } from '@/lib/contract';
import { useSessionStore } from '@/stores/session-store';

/** IANA zones from the platform, same source the signup contact step uses. */
const TIMEZONES = Intl.supportedValuesOf?.('timeZone') ?? ['UTC'];

const LOCALES = [
  { value: 'en-US', label: 'English (US)' },
  { value: 'en-IN', label: 'English (India)' },
  { value: 'en-GB', label: 'English (UK)' },
  { value: 'de-DE', label: 'Deutsch' },
  { value: 'fr-FR', label: 'Français' },
  { value: 'es-ES', label: 'Español' },
];

interface ProfileFormValues {
  firstName: string;
  familyName: string;
  phone?: PhoneNumberValue;
  jobTitle?: string;
  timezone?: string;
  locale?: string;
  avatarUrl?: string;
}

export default function AccountProfilePage() {
  const { message } = App.useApp();
  // The whole session is read so a save can rewrite just `user` on it — the shell
  // avatar/name then update without a full session reload.
  const session = useSessionStore((s) => s.session);
  const setSession = useSessionStore((s) => s.setSession);
  const user = session?.user ?? null;

  const [saving, setSaving] = useState(false);

  const onFinish = async (values: ProfileFormValues) => {
    const phone = values.phone?.number ? values.phone : undefined;
    const body: UpdateProfileInput = {
      firstName: values.firstName.trim(),
      familyName: values.familyName.trim(),
      phone,
      jobTitle: values.jobTitle?.trim() || undefined,
      timezone: values.timezone || undefined,
      locale: values.locale || undefined,
      avatarUrl: values.avatarUrl?.trim() || undefined,
    };

    setSaving(true);
    try {
      const updated: User = await meApi.update(body);
      if (session) setSession({ ...session, user: updated });
      message.success('Profile updated');
    } catch (err) {
      message.error((err as Error).message || 'Could not update your profile');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PageHeader title="Account" subtitle="Your profile — shared across every organization you belong to." />
      <Card>
        {!user ? (
          <FormSkeleton fields={6} />
        ) : (
          <Form<ProfileFormValues>
            layout="vertical"
            requiredMark={false}
            style={{ maxWidth: 640 }}
            initialValues={{
              firstName: user.firstName,
              familyName: user.familyName,
              phone: user.phone,
              jobTitle: user.jobTitle,
              timezone: user.timezone,
              locale: user.locale,
              avatarUrl: user.avatarUrl,
            }}
            onFinish={onFinish}
          >
            <Row gutter={12}>
              <Col xs={24} sm={12}>
                <Form.Item
                  name="firstName"
                  label="First name"
                  rules={[{ required: true, message: 'First name is required' }]}
                >
                  <Input autoComplete="given-name" />
                </Form.Item>
              </Col>
              <Col xs={24} sm={12}>
                <Form.Item
                  name="familyName"
                  label="Family name"
                  rules={[{ required: true, message: 'Family name is required' }]}
                >
                  <Input autoComplete="family-name" />
                </Form.Item>
              </Col>
            </Row>

            <Form.Item
              name="phone"
              label="Phone"
              extra="Used for account recovery and to verify live calling."
            >
              <PhoneInput defaultCountry={user.phone?.countryCode ?? 'US'} />
            </Form.Item>

            <Form.Item name="jobTitle" label="Job title">
              <Input autoComplete="organization-title" />
            </Form.Item>

            <Row gutter={12}>
              <Col xs={24} sm={14}>
                <Form.Item name="timezone" label="Timezone">
                  <Select showSearch options={TIMEZONES.map((tz) => ({ value: tz, label: tz }))} />
                </Form.Item>
              </Col>
              <Col xs={24} sm={10}>
                <Form.Item name="locale" label="Language">
                  <Select options={LOCALES} />
                </Form.Item>
              </Col>
            </Row>

            <Form.Item
              name="avatarUrl"
              label="Avatar URL"
              rules={[{ type: 'url', message: 'Enter a valid URL' }]}
            >
              <Input placeholder="https://…" autoComplete="photo" />
            </Form.Item>

            <Form.Item style={{ marginBottom: 0 }}>
              <Button type="primary" htmlType="submit" loading={saving}>
                Save changes
              </Button>
            </Form.Item>
          </Form>
        )}
      </Card>
    </>
  );
}
