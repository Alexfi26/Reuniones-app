import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { authorizeWithLoopback, createPkce, type OAuthProviderConfig } from '../src/auth/oauth.js';
import { NativeHelperAudioCapture } from '../src/recording/audioCapture.js';
import { WhisperCppProvider, OpenAITranscriptionProvider, buildWavHeader } from '../src/transcription/transcription.js';
import { GoogleDocsService, TABLE_PLACEHOLDER, type RenderedDocument } from '../src/google/googleDocs.js';
import { AuthError } from '../src/core/errors.js';
import { jsonResponse, tempDir } from './helpers.js';

function script(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe('OAuth 2.0 con PKCE y redirección loopback', () => {
  test('el desafío PKCE es el SHA-256 en base64url del verificador', () => {
    const { verifier, challenge } = createPkce();
    assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'));
    assert.ok(verifier.length >= 43);
  });

  test('completa el flujo: URL de autorización con PKCE, state validado y intercambio del código', async () => {
    const config: OAuthProviderConfig = {
      provider: 'google',
      clientId: 'cid',
      authorizeUrl: 'https://accounts.example/auth',
      tokenUrl: 'https://tokens.example/token',
      redirectHost: '127.0.0.1',
      scopes: ['openid', 'email'],
      extraAuthParams: { access_type: 'offline' },
    };
    let exchangeBody = new URLSearchParams();
    const fakeFetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      exchangeBody = new URLSearchParams(String(init?.body));
      return jsonResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 });
    }) as typeof fetch;

    const tokens = await authorizeWithLoopback(config, {
      fetchImpl: fakeFetch,
      onAuthorizationUrl: async (url) => {
        const authUrl = new URL(url);
        assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
        assert.equal(authUrl.searchParams.get('scope'), 'openid email');
        assert.equal(authUrl.searchParams.get('access_type'), 'offline');
        const redirect = authUrl.searchParams.get('redirect_uri')!;
        const state = authUrl.searchParams.get('state')!;
        // El navegador del usuario vuelve al loopback con el código.
        const back = await fetch(`${redirect}?code=codigo-de-prueba&state=${state}`);
        assert.equal(back.status, 200);
      },
    });
    assert.equal(tokens.refreshToken, 'rt');
    assert.equal(exchangeBody.get('code'), 'codigo-de-prueba');
    assert.ok(exchangeBody.get('code_verifier'));
  });

  test('un state que no coincide cancela la autorización', async () => {
    const config: OAuthProviderConfig = { provider: 'microsoft', clientId: 'cid', authorizeUrl: 'https://a/x', tokenUrl: 'https://t/x', redirectHost: 'localhost', scopes: ['openid'] };
    await assert.rejects(
      authorizeWithLoopback(config, {
        fetchImpl: (async () => jsonResponse({})) as typeof fetch,
        timeoutMs: 2000,
        onAuthorizationUrl: async (url) => {
          const redirect = new URL(url).searchParams.get('redirect_uri')!;
          await fetch(`${redirect}?code=x&state=otro`);
        },
      }),
      AuthError,
    );
  });
});

describe('helper nativo de captura (protocolo JSON por línea)', () => {
  test('consulta permisos y graba hasta recibir el comando de parada', async () => {
    const dir = tempDir();
    const helper = script(
      dir,
      'helper.mjs',
      `
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'permissions') {
  console.log(JSON.stringify({ event: 'permissions', microphone: 'granted', systemAudio: 'undetermined' }));
  process.exit(0);
}
const out = args[args.indexOf('--out') + 1];
console.log(JSON.stringify({ event: 'started' }));
process.stdin.on('data', (chunk) => {
  if (String(chunk).includes('"stop"')) {
    writeFileSync(out, 'audio');
    console.log(JSON.stringify({ event: 'finished', path: out, durationMs: 1234 }));
    process.exit(0);
  }
});
`,
    );
    const capture = new NativeHelperAudioCapture(helper, 5000, 5000);
    assert.deepEqual(await capture.checkPermissions(), { microphone: 'granted', systemAudio: 'undetermined' });

    const session = await capture.start({ outputPath: join(dir, 'a.wav'), sources: ['microphone', 'system'] });
    const result = await session.stop();
    assert.equal(result.durationMs, 1234);
    assert.equal(result.path, join(dir, 'a.wav'));
  });

  test('si el helper no existe, no simula nada: permisos «unsupported» y error al iniciar', async () => {
    const capture = new NativeHelperAudioCapture('/no/existe/helper');
    assert.equal((await capture.checkPermissions()).microphone, 'unsupported');
    await assert.rejects(capture.start({ outputPath: '/tmp/x.wav', sources: ['microphone'] }), /helper nativo/);
  });
});

