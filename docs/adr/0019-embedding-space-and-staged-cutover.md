# ADR 0019: Paired embedding spaces and staged reindex cutover

Status: proposed (accept after real PostgreSQL/native acceptance gates).

Model names and dimensions leave incompatible revisions, pooling, quantization and query/document instruction pairs indistinguishable. Existing durable batch claims help recovery but do not prove compatible corpus coverage.

Use an explicitly ordered canonical descriptor and SHA-256 fingerprint. Validate it on persisted memory vectors and catalog vectors before comparison. Resolve a neural load fallback to its actual hash identity; do not identify unknown legacy vectors by guessing from labels. Lexical service remains available. Different query/document encoders are an explicit interface contract.

Reuse the current claim/run ledger and retained sources to compute both vector surfaces outside a transaction. Stage by memory and target fingerprint; compare source version and claim ownership. Promote complete provider coverage in one transaction under a bounded short write lock, preserving ready stages after rollback. Report batch and generation completion separately and diagnose claims, stages and compatible backlog.

Consequences: existing vectors need rebuilding; model selection/settings persistence alone is not completion. Old processes become lexical-only after a different space replaces active vectors. 384-dimensional schema remains fixed. Stage storage and a short cutover write pause are costs; interrupted recovery preserves lexical availability and avoids partial replacement of historical vectors.
