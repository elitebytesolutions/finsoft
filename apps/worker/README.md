# apps/worker

Background jobs and queue consumers (BullMQ). **Built by FND-011** — this is a
placeholder directory so the workspace layout matches ARCHITECTURE.md §2.

Its first job is the transactional outbox dispatcher (ADR-0010): rows written
inside the posting transaction, dispatched after it commits. Emails, PDFs, FBR
pushes, webhooks and cache invalidation all go through it.

A closed fiscal period rejects a posting from here exactly as it does from the
API. There is no system bypass (ADR-0012).
