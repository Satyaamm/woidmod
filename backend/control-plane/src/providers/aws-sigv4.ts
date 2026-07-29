/**
 * AWS Signature Version 4, extracted so the Bedrock LLM adapter and the Bedrock
 * embedder sign identically.
 *
 * This was private to `adapters/bedrock-llm.ts` until a second caller needed it.
 * Copying it would have been the worse option by some distance: a signing bug is
 * invisible until every request 403s with `SignatureDoesNotMatch`, and two copies
 * drift the moment one is fixed.
 *
 * VERIFIED 2026-07-29 against
 * https://docs.aws.amazon.com/general/latest/gr/sigv4-create-canonical-request.html
 */

import { createHash, createHmac } from 'node:crypto';

const ALGORITHM = 'AWS4-HMAC-SHA256';

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** Present only for STS/assumed-role credentials. */
  sessionToken?: string;
  region: string;
}

/**
 * SigV4 canonicalisation encodes each path segment TWICE for every service
 * except S3. A Bedrock model id contains `:` which is already `%3A` in the path,
 * so the canonical form must carry `%253A` or the signature will not match —
 * the single most common cause of `SignatureDoesNotMatch` against Bedrock.
 */
export function canonicalPath(path: string): string {
  return path
    .split('/')
    .map((segment) => (segment ? uriEncode(segment) : segment))
    .join('/');
}

/** RFC 3986 unreserved set only — `encodeURIComponent` leaves !'()* alone. */
export function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

/**
 * Headers for a signed POST. `host` is deliberately omitted from the RESULT — it
 * is a forbidden header for `fetch` to set — while remaining inside the signature,
 * which is where it matters.
 */
export function signedPostHeaders(input: {
  host: string;
  path: string;
  payload: string;
  service: string;
  credentials: SigV4Credentials;
  now?: Date;
}): Record<string, string> {
  const { credentials: creds, service } = input;
  const now = input.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // 20240101T000000Z
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(input.payload);

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    host: input.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  if (creds.sessionToken) headers['x-amz-security-token'] = creds.sessionToken;

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${(headers[name] ?? '').trim()}\n`)
    .join('');
  const signedHeaders = signedHeaderNames.join(';');

  const canonicalRequest = [
    'POST',
    canonicalPath(input.path),
    '', // no query string
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${creds.region}/${service}/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmac(`AWS4${creds.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, creds.region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = hmac(kSigning, stringToSign).toString('hex');

  headers['authorization'] =
    `${ALGORITHM} Credential=${creds.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  delete headers['host'];
  return headers;
}