describe('transcripción local con whisper.cpp (binario simulado)', () => {
  test('lee el JSON de salida y convierte offsets en milisegundos', async () => {
    const dir = tempDir();
    const binary = script(
      dir,
      'whisper.mjs',
      `
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const prefix = args[args.indexOf('-of') + 1];
writeFileSync(prefix + '.json', JSON.stringify({ result: { language: 'es' }, transcription: [
  { offsets: { from: 0, to: 1500 }, text: ' Hola a todos ' },
  { offsets: { from: 1500, to: 2000 }, text: '   ' },
] }));
`,
    );
    const model = join(dir, 'model.bin');
    writeFileSync(model, 'x');
    const wav = join(dir, 'audio.wav');
    writeFileSync(wav, buildWavHeader(0, 16000, 1, 16));
    const transcript = await new WhisperCppProvider(binary, model, dir).transcribe(wav, { language: 'es' });
    assert.equal(transcript.language, 'es');
    assert.deepEqual(transcript.segments, [{ startMs: 0, endMs: 1500, text: 'Hola a todos', speaker: null }]);
  });
});

describe('transcripción en la nube (OpenAI) con troceado', () => {
  test('trocea el audio, desplaza los tiempos de cada trozo y no inventa hablantes', async () => {
    const dir = tempDir();
    const data = Buffer.alloc(16_000 * 2 * 2, 0); // 2 s
    const wav = join(dir, 'audio.wav');
    writeFileSync(wav, Buffer.concat([buildWavHeader(data.length, 16_000, 1, 16), data]));
    let requests = 0;
    const fakeFetch = (async () => {
      requests++;
      return jsonResponse({ language: 'es', segments: [{ start: 0.5, end: 0.9, text: ' hola ' }] });
    }) as typeof fetch;
    const transcript = await new OpenAITranscriptionProvider('sk-test', fakeFetch, 'https://api.example/v1', 1).transcribe(wav, { language: 'es' });
    assert.equal(requests, 2);
    assert.deepEqual(transcript.segments.map((s) => s.startMs), [500, 1500]);
    assert.ok(transcript.segments.every((s) => s.speaker === null));
  });
});

describe('Google Docs: orden de peticiones y tabla', () => {
  test('las celdas se rellenan de atrás hacia delante para que los índices no cambien', async () => {
    const batches: { requests: Record<string, unknown>[] }[] = [];
    const getQueue: object[] = [
      { body: { documentId: 'd', title: '', content: [{ endIndex: 1 }] } },
      { body: { content: [{ startIndex: 1, endIndex: 3, paragraph: { elements: [{ textRun: { content: TABLE_PLACEHOLDER + '\n' } }] } }] } },
      { body: { content: [{ startIndex: 1, endIndex: 80, table: { tableRows: [0, 1, 2].map((r) => ({ tableCells: [0, 1].map((c) => ({ content: [{ startIndex: 100 + r * 10 + c * 4 }] })) })) } }] } },
      { body: { content: [{ paragraph: { elements: [{ textRun: { content: 'Resumen ejecutivo\n' } }] } }] } },
    ];
    const fakeFetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith(':batchUpdate')) {
        batches.push(JSON.parse(String(init?.body)));
        return jsonResponse({});
      }
      return jsonResponse(getQueue.shift() ?? {});
    }) as typeof fetch;
    const docs = new GoogleDocsService(async () => 'token', fakeFetch, 'https://docs.example/v1');
    const content: RenderedDocument = {
      blocks: [{ kind: 'title', text: 'Comité' }, { kind: 'table' }],
      table: { headers: ['Tarea', 'Responsable'], rows: [['Enviar', 'No definido'], ['Revisar', 'Luis']] },
    };
    await docs.writeDocument('d', content);

    const fills = batches.at(-1)!.requests.map((r) => (r.insertText as { location: { index: number }; text: string }));
    const indexes = fills.map((f) => f.location.index);
    assert.deepEqual(indexes, [...indexes].sort((a, b) => b - a), 'índices en orden descendente');
    assert.ok(fills.some((f) => f.text === 'Luis'));
    assert.equal(batches.length, 3);
  });
});
