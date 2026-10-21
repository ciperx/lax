/**
 * LAX jobs client: list jobs, read one job, submit work.
 * fetch only, no runtime dependency.
 */

export const LAX_REGISTRY_BASE = 'https://lax.kognai.ai/registry';

export type LaxJobsErrorCode =
  | 'invalid_input'
  | 'bad_request'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'server'
  | 'network'
  | 'invalid_response';

export class LaxJobsError extends Error {
  readonly status: number;
  readonly code: LaxJobsErrorCode;

  constructor(message: string, status: number, code: LaxJobsErrorCode) {
    super(message);
    this.name = 'LaxJobsError';
    this.status = status;
    this.code = code;
  }
}

export interface Job {
  id: string;
  title?: string;
  track?: string;
  summary?: string;
  spec_md?: string;
  spec_url?: string;
  tests_url?: string;
  skills?: string[];
  bounty_usdc?: number;
  currency?: string;
  chain?: string;
  deadline?: string;
  status?: string;
  bid_closes?: string;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export interface JobsClientOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

export interface ListJobsParams {
  track?: string;
  limit?: number;
  offset?: number;
}

export interface ListJobsResult {
  jobs: Job[];
  count: number;
}

export interface SubmitInput {
  builder: string;
  contact: string;
  repo_or_patch_url: string;
  payout_address: string;
  agent_did: string;
  notes?: string;
}

export interface SubmitResult {
  id: string;
  job_id: string;
  status: string;
  created_at: string;
  [key: string]: unknown;
}

export interface JobsClient {
  listJobs(params?: ListJobsParams): Promise<ListJobsResult>;
  getJob(id: string): Promise<Job>;
  submit(jobId: string, input: SubmitInput): Promise<SubmitResult>;
}

const DID = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/i;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const HTTPS = /^https:\/\/\S+$/i;

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function codeForStatus(status: number): LaxJobsErrorCode {
  if (status === 400 || status === 422) return 'bad_request';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server';
  return 'bad_request';
}

function retryAfterMs(headers: unknown): number | undefined {
  const h = headers as { get?: (name: string) => string | null } | undefined;
  const raw = h && typeof h.get === 'function' ? h.get('retry-after') : null;
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(30_000, seconds * 1000);
}

function errorText(payload: unknown, fallback: string): string {
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    for (const key of ['error', 'message', 'detail', 'title']) {
      const value = obj[key];
      if (typeof value === 'string' && value.trim().length > 0) return value;
    }
  }
  return fallback;
}

/**
 * Create a jobs client bound to one registry base URL.
 */
