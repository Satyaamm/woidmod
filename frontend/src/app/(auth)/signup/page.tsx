'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeftOutlined, ArrowRightOutlined } from '@ant-design/icons';
import { Alert, Button, Flex, Form, Steps, Typography } from 'antd';
import { authApi } from '@/lib/api';
import type { PhoneNumberValue, PostalAddress, SignUpInput } from '@/lib/contract';
import { AuthLayout } from '@/features/auth/components/AuthLayout';
import { SsoButtons } from '@/features/auth/components/SsoButtons';
import { CompanyStep, ContactStep, IdentityStep } from '@/features/auth/signupSteps';

interface SignupFormValues {
  firstName: string;
  familyName: string;
  email: string;
  jobTitle?: string;
  password: string;
  country: string;
  phone: PhoneNumberValue;
  timezone: string;
  locale: string;
  organization: {
    name: string;
    legalName?: string;
    website?: string;
    industry?: string;
    size?: SignUpInput['organization']['size'];
    address: PostalAddress;
    taxId?: string;
    billingEmail?: string;
  };
  acceptedTerms: boolean;
  marketingOptIn?: boolean;
}

const STEPS = [
  { title: 'Your details', fields: ['firstName', 'familyName', 'email', 'password'] },
  { title: 'Contact', fields: ['country', 'phone', 'timezone', 'locale'] },
  { title: 'Company', fields: [['organization', 'name'], 'acceptedTerms'] },
] as const;

/** Browser-detected defaults — never ask for what you can infer (docs/11 §4). */
function detectDefaults() {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const locale = typeof navigator !== 'undefined' ? navigator.language : 'en-US';
  const country = locale.split('-')[1]?.toUpperCase() ?? (timezone.startsWith('Asia/Kolkata') ? 'IN' : 'US');
  return { timezone, locale, country };
}

export default function SignupPage() {
  const router = useRouter();
  const [form] = Form.useForm<SignupFormValues>();
  const [step, setStep] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const defaults = typeof window === 'undefined' ? { timezone: 'UTC', locale: 'en-US', country: 'US' } : detectDefaults();
  const [country, setCountry] = useState(defaults.country);

  const next = async () => {
    try {
      await form.validateFields(STEPS[step]!.fields as never);
      setStep((s) => s + 1);
      setError(null);
    } catch {
      /* antd shows the field errors inline */
    }
  };

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const values = await form.validateFields();
      const payload: SignUpInput = {
        email: values.email,
        password: values.password,
        firstName: values.firstName,
        familyName: values.familyName,
        jobTitle: values.jobTitle,
        phone: values.phone,
        country: values.country,
        timezone: values.timezone,
        locale: values.locale,
        organization: {
          ...values.organization,
          billingEmail: values.organization.billingEmail || values.email,
        },
        marketingOptIn: Boolean(values.marketingOptIn),
        acceptedTermsAt: new Date().toISOString(),
      };
      await authApi.signUp(payload);
      router.push(`/verify-email?email=${encodeURIComponent(payload.email)}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthLayout
      title="Create your account"
      subtitle="Three short steps. Everything here goes on your invoices and compliance records, so it's worth getting right once."
    >
      <Steps
        size="small"
        current={step}
        items={STEPS.map((s) => ({ title: s.title }))}
        style={{ marginBottom: 24 }}
      />

      {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} />}

      {step === 0 && <SsoButtons label="or sign up with email" />}

      <Form<SignupFormValues>
        form={form}
        layout="vertical"
        requiredMark={false}
        scrollToFirstError
        initialValues={{
          timezone: defaults.timezone,
          locale: defaults.locale,
          country: defaults.country,
          phone: { countryCode: defaults.country, dialCode: '', number: '' },
          organization: { address: { country: defaults.country } },
          marketingOptIn: false,
        }}
        onValuesChange={(changed) => {
          if (changed.password !== undefined) setPassword(changed.password);
          if (changed.country) setCountry(changed.country);
        }}
      >
        {/* All steps stay mounted so nothing is lost when stepping back. */}
        <div hidden={step !== 0}>
          <IdentityStep password={password} />
        </div>
        <div hidden={step !== 1}>
          <ContactStep country={country} />
        </div>
        <div hidden={step !== 2}>
          <CompanyStep country={country} />
        </div>

        <Flex gap={10} style={{ marginTop: 8 }}>
          {step > 0 && (
            <Button size="large" icon={<ArrowLeftOutlined />} onClick={() => setStep((s) => s - 1)}>
              Back
            </Button>
          )}
          {step < STEPS.length - 1 ? (
            <Button type="primary" size="large" block onClick={next}>
              Continue <ArrowRightOutlined />
            </Button>
          ) : (
            <Button type="primary" size="large" block loading={submitting} onClick={submit}>
              Create account
            </Button>
          )}
        </Flex>
      </Form>

      <Typography.Paragraph type="secondary" style={{ marginTop: 20, textAlign: 'center' }}>
        Already have an account? <Link href="/login">Log in</Link>
      </Typography.Paragraph>
    </AuthLayout>
  );
}
