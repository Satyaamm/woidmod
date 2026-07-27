'use client';

import { Col, Form, Input, Row, Select } from 'antd';
import { COUNTRIES, flag } from './PhoneInput';

/**
 * Structured postal address — never a freeform textarea (docs/10 §Fields
 * collected). Collected when a payment method is added, because that's when
 * it's self-evidently needed for the invoice.
 */
export function AddressForm({
  namePrefix = 'address',
}: {
  /** String or path array, e.g. `['organization', 'address']` for a nested form. */
  namePrefix?: string | string[];
}) {
  const path = Array.isArray(namePrefix) ? namePrefix : [namePrefix];
  return (
    <Row gutter={12}>
      <Col span={24}>
        <Form.Item
          name={[...path, 'line1']}
          label="Address line 1"
          rules={[{ required: true, message: 'Street address is required' }]}
        >
          <Input placeholder="Street address" autoComplete="address-line1" />
        </Form.Item>
      </Col>
      <Col span={24}>
        <Form.Item name={[...path, 'line2']} label="Address line 2">
          <Input placeholder="Floor, suite, unit (optional)" autoComplete="address-line2" />
        </Form.Item>
      </Col>
      <Col xs={24} sm={12}>
        <Form.Item
          name={[...path, 'city']}
          label="City"
          rules={[{ required: true, message: 'City is required' }]}
        >
          <Input autoComplete="address-level2" />
        </Form.Item>
      </Col>
      <Col xs={24} sm={12}>
        <Form.Item name={[...path, 'state']} label="State / province">
          <Input autoComplete="address-level1" />
        </Form.Item>
      </Col>
      <Col xs={24} sm={12}>
        <Form.Item
          name={[...path, 'postalCode']}
          label="Postal code"
          rules={[{ required: true, message: 'Postal code is required' }]}
        >
          <Input autoComplete="postal-code" />
        </Form.Item>
      </Col>
      <Col xs={24} sm={12}>
        <Form.Item
          name={[...path, 'country']}
          label="Country"
          rules={[{ required: true, message: 'Country is required' }]}
        >
          <Select
            showSearch
            optionFilterProp="searchText"
            placeholder="Select a country"
            options={COUNTRIES.map((c) => ({
              value: c.code,
              label: `${flag(c.code)}  ${c.name}`,
              searchText: c.name,
            }))}
          />
        </Form.Item>
      </Col>
    </Row>
  );
}
