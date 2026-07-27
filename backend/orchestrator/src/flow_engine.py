"""Flow execution — the runtime half of the visual builder.

The control plane compiles the xyflow graph to a `FlowSpec` and validates it
(`validateFlow`). This engine EXECUTES it: it walks nodes, holds the collected
variables, evaluates condition branches, and picks the next node from the edge whose
`sourceHandle` matches the outcome of the current step.

It is deliberately a pure state machine with NO I/O and NO LiveKit dependency — the
agent loop drives it (run the LLM turn this node describes, then tell the engine what
happened), which is exactly what makes it unit-testable without a live call. The
node types and their `data`/handle semantics mirror
`backend/control-plane/src/domain/flow-schema.ts` one-for-one.

Condition expressions (`when`) are evaluated with an AST whitelist — comparisons and
boolean ops over the collected variables only. No function calls, no attribute
access, no `eval`. A malformed or unsafe expression evaluates to False rather than
throwing, so a bad branch fails closed to the `default` exit.
"""

from __future__ import annotations

import ast
import logging
from dataclasses import dataclass, field
from typing import Any, Optional

log = logging.getLogger("woidmod.flow")

# Node types with no outgoing edge — the conversation ends there.
TERMINAL_TYPES = {"end", "handoff"}
VIDEO_TYPES = {"escalate_video", "vision", "avatar", "screen_share"}


@dataclass
class FlowNode:
    id: str
    type: str
    data: dict[str, Any] = field(default_factory=dict)


@dataclass
class FlowEdge:
    id: str
    source: str
    target: str
    source_handle: Optional[str] = None


class FlowSpec:
    """Parsed, indexed flow. `from_dict` accepts the JSON the control plane sends."""

    def __init__(self, entry_node_id: str, nodes: list[FlowNode], edges: list[FlowEdge]):
        self.entry_node_id = entry_node_id
        self.nodes: dict[str, FlowNode] = {n.id: n for n in nodes}
        self.edges: list[FlowEdge] = edges

    @classmethod
    def from_dict(cls, spec: dict[str, Any]) -> "FlowSpec":
        nodes = [
            FlowNode(id=n["id"], type=n["type"], data=n.get("data") or {})
            for n in spec.get("nodes", [])
        ]
        edges = [
            FlowEdge(
                id=e["id"],
                source=e["source"],
                target=e["target"],
                source_handle=e.get("sourceHandle"),
            )
            for e in spec.get("edges", [])
        ]
        return cls(entry_node_id=spec["entryNodeId"], nodes=nodes, edges=edges)

    def outgoing(self, node_id: str) -> list[FlowEdge]:
        return [e for e in self.edges if e.source == node_id]


# ---------------------------------------------------------------------------
# Safe expression evaluation for condition branches
# ---------------------------------------------------------------------------

_ALLOWED_NODES = (
    ast.Expression,
    ast.BoolOp, ast.And, ast.Or, ast.UnaryOp, ast.Not,
    ast.Compare, ast.Eq, ast.NotEq, ast.Lt, ast.LtE, ast.Gt, ast.GtE,
    ast.Name, ast.Load, ast.Constant,
    ast.BinOp, ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Mod,
)


def safe_eval(expression: str, variables: dict[str, Any]) -> bool:
    """Evaluate a branch `when` over the variables. Fails closed (False) on anything
    unexpected — a broken expression must never crash a live call."""
    if not expression or not expression.strip():
        return False
    # The builder uses JS-style operators; normalise to Python before parsing.
    normalised = (
        expression.replace("&&", " and ").replace("||", " or ").replace("!==", "!=").replace("===", "==")
    )
    try:
        tree = ast.parse(normalised, mode="eval")
        for node in ast.walk(tree):
            if not isinstance(node, _ALLOWED_NODES):
                log.warning("flow condition rejected (unsafe node %s): %r", type(node).__name__, expression)
                return False
        # Names resolve to variables; unknown names resolve to None (fail closed).
        result = eval(  # noqa: S307 - AST is whitelisted above; no builtins exposed
            compile(tree, "<flow-condition>", "eval"),
            {"__builtins__": {}},
            _DefaultingVars(variables),
        )
        return bool(result)
    except Exception as exc:  # noqa: BLE001 - any failure is a False branch, never a crash
        log.warning("flow condition error %r: %s", expression, exc)
        return False


class _DefaultingVars(dict):
    """Unknown variable names read as None instead of raising NameError."""

    def __missing__(self, key: str) -> None:  # type: ignore[override]
        return None


# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------

@dataclass
class Step:
    """What the agent loop should do next for the current node."""

    node: FlowNode
    # The composed instruction for an LLM turn (say/collect), if this node runs one.
    instruction: Optional[str] = None
    # True when the node expects a caller reply before advancing.
    expects_reply: bool = False
    # True when this node ends the conversation.
    terminal: bool = False


