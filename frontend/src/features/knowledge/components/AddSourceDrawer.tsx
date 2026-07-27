'use client';

import { useState } from 'react';
import { InboxOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  Divider,
  Drawer,
  Flex,
  Form,
  Input,
  InputNumber,
  Segmented,
  Slider,
  Switch,
  Tooltip,
  Typography,
  Upload,
  message,
} from 'antd';
import { RETRIEVAL_DEFAULTS, type CreateKnowledgeSourceInput, type KnowledgeSourceType } from '@/lib/contract';

interface FormShape {
  name: string;
  url: string;
  crawlDepth: number;
  maxPages: number;
  excludePaths: string;
  refreshIntervalHours: number | null;
  respectRobotsTxt: boolean;
  autoRefresh: boolean;
  text: string;
  topK: number;
  similarityThreshold: number;
}

const DEFAULTS: FormShape = {
  name: '',
  url: '',
  crawlDepth: 1,
  maxPages: 200,
  excludePaths: '',
  refreshIntervalHours: 24,
  respectRobotsTxt: true,
  autoRefresh: true,
  text: '',
  topK: RETRIEVAL_DEFAULTS.topK,
  similarityThreshold: RETRIEVAL_DEFAULTS.similarityThreshold,
};

/**
 * Add-source drawer. Three types behind a segmented control rather than three
 * separate buttons — the retrieval settings underneath are shared, and this is
 * where they get their defaults.
 */
