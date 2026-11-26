import { config } from '../config/config.js';
import { localEmbed, normalize } from './embeddings.js';

// The embedder id is part of every cache key: vectors from different models must never be compared.
export const embedderId = { local: 'local-hash-256', openai: 'oai-te3s-256', ollama: `ollama-${config.OLLAMA_EMBED_MODEL}` }[config.EMBEDDINGS];

let oai;
async function model() {
  if (!oai) {
    const { OpenAIEmbeddings } = await import('@langchain/openai');
    oai = config.EMBEDDINGS === 'ollama'
      ? new OpenAIEmbeddings({ model: config.OLLAMA_EMBED_MODEL, apiKey: 'ollama', configuration: { baseURL: `${config.OLLAMA_BASE_URL}/v1` }, timeout: config.EMBED_TIMEOUT_MS, maxRetries: 0 })
      : new OpenAIEmbeddings({ model: 'text-embedding-3-small', dimensions: 256, apiKey: config.OPENAI_API_KEY, timeout: config.EMBED_TIMEOUT_MS, maxRetries: 0 });
  }
  return oai;
}

const clip = (t) => t.slice(0, 2000);

export async function embed(text) {
  if (config.EMBEDDINGS === 'local') return localEmbed(text);
  return normalize(Float32Array.from(await (await model()).embedQuery(clip(text))));
}

export async function embedMany(texts) {
  if (config.EMBEDDINGS === 'local') return texts.map(localEmbed);
  const vs = await (await model()).embedDocuments(texts.map(clip));
  return vs.map((v) => normalize(Float32Array.from(v)));
}