export function createJobsClient(options: JobsClientOptions = {}): JobsClient {
  const baseUrl = (options.baseUrl ?? LAX_REGISTRY_BASE).replace(/\/+$/, '');
  const doFetch = options.fetch ?? globalThis.fetch;
  const retries = Math.max(0, Math.trunc(options.retries ?? 2));
  const sleep = options.sleep ?? defaultSleep;
  const timeoutMs = Math.max(1, Math.trunc(options.timeoutMs ?? 15_000));

  async function request<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    retryableStatuses: number[],
    retryNetwork: boolean,
  ): Promise<T> {
    const attempts = retries + 1;
    let lastError: LaxJobsError | undefined;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
      const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;

      let response: Response;
      try {
        response = await doFetch(baseUrl + path, {
          method,
          headers:
            body === undefined
              ? { accept: 'application/json' }
              : { accept: 'application/json', 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller?.signal,
        });
      } catch (error) {
        if (timer !== undefined) clearTimeout(timer);
        const message = error instanceof Error ? error.message : 'network request failed';
        lastError = new LaxJobsError(message, 0, 'network');
        if (retryNetwork && attempt + 1 < attempts) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        throw lastError;
      }
      if (timer !== undefined) clearTimeout(timer);

      const text = await response.text();
      let payload: unknown;
      if (text.length > 0) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = undefined;
        }
      }

      if (response.ok) {
        if (payload === undefined) {
          throw new LaxJobsError('registry answered with a body that is not JSON', response.status, 'invalid_response');
        }
        return payload as T;
      }

      const message = errorText(payload, `registry answered ${response.status}`);
      const code = codeForStatus(response.status);
      lastError = new LaxJobsError(message, response.status, code);

      const canRetry = retryableStatuses.includes(response.status);
      if (canRetry && attempt + 1 < attempts) {
        const wait = retryAfterMs(response.headers) ?? 500 * 2 ** attempt;
        await sleep(wait);
        continue;
      }
      throw lastError;
    }

    throw lastError ?? new LaxJobsError('request failed', 0, 'network');
  }

  async function listJobs(params: ListJobsParams = {}): Promise<ListJobsResult> {
    const query: string[] = [];
    if (params.track !== undefined) query.push(`track=${encodeURIComponent(params.track)}`);
    if (params.limit !== undefined) {
      if (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > 100) {
        throw new LaxJobsError('limit must be an integer from 1 to 100', 0, 'invalid_input');
      }
      query.push(`limit=${params.limit}`);
    }
    if (params.offset !== undefined) {
      if (!Number.isInteger(params.offset) || params.offset < 0) {
        throw new LaxJobsError('offset must be a non negative integer', 0, 'invalid_input');
      }
      query.push(`offset=${params.offset}`);
    }
    const path = query.length > 0 ? `/jobs?${query.join('&')}` : '/jobs';
    const payload = await request<{ jobs?: Job[]; count?: number }>('GET', path, undefined, [429, 500, 502, 503, 504], true);
    const jobs = payload.jobs ?? [];
    return { jobs, count: payload.count ?? jobs.length };
  }

  async function getJob(id: string): Promise<Job> {
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new LaxJobsError('job id is required', 0, 'invalid_input');
    }
    const payload = await request<{ job?: Job }>('GET', `/jobs/${encodeURIComponent(id)}`, undefined, [429, 500, 502, 503, 504], true);
    if (!payload.job) {
      throw new LaxJobsError('registry answered without a job', 0, 'invalid_response');
    }
    return payload.job;
  }

  async function submit(jobId: string, input: SubmitInput): Promise<SubmitResult> {
    if (typeof jobId !== 'string' || jobId.trim().length === 0) {
      throw new LaxJobsError('job id is required', 0, 'invalid_input');
    }
    if (!input || typeof input !== 'object') {
      throw new LaxJobsError('submission input is required', 0, 'invalid_input');
    }
    if (typeof input.agent_did !== 'string' || !DID.test(input.agent_did)) {
      throw new LaxJobsError('agent_did must look like did:method:identifier', 0, 'invalid_input');
    }
    if (typeof input.payout_address !== 'string' || !ADDRESS.test(input.payout_address)) {
      throw new LaxJobsError('payout_address must be 0x followed by 40 hex characters', 0, 'invalid_input');
    }
    if (typeof input.repo_or_patch_url !== 'string' || !HTTPS.test(input.repo_or_patch_url)) {
      throw new LaxJobsError('repo_or_patch_url must be an https URL', 0, 'invalid_input');
    }
    for (const field of ['builder', 'contact'] as const) {
      if (typeof input[field] !== 'string' || input[field].trim().length === 0) {
        throw new LaxJobsError(`${field} is required`, 0, 'invalid_input');
      }
    }

    const body: Record<string, unknown> = {
      builder: input.builder,
      contact: input.contact,
      repo_or_patch_url: input.repo_or_patch_url,
      payout_address: input.payout_address,
      agent_did: input.agent_did,
    };
    if (input.notes !== undefined) body.notes = input.notes;

    const payload = await request<{ submission?: SubmitResult }>(
      'POST',
      `/jobs/${encodeURIComponent(jobId)}/submissions`,
      body,
      [429],
      false,
    );
    if (!payload.submission) {
      throw new LaxJobsError('registry answered without a submission', 0, 'invalid_response');
    }
    return payload.submission;
  }

  return { listJobs, getJob, submit };
}
