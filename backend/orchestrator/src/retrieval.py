"""In-process retrieval for grounding a call on the workspace knowledge base (RAG).

The whole (capped) corpus rides in the call config, so retrieval happens locally per
turn — no round trip on the hot path. Scoring is lexical cosine over token sets: it
mirrors the control-plane's dashboard "Retrieval preview" (TF-IDF-ish), so what an
operator tests in the UI is what grounds the call. A real embeddings/pgvector backend
is a drop-in replacement for `top_chunks` — same signature, better recall.
"""

from __future__ import annotations

import math
import re
from typing import Any

_WORD = re.compile(r"[a-z0-9]+")
# Words too common to carry retrieval signal — dropped so a question like
# "what is your return policy" ranks on "return"/"policy", not "what"/"is"/"your".
_STOP = {
    "the", "a", "an", "and", "or", "of", "to", "is", "are", "was", "were", "be",
    "in", "on", "at", "for", "with", "what", "who", "how", "do", "does", "did",
    "i", "you", "your", "my", "we", "it", "this", "that", "can", "could", "would",
    "please", "tell", "me", "about", "have", "has",
}


def _tokens(text: str) -> list[str]:
    return [w for w in _WORD.findall(text.lower()) if w not in _STOP and len(w) > 1]


def top_chunks(query: str, chunks: list[dict[str, Any]], k: int = 3) -> list[dict[str, Any]]:
    """Return the k chunks most relevant to `query` (lexical cosine), best first.

    Empty query or no overlap → empty list, so an off-topic turn injects nothing.
    """
    q = _tokens(query)
    if not q or not chunks:
        return []
    q_set = set(q)

    scored: list[tuple[float, dict[str, Any]]] = []
    for ch in chunks:
        t = _tokens(str(ch.get("text", "")))
        if not t:
            continue
        t_set = set(t)
        overlap = len(q_set & t_set)
        if overlap == 0:
            continue
        # Cosine over token sets: rewards matches, normalises for chunk length.
        score = overlap / (math.sqrt(len(q_set)) * math.sqrt(len(t_set)))
        scored.append((score, ch))

    scored.sort(key=lambda pair: pair[0], reverse=True)
    return [ch for _, ch in scored[:k]]