class FlowEngine:
    """Executes a FlowSpec. The agent loop calls `begin()`, then after handling each
    node calls `advance(handle)` (or `route_condition()` for branches) to move on."""

    def __init__(self, spec: FlowSpec, base_prompt: str = ""):
        self.spec = spec
        self.base_prompt = base_prompt
        self.variables: dict[str, Any] = {}
        self.current_id: str = spec.entry_node_id
        self.finished = False

    # -- introspection --------------------------------------------------------

    def current(self) -> FlowNode:
        return self.spec.nodes[self.current_id]

    def is_terminal(self, node: Optional[FlowNode] = None) -> bool:
        node = node or self.current()
        return node.type in TERMINAL_TYPES

    def set_variable(self, name: str, value: Any) -> None:
        self.variables[name] = value

    # -- lifecycle ------------------------------------------------------------

    def begin(self) -> Step:
        """Enter the flow. The Start node is a no-op, so we step straight to the first
        actionable node."""
        node = self.current()
        if node.type == "start":
            self._advance_single()
        return self.step()

    def step(self) -> Step:
        """Describe the current node for the agent loop."""
        node = self.current()
        return Step(
            node=node,
            instruction=self._instruction(node),
            expects_reply=self._expects_reply(node),
            terminal=self.is_terminal(node),
        )

    def route_condition(self) -> str:
        """For a condition node, evaluate branches and return the chosen handle
        (a branch id or 'default'). The first branch whose `when` is true wins."""
        node = self.current()
        assert node.type == "condition"
        for branch in node.data.get("branches", []):
            if safe_eval(branch.get("when", ""), self.variables):
                return branch["id"]
        return "default"

    def advance(self, handle: Optional[str] = None) -> Step:
        """Move to the next node along the edge matching `handle` (or the sole edge
        when the node has one exit). Returns the new node's Step. Idempotent once the
        flow finishes."""
        if self.finished:
            return self.step()
        node = self.current()
        if self.is_terminal(node):
            self.finished = True
            return self.step()

        edges = self.spec.outgoing(self.current_id)
        chosen: Optional[FlowEdge] = None
        if handle is not None:
            chosen = next((e for e in edges if e.source_handle == handle), None)
        if chosen is None:
            # Single-exit node, or no handle given: take the first edge with no handle,
            # else the first edge at all.
            chosen = next((e for e in edges if e.source_handle is None), None) or (
                edges[0] if edges else None
            )
        if chosen is None:
            # No path out — validation should have caught this; fail closed to done.
            log.warning("flow node %s has no outgoing edge; ending flow", self.current_id)
            self.finished = True
            return self.step()

        self.current_id = chosen.target
        if self.is_terminal():
            self.finished = True
        return self.step()

    # -- internals ------------------------------------------------------------

    def _advance_single(self) -> None:
        edges = self.spec.outgoing(self.current_id)
        edge = next((e for e in edges if e.source_handle is None), None) or (edges[0] if edges else None)
        if edge:
            self.current_id = edge.target

    def _expects_reply(self, node: FlowNode) -> bool:
        if node.type == "collect":
            return True
        if node.type == "say":
            return bool(node.data.get("expectReply", True))
        if node.type in ("verify", "escalate_video"):
            return True
        return False

    def video_action(self, node: Optional[FlowNode] = None) -> Optional[dict[str, Any]]:
        """For a video node, the concrete side-effect the agent loop performs on the
        vision/avatar pipeline. None for non-video nodes. This is how the builder's
        video nodes actually DO something on a video call:

          vision        → {'action':'look', target, instruction, resultVar}
                          → VisionProcessor.request_look(instruction)
          avatar        → {'action':'avatar', enabled}  → AvatarOutput.set_enabled()
          screen_share  → {'action':'screen_share', direction, url}
          escalate_video→ {'action':'escalate', requireConsent}  (offer, then switch tracks)
        """
        node = node or self.current()
        d = node.data
        if node.type == "vision":
            return {
                "action": "look",
                "target": d.get("target", "camera"),
                "instruction": d.get("instruction", ""),
                "resultVar": d.get("resultVar"),
            }
        if node.type == "avatar":
            return {"action": "avatar", "enabled": bool(d.get("enabled", True))}
        if node.type == "screen_share":
            return {"action": "screen_share", "direction": d.get("direction", "agent"), "url": d.get("url")}
        if node.type == "escalate_video":
            return {"action": "escalate", "requireConsent": bool(d.get("requireConsent", True))}
        return None

    def _instruction(self, node: FlowNode) -> Optional[str]:
        """Compose the LLM instruction for nodes that run a conversational turn.
        Deterministic/structural nodes (tool, condition, payment, video, terminal)
        return None — the agent loop handles those without a free-form turn."""
        base = self.base_prompt.strip()
        if node.type == "say":
            body = node.data.get("prompt") or node.data.get("text") or ""
            return f"{base}\n\n[Now: {body}]".strip()
        if node.type == "collect":
            slot = node.data.get("slot", "value")
            prompt = node.data.get("prompt", f"Ask the caller for {slot}.")
            confirm = " Read the value back to confirm it before continuing." if node.data.get("confirm") else ""
            return (
                f"{base}\n\n[Now collect '{slot}': {prompt}{confirm} "
                f"Once you have it, stop asking.]"
            ).strip()
        if node.type == "verify":
            method = node.data.get("method", "otp")
            return f"{base}\n\n[Verify the caller via {method}. Do not proceed until it passes.]".strip()
        if node.type == "escalate_video":
            prompt = node.data.get("prompt") or "Offer to continue over video."
            return f"{base}\n\n[Now: {prompt}]".strip()
        return None
