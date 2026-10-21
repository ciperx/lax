/**
 * Jobs client tests: no network, fetch is injected.
 * Run: npx tsx jobs.test.ts
 */

import { strict as assert } from 'node:assert';
import { createJobsClient, LaxJobsError } from './src/jobs.js';

type Call = { url: string; init: RequestInit | undefined };

function response(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, { status, headers: { 'content-type': 'application/json', ...headers } });
}

function fakeFetch(answers: Array<Response | Error>): { fetch: typeof globalThis.fetch; calls: Call[] } {
  const calls: Call[] = [];
  let index = 0;
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init });
    const answer = answers[Math.min(index, answers.length - 1)];
    index += 1;
    if (answer instanceof Error) throw answer;
    if (!answer) throw new Error('no answer queued');
    return answer.clone();
  };
  return { fetch: impl as unknown as typeof globalThis.fetch, calls };
}

const noSleep = async (): Promise<void> => {};

async function testListJobsBuildsQuery(): Promise<void> {
  const { fetch, calls } = fakeFetch([response({ jobs: [{ id: 'a' }], count: 1 })]);
  const client = createJobsClient({ fetch, sleep: noSleep });
  const out = await client.listJobs({ track: 'coding', limit: 5, offset: 10 });
  assert.equal(out.count, 1);
  assert.equal(out.jobs.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, 'https://lax.kognai.ai/registry/jobs?track=coding&limit=5&offset=10');
}

async function testListJobsOmitsEmptyQuery(): Promise<void> {
  const { fetch, calls } = fakeFetch([response({ jobs: [] })]);
  const client = createJobsClient({ fetch, sleep: noSleep });
  const out = await client.listJobs();
  assert.deepEqual(out, { jobs: [], count: 0 });
  assert.equal(calls[0]?.url, 'https://lax.kognai.ai/registry/jobs');
}

async function testLimitValidation(): Promise<void> {
  const { fetch, calls } = fakeFetch([response({})]);
  const client = createJobsClient({ fetch, sleep: noSleep });
  for (const limit of [0, 101, 2.5]) {
    await assert.rejects(
      () => client.listJobs({ limit }),
      (error: unknown) => error instanceof LaxJobsError && error.code === 'invalid_input' && error.status === 0,
    );
  }
  assert.equal(calls.length, 0);
}

async function testGetJobUnwrapsAndEncodes(): Promise<void> {
  const { fetch, calls } = fakeFetch([response({ job: { id: 'x/y' } })]);
  const client = createJobsClient({ fetch, sleep: noSleep });
  const job = await client.getJob('x/y');
  assert.equal(job.id, 'x/y');
  assert.equal(calls[0]?.url, 'https://lax.kognai.ai/registry/jobs/x%2Fy');
}

async function testReadRetriesOn500(): Promise<void> {
  const { fetch, calls } = fakeFetch([response({ error: 'boom' }, 500), response({ jobs: [], count: 0 })]);
  const client = createJobsClient({ fetch, sleep: noSleep, retries: 2 });
  const out = await client.listJobs();
  assert.deepEqual(out.jobs, []);
  assert.equal(calls.length, 2);
}

async function testReadGivesUpAfterRetries(): Promise<void> {
  const { fetch, calls } = fakeFetch([response({ error: 'boom' }, 503)]);
  const client = createJobsClient({ fetch, sleep: noSleep, retries: 1 });
  await assert.rejects(
    () => client.listJobs(),
    (error: unknown) => error instanceof LaxJobsError && error.status === 503 && error.code === 'server',
  );
  assert.equal(calls.length, 2);
}

