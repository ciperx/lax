/**
 * LAX jobs client tests. One test per acceptance item, named A1 to A7.
 * No network: the client takes an injected fetch and sleep.
 * Run: npx tsx jobs.test.ts
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { createJobsClient, LaxJobsError } from './src/jobs.js';

type Call = { url: string; init: RequestInit | undefined };

const BASE = 'https://lax.kognai.ai/registry';
const ADDRESS = '0x27EbD1DDCB6607bE8641784A1bf654623Fc8290e';
const DID = `did:pkh:eip155:8453:${ADDRESS}`;

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

function recorder(): { sleep: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms: number): Promise<void> => {
      waits.push(ms);
    },
  };
}

const submissionInput = {
  builder: 'ciperx',
  contact: 'agent@example.com',
  repo_or_patch_url: 'https://github.com/ciperx/lax',
  payout_address: ADDRESS,
  agent_did: DID,
};

// A1: listJobs, getJob and submit send the documented requests and return the parsed answers.
async function a1RequestsAndParsedAnswers(): Promise<void> {
  const list = fakeFetch([response({ jobs: [{ id: 'a' }, { id: 'b' }], count: 2 })]);
  const client = createJobsClient({ fetch: list.fetch, sleep: recorder().sleep });
  const out = await client.listJobs({ track: 'coding', limit: 5, offset: 10 });
  assert.equal(list.calls.length, 1);
  assert.equal(list.calls[0]?.url, `${BASE}/jobs?track=coding&limit=5&offset=10`);
  assert.equal(list.calls[0]?.init?.method, 'GET');
  assert.equal(out.count, 2);
  assert.deepEqual(out.jobs.map((job) => job.id), ['a', 'b']);

  const empty = fakeFetch([response({ jobs: [] })]);
  const client2 = createJobsClient({ fetch: empty.fetch, sleep: recorder().sleep });
  assert.deepEqual(await client2.listJobs(), { jobs: [], count: 0 });
  assert.equal(empty.calls[0]?.url, `${BASE}/jobs`);

  const read = fakeFetch([response({ job: { id: 'x/y', title: 'enc' } })]);
  const client3 = createJobsClient({ fetch: read.fetch, sleep: recorder().sleep });
  const job = await client3.getJob('x/y');
  assert.equal(job.title, 'enc');
  assert.equal(read.calls[0]?.url, `${BASE}/jobs/x%2Fy`);

  const post = fakeFetch([
    response({ submission: { id: 's1', job_id: 'j1', status: 'submitted', created_at: 'now' } }),
  ]);
  const client4 = createJobsClient({ fetch: post.fetch, sleep: recorder().sleep });
  const sent = await client4.submit('j1', submissionInput);
  assert.equal(post.calls[0]?.url, `${BASE}/jobs/j1/submissions`);
  assert.equal(post.calls[0]?.init?.method, 'POST');
  const headers = post.calls[0]?.init?.headers as Record<string, string>;
  assert.equal(headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(String(post.calls[0]?.init?.body)), submissionInput);
  assert.equal(sent.id, 's1');
  assert.equal(sent.status, 'submitted');
}

// A2: a 400, 404 or 409 answer throws LaxJobsError with that status, its code and the registry message, after one request.
async function a2ClientErrorsAreNotRetried(): Promise<void> {
  const cases: Array<[number, string]> = [
    [400, 'bad_request'],
    [404, 'not_found'],
    [409, 'conflict'],
  ];
  for (const [status, code] of cases) {
    const probe = fakeFetch([response({ error: `registry says ${status}` }, status)]);
    const client = createJobsClient({ fetch: probe.fetch, sleep: recorder().sleep, retries: 2 });
    await assert.rejects(
      () => client.getJob('j1'),
      (error: unknown) =>
        error instanceof LaxJobsError &&
        error.status === status &&
        error.code === code &&
        error.message === `registry says ${status}`,
    );
    assert.equal(probe.calls.length, 1);
  }
}

// A3: a 429 is retried after its Retry-After and then succeeds, and when it never ends the last retry throws rate_limited.
async function a3RetryAfterAndRateLimited(): Promise<void> {
  const once = fakeFetch([
    response({ error: 'slow down' }, 429, { 'retry-after': '2' }),
    response({ jobs: [{ id: 'a' }], count: 1 }),
  ]);
  const onceSleep = recorder();
  const client = createJobsClient({ fetch: once.fetch, sleep: onceSleep.sleep, retries: 2 });
  const out = await client.listJobs();
  assert.equal(out.count, 1);
  assert.equal(once.calls.length, 2);
  assert.deepEqual(onceSleep.waits, [2000]);

  const forever = fakeFetch([response({ error: 'slow down' }, 429, { 'retry-after': '999' })]);
  const foreverSleep = recorder();
  const client2 = createJobsClient({ fetch: forever.fetch, sleep: foreverSleep.sleep, retries: 2 });
  await assert.rejects(
    () => client2.listJobs(),
    (error: unknown) => error instanceof LaxJobsError && error.status === 429 && error.code === 'rate_limited',
  );
  assert.equal(forever.calls.length, 3);
  assert.deepEqual(foreverSleep.waits, [30000, 30000]);
}

// A4: a 5xx answer or a network error on a read is retried and then throws server or network, and submit is not retried on them.
async function a4ServerAndNetworkRetries(): Promise<void> {
  const server = fakeFetch([response({ error: 'boom' }, 503)]);
  const serverSleep = recorder();
  const client = createJobsClient({ fetch: server.fetch, sleep: serverSleep.sleep, retries: 2 });
  await assert.rejects(
    () => client.listJobs(),
    (error: unknown) => error instanceof LaxJobsError && error.status === 503 && error.code === 'server',
  );
  assert.equal(server.calls.length, 3);
  assert.deepEqual(serverSleep.waits, [500, 1000]);

  const net = fakeFetch([new Error('socket hang up')]);
  const client2 = createJobsClient({ fetch: net.fetch, sleep: recorder().sleep, retries: 2 });
  await assert.rejects(
    () => client2.listJobs(),
    (error: unknown) => error instanceof LaxJobsError && error.status === 0 && error.code === 'network',
  );
  assert.equal(net.calls.length, 3);

  const postServer = fakeFetch([response({ error: 'boom' }, 500)]);
  const client3 = createJobsClient({ fetch: postServer.fetch, sleep: recorder().sleep, retries: 2 });
  await assert.rejects(
    () => client3.submit('j1', submissionInput),
    (error: unknown) => error instanceof LaxJobsError && error.status === 500 && error.code === 'server',
  );
  assert.equal(postServer.calls.length, 1);

  const postNet = fakeFetch([new Error('reset')]);
  const client4 = createJobsClient({ fetch: postNet.fetch, sleep: recorder().sleep, retries: 2 });
  await assert.rejects(
    () => client4.submit('j1', submissionInput),
    (error: unknown) => error instanceof LaxJobsError && error.code === 'network',
  );
  assert.equal(postNet.calls.length, 1);
}

// A5: submit refuses a missing agent_did, a bad payout address or a link that is not https before any request, with code invalid_input.
async function a5InputChecksBeforeRequest(): Promise<void> {
  const probe = fakeFetch([response({ submission: { id: 'never' } })]);
  const client = createJobsClient({ fetch: probe.fetch, sleep: recorder().sleep });
  const bad: Array<Record<string, unknown>> = [
    { ...submissionInput, agent_did: undefined },
    { ...submissionInput, agent_did: 'agent-42' },
    { ...submissionInput, payout_address: '0x123' },
    { ...submissionInput, payout_address: '27EbD1DDCB6607bE8641784A1bf654623Fc8290e' },
    { ...submissionInput, repo_or_patch_url: 'http://insecure.example/x' },
    { ...submissionInput, repo_or_patch_url: 'ftp://insecure.example/x' },
    { ...submissionInput, contact: '' },
    { ...submissionInput, builder: '   ' },
  ];
  for (const input of bad) {
    await assert.rejects(
      () => client.submit('j1', input as typeof submissionInput),
      (error: unknown) => error instanceof LaxJobsError && error.code === 'invalid_input' && error.status === 0,
    );
  }
  assert.equal(probe.calls.length, 0);
}

// A6: no new runtime dependency and no console output from the client.
async function a6NoDependencyNoConsole(): Promise<void> {
  const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), []);

  const source = readFileSync(new URL('./src/jobs.ts', import.meta.url), 'utf8');
  assert.equal(/console\s*\./.test(source), false);
  assert.equal(/process\.stdout|process\.stderr/.test(source), false);
  assert.equal(/from '(?!\.)/.test(source.replace(/from 'node:/g, "from '")), false);
}

// A7: one integration test reads the live GET /jobs and runs only when LAX_LIVE=1 is set.
async function a7LiveJobs(): Promise<void> {
  if (process.env.LAX_LIVE !== '1') {
    console.log('skip A7 live GET /jobs (set LAX_LIVE=1 to run it)');
    return;
  }
  const client = createJobsClient({ timeoutMs: 20000 });
  const out = await client.listJobs({ limit: 1 });
  assert.equal(Array.isArray(out.jobs), true);
  assert.equal(typeof out.count, 'number');
  console.log(`live A7: ${out.count} jobs, first ${out.jobs[0]?.id ?? 'none'}`);
}

const tests: Array<[string, () => Promise<void>]> = [
  ['A1 listJobs, getJob and submit send the documented requests and return the parsed answers', a1RequestsAndParsedAnswers],
  ['A2 a 400, 404 or 409 answer throws LaxJobsError with its status, code and message after one request', a2ClientErrorsAreNotRetried],
  ['A3 a 429 is retried after Retry-After and then succeeds, and ends as rate_limited', a3RetryAfterAndRateLimited],
  ['A4 reads retry on 5xx and network errors, submit does not', a4ServerAndNetworkRetries],
  ['A5 submit refuses a bad agent_did, payout address or link before any request', a5InputChecksBeforeRequest],
  ['A6 no runtime dependency and no console output from the client', a6NoDependencyNoConsole],
  ['A7 the live GET /jobs runs only when LAX_LIVE=1', a7LiveJobs],
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
