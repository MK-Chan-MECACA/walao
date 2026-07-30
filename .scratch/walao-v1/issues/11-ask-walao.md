# 11 — Ask WALAO: grounded Q&A

**What to build:** The user asks natural-language questions like "what did the purchasing group decide yesterday?" and gets an answer grounded exclusively in data from groups they approved, with cited sources on every claim. Retrieval uses PostgreSQL full-text search (pgvector deferred until a measured retrieval gap). Verbatim quotes are allowed only while originals are inside the raw-retention window; beyond it, answers paraphrase from summaries. When approved data doesn't support an answer, the response is a clear "I don't know" — low confidence is never dressed up as fact.

**Blocked by:** 04 — Raw retention & expiry; 06 — Summary generation.

**Status:** ready-for-agent

- [ ] Answers draw only from the asking user's approved groups; a question touching an unapproved group's content returns nothing from it (authz filtering test)
- [ ] Every answer claim carries source citations
- [ ] A question about content past the raw window is answered from summaries in paraphrase, never verbatim
- [ ] Unanswerable questions return an explicit "I don't know" rather than a fabricated answer
- [ ] Question-answering model treats retrieved text as untrusted data; hostile content in messages cannot redirect the answer or trigger actions