export function AddSourceDrawer({
  open,
  onClose,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (input: CreateKnowledgeSourceInput) => Promise<void>;
}) {
  const [form] = Form.useForm<FormShape>();
  const [type, setType] = useState<KnowledgeSourceType>('url');
  const [submitting, setSubmitting] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);

  const close = () => {
    form.resetFields();
    setFileName(null);
    setType('url');
    onClose();
  };

  const submit = async () => {
    const values = await form.validateFields();
    setSubmitting(true);
    try {
      await onCreate({
        name: values.name,
        type,
        url:
          type === 'url'
            ? {
                url: values.url,
                crawlDepth: values.crawlDepth,
                maxPages: values.maxPages,
                excludePaths: (values.excludePaths ?? '')
                  .split('\n')
                  .map((s) => s.trim())
                  .filter(Boolean),
                refreshIntervalHours: values.autoRefresh ? values.refreshIntervalHours : null,
                respectRobotsTxt: values.respectRobotsTxt,
              }
            : undefined,
        text: type === 'text' ? values.text : undefined,
        fileUploadId: type === 'file' && fileName ? `upl_local_${fileName}` : undefined,
        retrieval: { topK: values.topK, similarityThreshold: values.similarityThreshold },
      });
      close();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Drawer
      open={open}
      onClose={close}
      width={560}
      title="Add a knowledge source"
      destroyOnHidden
      extra={
        <Flex gap={8}>
          <Button onClick={close}>Cancel</Button>
          <Button type="primary" loading={submitting} onClick={submit}>
            Add source
          </Button>
        </Flex>
      }
    >
      <Form<FormShape> form={form} layout="vertical" initialValues={DEFAULTS} requiredMark={false}>
        <Segmented<KnowledgeSourceType>
          block
          value={type}
          onChange={setType}
          options={[
            { value: 'url', label: 'Website' },
            { value: 'file', label: 'File' },
            { value: 'text', label: 'Text' },
          ]}
          style={{ marginBottom: 18 }}
        />

        <Form.Item
          name="name"
          label="Name"
          rules={[{ required: true, message: 'Give it a name you will recognise in a list of twenty.' }]}
        >
          <Input placeholder="Help centre, Tariff PDF, Escalation policy…" />
        </Form.Item>

        {type === 'url' && (
          <>
            <Form.Item
              name="url"
              label="Start URL"
              rules={[
                { required: true, message: 'A URL is required.' },
                { type: 'url', message: 'That does not look like a URL.' },
              ]}
            >
              <Input placeholder="https://docs.example.com/help" />
            </Form.Item>

            <Form.Item
              name="crawlDepth"
              label="Crawl depth"
              extra="0 crawls only the start URL. 1 follows links on it. 2 follows links on those. Depth 3+ on a large site is usually a mistake."
            >
              <Slider
                min={0}
                max={4}
                marks={{ 0: 'page', 1: '1', 2: '2', 3: '3', 4: '4' }}
                tooltip={{ formatter: (v) => (v === 0 ? 'This page only' : `${v} level${v === 1 ? '' : 's'} deep`) }}
              />
            </Form.Item>

            <Form.Item name="maxPages" label="Page limit">
              <InputNumber min={1} max={5000} style={{ width: 160 }} />
            </Form.Item>

            <Form.Item
              name="excludePaths"
              label="Exclude paths"
              extra="One glob per line, matched against the path. Changelogs, archives and paginated indexes are the usual offenders."
            >
              <Input.TextArea rows={3} placeholder={'/blog/*\n/*/print\n/archive/**'} />
            </Form.Item>

            <Flex gap={20} wrap>
              <Form.Item name="autoRefresh" label="Auto re-crawl" valuePropName="checked">
                <Switch />
              </Form.Item>
              <Form.Item
                noStyle
                shouldUpdate={(prev, next) => prev.autoRefresh !== next.autoRefresh}
              >
                {({ getFieldValue }) => (
                  <Form.Item name="refreshIntervalHours" label="Every (hours)">
                    <InputNumber min={1} max={720} disabled={!getFieldValue('autoRefresh')} style={{ width: 120 }} />
                  </Form.Item>
                )}
              </Form.Item>
              <Form.Item name="respectRobotsTxt" label="Obey robots.txt" valuePropName="checked">
                <Switch />
              </Form.Item>
            </Flex>
          </>
        )}

        {type === 'file' && (
          <Form.Item label="File">
            <Upload.Dragger
              multiple={false}
              maxCount={1}
              accept=".pdf,.txt,.md,.docx,.csv,.html"
              beforeUpload={(file) => {
                setFileName(file.name);
                form.setFieldValue('name', form.getFieldValue('name') || file.name);
                message.info('Upload is fixtured — the file is not sent anywhere.');
                return false;
              }}
              onRemove={() => setFileName(null)}
            >
              <p className="ant-upload-drag-icon">
                <InboxOutlined />
              </p>
              <p className="ant-upload-text">PDF, DOCX, Markdown, HTML, CSV or plain text</p>
              <p className="ant-upload-hint">Up to 50 MB. Scanned PDFs are OCR'd, which takes longer.</p>
            </Upload.Dragger>
          </Form.Item>
        )}

        {type === 'text' && (
          <Form.Item
            name="text"
            label="Content"
            rules={[{ required: true, message: 'Paste something.' }]}
            extra="Markdown headings become chunk labels, so ## sections are worth keeping."
          >
            <Input.TextArea rows={12} placeholder="# Escalation policy&#10;&#10;Transfer to a human when…" />
          </Form.Item>
        )}

        <Divider style={{ margin: '6px 0 14px' }} />

        <Typography.Text strong style={{ fontSize: 12 }}>
          Retrieval
        </Typography.Text>
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 2 }}>
          Both are tunable later, and you can see their effect on the source's retrieval preview.
        </Typography.Paragraph>

        <Flex gap={24} wrap>
          <Form.Item
            name="topK"
            label={
              <Tooltip title="How many chunks are handed to the model per query. More context costs tokens and latency.">
                <span>Chunks to retrieve</span>
              </Tooltip>
            }
            extra="Default 3"
          >
            <InputNumber min={1} max={20} style={{ width: 120 }} />
          </Form.Item>
          <Form.Item
            name="similarityThreshold"
            label={
              <Tooltip title="Cosine floor. A chunk scoring below this is dropped even if nothing better exists — better silence than a confident wrong answer.">
                <span>Similarity threshold</span>
              </Tooltip>
            }
            extra="Default 0.60"
          >
            <InputNumber min={0} max={1} step={0.05} style={{ width: 120 }} />
          </Form.Item>
        </Flex>

        <Alert
          type="info"
          showIcon
          style={{ marginTop: 4 }}
          message="Adding a source does not attach it to an agent"
          description="Sources are workspace-level. Attach them per agent on the agent's Knowledge tab, so a test agent can use a draft KB without touching production."
        />
      </Form>
    </Drawer>
  );
}
