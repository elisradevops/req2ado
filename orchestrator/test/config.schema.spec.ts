import { configSchema } from '../src/config/config.schema';

const BASE_ENV = {
  DATABASE_URL: 'postgresql://req2ado:req2ado@localhost:5432/req2ado',
  REDIS_URL: 'redis://localhost:6379',
  MCP_URL: 'http://localhost:4100',
  MCP_BEARER: 'test-bearer',
  AUTH_JWT_SECRET: 'test-jwt-secret',
  LLM_BASE_URL: 'http://localhost:11434/v1',
  LLM_CHAT_MODEL: 'llama3.1',
  LLM_PROXY_BEARER: 'test-llm-proxy-bearer',
  EMBED_MODEL: 'nomic-embed-text',
};

describe('configSchema LLM fields', () => {
  it('parses valid LLM config with defaults for optional fields', () => {
    const result = configSchema.parse(BASE_ENV);
    expect(result.LLM_BASE_URL).toBe('http://localhost:11434/v1');
    expect(result.LLM_CHAT_MODEL).toBe('llama3.1');
    expect(result.LLM_TRUSTED_LOCAL).toBe(false);
    expect(result.LLM_PROXY_BEARER).toBe('test-llm-proxy-bearer');
  });

  it('rejects missing LLM_BASE_URL', () => {
    const { LLM_BASE_URL, ...rest } = BASE_ENV;
    expect(() => configSchema.parse(rest)).toThrow();
  });

  it('rejects missing LLM_PROXY_BEARER', () => {
    const { LLM_PROXY_BEARER, ...rest } = BASE_ENV;
    expect(() => configSchema.parse(rest)).toThrow();
  });

  it('coerces LLM_TRUSTED_LOCAL=true from a string env value', () => {
    const result = configSchema.parse({ ...BASE_ENV, LLM_TRUSTED_LOCAL: 'true' });
    expect(result.LLM_TRUSTED_LOCAL).toBe(true);
  });

  it('parses LLM_TRUSTED_LOCAL=false as boolean false, not true', () => {
    const result = configSchema.parse({ ...BASE_ENV, LLM_TRUSTED_LOCAL: 'false' });
    expect(result.LLM_TRUSTED_LOCAL).toBe(false);
  });
});

describe('configSchema embed fields', () => {
  const BASE_ENV_WITH_LLM = {
    DATABASE_URL: 'postgresql://req2ado:req2ado@localhost:5432/req2ado',
    REDIS_URL: 'redis://localhost:6379',
    MCP_URL: 'http://localhost:4100',
    MCP_BEARER: 'test-bearer',
    AUTH_JWT_SECRET: 'test-jwt-secret',
    LLM_BASE_URL: 'http://localhost:11434/v1',
    LLM_CHAT_MODEL: 'llama3.1',
    LLM_PROXY_BEARER: 'test-llm-proxy-bearer',
    EMBED_MODEL: 'nomic-embed-text',
  };

  it('defaults EMBED_TRANSPORT to ollama', () => {
    const result = configSchema.parse(BASE_ENV_WITH_LLM);
    expect(result.EMBED_TRANSPORT).toBe('ollama');
  });

  it('accepts an explicit EMBED_TRANSPORT of openai', () => {
    const result = configSchema.parse({ ...BASE_ENV_WITH_LLM, EMBED_TRANSPORT: 'openai' });
    expect(result.EMBED_TRANSPORT).toBe('openai');
  });

  it('rejects an invalid EMBED_TRANSPORT value', () => {
    expect(() => configSchema.parse({ ...BASE_ENV_WITH_LLM, EMBED_TRANSPORT: 'bogus' })).toThrow();
  });

  it('rejects missing EMBED_MODEL', () => {
    const { EMBED_MODEL, ...rest } = BASE_ENV_WITH_LLM;
    expect(() => configSchema.parse(rest)).toThrow();
  });

  it('leaves EMBED_BASE_URL undefined when not set', () => {
    const result = configSchema.parse(BASE_ENV_WITH_LLM);
    expect(result.EMBED_BASE_URL).toBeUndefined();
  });

  it('defaults EMBED_PATH to /api/embed when unset', () => {
    const result = configSchema.parse(BASE_ENV_WITH_LLM);
    expect(result.EMBED_PATH).toBe('/api/embed');
  });

  it('respects an explicit EMBED_PATH override', () => {
    const result = configSchema.parse({ ...BASE_ENV_WITH_LLM, EMBED_PATH: '/ollama/api/embed' });
    expect(result.EMBED_PATH).toBe('/ollama/api/embed');
  });
});
