/**
 * Single source of truth for the embedding model identities this project
 * currently supports, so upgrading a model id or its vector width is a
 * one-file change instead of a lockstep edit across `embedding.ts`,
 * `embedding-neural.ts`, `postgres.ts`, `config-file.ts`, and tests -- all
 * of which independently redefined these same literals before.
 *
 * `EMBEDDING_DIMENSIONS` covers both models today because
 * `remem.memory_embeddings` is a fixed-width `vector(384)` column
 * (migration `0002`/`0005`): switching either model to a different
 * dimensionality requires a dedicated schema migration, not just a
 * constant change here.
 */
export const LOCAL_HASH_MODEL_ID = "remem-local-hash-v1"
export const NEURAL_MODEL_ID = "bge-small-en-v1.5"
export const HUGGING_FACE_MODEL = "Xenova/bge-small-en-v1.5"
export const EMBEDDING_DIMENSIONS = 384