async function testSubmitRetriesOnlyOn429(): Promise<void> {
  const input = {
    builder: 'ciperx',
    contact: 'agent@example.com',
    repo_or_patch_url: 'https://github.com/ciperx/x',
    payout_address: '0x27EbD1DDCB6607bE8641784A1bf654623Fc8290e',
    agent_did: 'did:pkh:eip155:8453:0x27EbD1DDCB6607bE8641784A1bf654623Fc8290e',
  };
  const ok = fakeFetch([
    response({ error: 'slow down' }, 429, { 'retry-after': '1' }),
    response({ submission: { id: 's1', job_id: 'j1', status: 'submitted', created_at: 'now' } }),
  ]);
  const client = createJobsClient({ fetch: ok.fetch, sleep: noSleep, retries: 2 });
  const out = await client.submit('j1', input);
  assert.equal(out.id, 's1');
  assert.equal(ok.calls.length, 2);

  const noRetry = fakeFetch([response({ error: 'conflict' }, 409)]);
  const client2 = createJobsClient({ fetch: noRetry.fetch, sleep: noSleep, retries: 2 });
  await assert.rejects(
    () => client2.submit('j1', input),
    (error: unknown) => error instanceof LaxJobsError && error.code === 'conflict' && error.status === 409,
  );
  assert.equal(noRetry.calls.length, 1);
}

async function testSubmitValidatesBeforeRequest(): Promise<void> {
  const { fetch, calls } = fakeFetch([response({})]);
  const client = createJobsClient({ fetch, sleep: noSleep });
  const base = {
    builder: 'ciperx',
    contact: 'agent@example.com',
    repo_or_patch_url: 'https://github.com/ciperx/x',
    payout_address: '0x27EbD1DDCB6607bE8641784A1bf654623Fc8290e',
    agent_did: 'did:pkh:eip155:8453:0x27EbD1DDCB6607bE8641784A1bf654623Fc8290e',
  };
  const bad = [
    { ...base, agent_did: 'nope' },
    { ...base, payout_address: '0x123' },
    { ...base, repo_or_patch_url: 'http://insecure' },
    { ...base, contact: '' },
  ];
  for (const input of bad) {
    await assert.rejects(
      () => client.submit('j1', input),
      (error: unknown) => error instanceof LaxJobsError && error.code === 'invalid_input',
    );
  }
  assert.equal(calls.length, 0);
}

async function testNetworkErrorIsTyped(): Promise<void> {
  const { fetch } = fakeFetch([new Error('socket hang up')]);
  const client = createJobsClient({ fetch, sleep: noSleep, retries: 0 });
  await assert.rejects(
    () => client.listJobs(),
    (error: unknown) => error instanceof LaxJobsError && error.code === 'network' && error.status === 0,
  );
}

async function testNonJsonSuccessIsInvalidResponse(): Promise<void> {
  const { fetch } = fakeFetch([new Response('not json', { status: 200 })]);
  const client = createJobsClient({ fetch, sleep: noSleep });
  await assert.rejects(
    () => client.listJobs(),
    (error: unknown) => error instanceof LaxJobsError && error.code === 'invalid_response',
  );
}

const tests: Array<[string, () => Promise<void>]> = [
  ['listJobs builds the query from the params it was given', testListJobsBuildsQuery],
  ['listJobs sends no query string when there are no params', testListJobsOmitsEmptyQuery],
  ['limit outside 1 to 100 is refused before any request', testLimitValidation],
  ['getJob encodes the id and unwraps job', testGetJobUnwrapsAndEncodes],
  ['a read retries on 500 and then succeeds', testReadRetriesOn500],
  ['a read stops after the retry budget', testReadGivesUpAfterRetries],
  ['submit retries on 429 but never on 409', testSubmitRetriesOnlyOn429],
  ['submit validates every input before any request', testSubmitValidatesBeforeRequest],
  ['a network failure is a typed error with status 0', testNetworkErrorIsTyped],
  ['a success body that is not JSON is an invalid_response', testNonJsonSuccessIsInvalidResponse],
];

let passed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    passed += 1;
    console.log(`ok ${passed} ${name}`);
  } catch (error) {
    console.error(`not ok ${name}`);
    console.error(error);
    process.exit(1);
  }
}
console.log(`${passed} tests passed`);
