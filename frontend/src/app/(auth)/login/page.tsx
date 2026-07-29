'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { LockOutlined, MailOutlined } from '@ant-design/icons';
import { Alert, Button, Checkbox, Flex, Form, Input, Typography } from 'antd';
import { AuthLayout } from '@/features/auth/components/AuthLayout';
import { SsoButtons } from '@/features/auth/components/SsoButtons';
import { useSessionStore } from '@/stores/session-store';

interface LoginForm {
  email: string;
  password: string;
  remember: boolean;
}

export default function LoginPage() {
  const router = useRouter();
  const logIn = useSessionStore((s) => s.logIn);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onFinish = async (values: LoginForm) => {
    setSubmitting(true);
    setError(null);
    try {
      await logIn({ email: values.email, password: values.password }, values.remember);
      const session = useSessionStore.getState().session;
      // currentWorkspaceId is null on a fresh login (no workspace header sent yet),
      // so fall back to the first workspace in the current org. Never route to
      // bare `/orgs` — there is no page there.
      const org = session?.organizations.find((o) => o.id === session.currentOrgId) ?? session?.organizations[0];
      const ws =
        session?.workspaces.find((w) => w.id === session.currentWorkspaceId) ??
        session?.workspaces.find((w) => w.orgId === org?.id);
      if (org && ws) router.push(`/orgs/${org.slug}/${ws.slug}`);
      else if (org) router.push(`/orgs/${org.slug}/workspaces`);
      else router.push('/login');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthLayout title="Log in" subtitle="Welcome back.">
      {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} />}

      <SsoButtons />

      <Form<LoginForm> layout="vertical" onFinish={onFinish} requiredMark={false} initialValues={{ remember: true }}>
        <Form.Item
          name="email"
          label="Work email"
          rules={[{ required: true, message: 'Enter your email' }, { type: 'email', message: 'That email looks wrong' }]}
        >
          <Input size="large" prefix={<MailOutlined />} placeholder="you@example.com" autoComplete="email" autoFocus />
        </Form.Item>

        <Form.Item name="password" label="Password" rules={[{ required: true, message: 'Enter your password' }]}>
          <Input.Password size="large" prefix={<LockOutlined />} placeholder="••••••••" autoComplete="current-password" />
        </Form.Item>

        <Flex justify="space-between" align="center" style={{ marginBottom: 18 }}>
          <Form.Item name="remember" valuePropName="checked" noStyle>
            <Checkbox>Keep me signed in</Checkbox>
          </Form.Item>
          <Link href="/forgot-password">Forgot password?</Link>
        </Flex>

        <Button type="primary" size="large" htmlType="submit" block loading={submitting}>
          Log in
        </Button>
      </Form>

      <Typography.Paragraph type="secondary" style={{ marginTop: 22, textAlign: 'center' }}>
        New here? <Link href="/signup">Create an account</Link>
      </Typography.Paragraph>
    </AuthLayout>
  );
}
